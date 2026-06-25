import { restoreTerminalState } from "../../packages/terminal-core/src/restore.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope-config.js";
import { loadManifestModelCatalog } from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent, type ModelRef } from "../agents/model-selection.js";
import {
  createModelVisibilityPolicy,
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
} from "../agents/model-visibility-policy.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildAgentMainSessionKey, normalizeMainKey } from "../routing/session-key.js";
import { launchTuiCli } from "../tui/tui-launch.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";
import { ensureAgentAssistedGatewayRuntime } from "./setup.assisted-gateway.js";
import type { GatewayWizardSettings } from "./setup.types.js";

const AGENT_HARNESS_READINESS_TIMEOUT_MS = 10_000;

export function resolveAgentAssistedSetupMessage(): string {
  return t("wizard.setup.agentAssistedMessage");
}

export function resolveAgentAssistedSetupInstructions(): string {
  return t("wizard.setup.agentAssistedInstructions");
}

export function hasExplicitFullWizardIntent(opts: OnboardOptions): boolean {
  return (
    opts.mode !== undefined ||
    opts.reset === true ||
    opts.authChoice === "skip" ||
    opts.gatewayPort !== undefined ||
    opts.gatewayBind !== undefined ||
    opts.gatewayAuth !== undefined ||
    opts.gatewayToken !== undefined ||
    opts.gatewayTokenRefEnv !== undefined ||
    opts.gatewayPassword !== undefined ||
    opts.remoteUrl !== undefined ||
    opts.remoteToken !== undefined ||
    opts.tailscale !== undefined ||
    opts.tailscaleResetOnExit === true ||
    opts.installDaemon !== undefined ||
    opts.daemonRuntime !== undefined ||
    opts.suppressGatewayTokenOutput === true
  );
}

async function hasRunnableCliBackend(params: {
  config: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  modelRef: ModelRef;
}): Promise<boolean | undefined> {
  const { config, agentId, agentDir, workspaceDir, modelRef } = params;
  const [{ resolveCliRuntimeExecutionProvider }, { isCliProvider }] = await Promise.all([
    import("../agents/model-runtime-aliases.js"),
    import("../agents/model-selection.js"),
  ]);
  const cliExecutionProvider =
    resolveCliRuntimeExecutionProvider({
      provider: modelRef.provider,
      cfg: config,
      agentId,
      modelId: modelRef.model,
    }) ?? (isCliProvider(modelRef.provider, config) ? modelRef.provider : undefined);
  if (!cliExecutionProvider) {
    return undefined;
  }
  const [{ resolveCliBackendConfig }, { resolveExecutablePath }] = await Promise.all([
    import("../agents/cli-backends.js"),
    import("../infra/executable-path.js"),
  ]);
  const backend = resolveCliBackendConfig(cliExecutionProvider, config, { agentId });
  if (
    !backend ||
    !resolveExecutablePath(backend.config.command, {
      cwd: workspaceDir,
      env: { ...process.env, ...backend.config.env },
    })
  ) {
    return false;
  }
  const { hasAuthForModelProvider } = await import("../agents/model-provider-auth.js");
  return await hasAuthForModelProvider({
    provider: cliExecutionProvider,
    cfg: config,
    agentId,
    agentDir,
    workspaceDir,
  });
}

async function hasRunnableModelCandidate(params: {
  config: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  modelRef: ModelRef;
}): Promise<boolean> {
  const { config, agentId, agentDir, workspaceDir, modelRef } = params;
  const cliReadiness = await hasRunnableCliBackend(params);
  if (cliReadiness !== undefined) {
    return cliReadiness;
  }
  const { ensureSelectedAgentHarnessPlugin } = await import("../agents/harness/runtime-plugin.js");
  await ensureSelectedAgentHarnessPlugin({
    provider: modelRef.provider,
    modelId: modelRef.model,
    config,
    agentId,
    workspaceDir,
  });
  const { selectAgentHarness } = await import("../agents/harness/selection.js");
  const agentHarness = selectAgentHarness({
    provider: modelRef.provider,
    modelId: modelRef.model,
    config,
    agentId,
  });
  const pluginHarnessOwnsTransport = agentHarness.id !== "openclaw";
  const { resolveModelAsync } = await import("../agents/embedded-agent-runner/model.js");
  let { model } = await resolveModelAsync(modelRef.provider, modelRef.model, agentDir, config, {
    skipAgentDiscovery: true,
    allowBundledStaticCatalogFallback: pluginHarnessOwnsTransport,
    preferBundledStaticCatalogTransport: pluginHarnessOwnsTransport,
    workspaceDir,
  });
  if (!model && !pluginHarnessOwnsTransport) {
    const { ensureOpenClawModelsJson } = await import("../agents/models-config.js");
    await ensureOpenClawModelsJson(config, agentDir, { workspaceDir });
    ({ model } = await resolveModelAsync(modelRef.provider, modelRef.model, agentDir, config, {
      workspaceDir,
    }));
  }
  if (!model) {
    return false;
  }
  const { buildAgentRuntimeAuthPlan } = await import("../agents/runtime-plan/auth.js");
  const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
    provider: model.provider,
    config,
    workspaceDir,
    harnessId: agentHarness.id,
    harnessRuntime: agentHarness.id,
    allowHarnessAuthProfileForwarding: pluginHarnessOwnsTransport,
  });
  const { hasAuthForModelProvider } = await import("../agents/model-provider-auth.js");
  const hasProviderAuth = await hasAuthForModelProvider({
    provider: runtimeAuthPlan.harnessAuthProvider ?? runtimeAuthPlan.providerForAuth,
    modelApi: model.api,
    cfg: config,
    agentId,
    agentDir,
    workspaceDir,
  });
  if (!pluginHarnessOwnsTransport) {
    return hasProviderAuth;
  }
  if (!agentHarness.checkReadiness) {
    // Without a plugin-owned probe, core provider auth is the only readiness
    // evidence available for existing external harnesses.
    return hasProviderAuth;
  }
  const readinessAbort = new AbortController();
  const timeoutError = new Error("agent harness readiness check timed out");
  const timeout = setTimeout(
    () => readinessAbort.abort(timeoutError),
    AGENT_HARNESS_READINESS_TIMEOUT_MS,
  );
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(timeoutError);
    readinessAbort.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const readiness = await Promise.race([
      agentHarness.checkReadiness({
        config,
        agentId,
        agentDir,
        workspaceDir,
        provider: model.provider,
        modelId: model.id,
        modelApi: model.api,
        providerAuthAvailable: hasProviderAuth,
        signal: readinessAbort.signal,
      }),
      abortPromise,
    ]);
    return readiness.ready;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    if (onAbort) {
      readinessAbort.signal.removeEventListener("abort", onAbort);
    }
  }
}

export async function hasRunnableLocalAgent(
  config: OpenClawConfig,
  options: { agentId?: string } = {},
): Promise<boolean> {
  const agentId = options.agentId ?? resolveDefaultAgentId(config);
  const agentDir = resolveAgentDir(config, agentId);
  const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
  const { ensureRuntimePluginsLoaded } = await import("../agents/runtime-plugins.js");
  ensureRuntimePluginsLoaded({ config, workspaceDir });
  const configuredDefaultRef = resolveDefaultModelForAgent({ cfg: config, agentId });
  const hasAllowlist = Object.keys(config.agents?.defaults?.models ?? {}).length > 0;
  const modelRef = hasAllowlist
    ? createModelVisibilityPolicy({
        cfg: config,
        catalog: loadManifestModelCatalog({ config, workspaceDir }),
        defaultProvider: configuredDefaultRef.provider,
        defaultModel: configuredDefaultRef.model,
        agentId,
        ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
      }).resolveSelection(configuredDefaultRef)
    : configuredDefaultRef;
  if (!modelRef) {
    return false;
  }
  const { resolveAgentModelFallbacksOverride } = await import("../agents/agent-scope.js");
  const { resolveModelCandidateChain } = await import("../agents/model-fallback.js");
  const fallbacksOverride = resolveAgentModelFallbacksOverride(config, agentId);
  const candidates = resolveModelCandidateChain({
    cfg: config,
    provider: modelRef.provider,
    model: modelRef.model,
    ...(fallbacksOverride !== undefined ? { fallbacksOverride } : {}),
  });
  for (const candidate of candidates) {
    try {
      if (
        await hasRunnableModelCandidate({
          config,
          agentId,
          agentDir,
          workspaceDir,
          modelRef: candidate,
        })
      ) {
        return true;
      }
    } catch {
      // A broken primary must not hide a configured runnable fallback.
    }
  }
  return false;
}

export async function finishAgentAssistedSetup(params: {
  config: OpenClawConfig;
  settings: GatewayWizardSettings;
  opts: OnboardOptions;
  prompter: WizardPrompter;
}): Promise<void> {
  if (params.opts.skipUi) {
    await params.prompter.outro(t("wizard.setup.agentAssistedSkipped"));
    return;
  }

  const gatewayRuntime = await ensureAgentAssistedGatewayRuntime({
    config: params.config,
    settings: params.settings,
    prompter: params.prompter,
  });
  try {
    await params.prompter.outro(t("wizard.setup.agentAssistedOpening"));
    restoreTerminalState("pre-agent-assisted setup", { resumeStdinIfPaused: true });
    const session = buildAgentMainSessionKey({
      agentId: params.opts.agentId ?? resolveDefaultAgentId(params.config),
      mainKey: normalizeMainKey(params.config.session?.mainKey),
    });
    try {
      await launchTuiCli(
        {
          local: true,
          deliver: false,
          message: resolveAgentAssistedSetupMessage(),
          session,
        },
        {
          extraSystemPrompt: resolveAgentAssistedSetupInstructions(),
        },
      );
    } finally {
      restoreTerminalState("post-agent-assisted setup", { resumeStdinIfPaused: true });
    }
  } finally {
    // Temporary container runtimes must not outlive the assisted TUI.
    await gatewayRuntime.stop();
  }
}
