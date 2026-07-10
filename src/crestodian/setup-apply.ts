// Applies Crestodian's conversational setup: config, workspace files, gateway.
import { resolveGatewayPort } from "../config/config.js";
import { ConfigMutationConflictError } from "../config/mutate.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  projectDefaultInferenceRoute,
  sameDefaultInferenceRoute,
  type DefaultInferenceRouteProjection,
} from "./inference-route.js";

/**
 * The whole first-run setup as one approved operation: the user says "yes" in
 * the conversation and this applies model + workspace + quickstart gateway
 * defaults, seeds workspace bootstrap files, and (on the CLI surface) installs
 * and starts the gateway service. No interactive prompts may occur here —
 * everything uses quickstart defaults, so the conversation stays the only UI.
 */
export type CrestodianSetupApplyParams = {
  workspace: string;
  model?: string;
  /** Exact default-agent route whose inference passed the setup gate. */
  expectedInferenceRoute?: DefaultInferenceRouteProjection;
  surface: "cli" | "gateway";
  runtime: RuntimeEnv;
};

export type CrestodianSetupApplyResult = {
  configPath: string;
  lines: string[];
};

const CRESTODIAN_AGENT_ID = normalizeAgentId("crestodian");

function requireValidSetupSnapshot(snapshot: ConfigFileSnapshot): {
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
} {
  if (!snapshot.exists || !snapshot.valid) {
    throw new Error(
      "OpenClaw's config is missing or invalid, so Crestodian cannot safely preserve the verified inference route and existing settings. Repair the config, then retry setup.",
    );
  }
  if (
    snapshot.runtimeConfig.agents?.list?.some(
      (entry) => normalizeAgentId(entry.id) === CRESTODIAN_AGENT_ID,
    )
  ) {
    throw new Error(
      'Agent id "crestodian" is reserved for the setup assistant. Rename that configured agent, then retry setup.',
    );
  }
  return {
    sourceConfig: snapshot.sourceConfig,
    runtimeConfig: snapshot.runtimeConfig,
  };
}

/** Prompter for quickstart-only flows: notes go to the log, prompts fail loud. */
export function createQuickstartNotePrompter(runtime: RuntimeEnv): WizardPrompter {
  const unexpected = (kind: string) => {
    throw new Error(`crestodian setup hit an interactive ${kind} prompt; quickstart must not ask`);
  };
  return {
    intro: async () => {},
    outro: async () => {},
    note: async (message, title) => {
      runtime.log(title ? `${title}: ${message}` : message);
    },
    select: async (params) => {
      // Quickstart paths never select interactively; honor defaults if a
      // pre-answered prompt sneaks through, otherwise fail loud.
      if (params.initialValue !== undefined) {
        return params.initialValue;
      }
      return unexpected("select");
    },
    multiselect: async () => unexpected("multiselect"),
    text: async () => unexpected("text"),
    confirm: async (params) => params.initialValue ?? true,
    progress: (label) => {
      runtime.log(label);
      return {
        update: (message) => runtime.log(message),
        stop: (message) => {
          if (message) {
            runtime.log(message);
          }
        },
      };
    },
  };
}

function applySecurityAcknowledgement(config: OpenClawConfig): OpenClawConfig {
  if (config.wizard?.securityAcknowledgedAt) {
    return config;
  }
  // Conversational consent: the onboarding welcome shows the security note and
  // the user approved the plan, which is the acknowledgement we persist.
  return {
    ...config,
    wizard: { ...config.wizard, securityAcknowledgedAt: new Date().toISOString() },
  };
}

type CrestodianModelSelectionParams = {
  config: OpenClawConfig;
  model: string;
  agentRuntimeId?: string;
  /** Pin the selected model to the exact credential that passed inference. */
  authProfileId?: string;
};

type CrestodianModelSelectionModules = {
  agentScope: typeof import("../agents/agent-scope.js");
  modelConfig: typeof import("../commands/models/shared.js");
  runtimePolicy: typeof import("../agents/model-runtime-policy.js");
};

function applyCrestodianModelSelectionWithModules(
  params: CrestodianModelSelectionParams,
  modules: CrestodianModelSelectionModules,
): OpenClawConfig {
  const { agentScope, modelConfig, runtimePolicy } = modules;
  const nextConfig = structuredClone(params.config);
  const agentId = agentScope.resolveDefaultAgentId(nextConfig);
  const writesAgent = Boolean(agentScope.resolveAgentExplicitModelPrimary(nextConfig, agentId));
  let models: Record<string, AgentModelEntryConfig>;
  if (writesAgent) {
    const agent = nextConfig.agents?.list?.find((entry) => normalizeAgentId(entry.id) === agentId);
    if (!agent) {
      throw new Error(`Could not resolve configured default agent "${agentId}".`);
    }
    models = { ...agent.models };
    agent.models = models;
  } else {
    nextConfig.agents ??= {};
    nextConfig.agents.defaults ??= {};
    models = { ...nextConfig.agents.defaults.models };
    nextConfig.agents.defaults.models = models;
  }
  const target = modelConfig.resolveModelTarget({ raw: params.model, cfg: nextConfig });
  const key = modelConfig.upsertCanonicalModelConfigEntry(models, target);
  if (params.agentRuntimeId) {
    models[key] = {
      ...models[key],
      agentRuntime: { id: params.agentRuntimeId },
    };
  } else {
    // Native provider selection must remove any stale harness pin that would
    // otherwise override the route just verified during inference setup.
    const entry = { ...models[key] };
    delete entry.agentRuntime;
    models[key] = entry;
  }
  const selectedModel = params.authProfileId ? `${key}@${params.authProfileId}` : key;
  agentScope.setAgentEffectiveModelPrimary(nextConfig, agentId, selectedModel);
  if (params.agentRuntimeId) {
    const effectiveRuntime = runtimePolicy.resolveModelRuntimePolicy({
      config: nextConfig,
      provider: target.provider,
      modelId: target.model,
      agentId,
    }).policy?.id;
    if (effectiveRuntime !== params.agentRuntimeId) {
      // An inherited primary can still have higher-priority per-agent model
      // metadata. Pin the selected runtime at that owner as well.
      const agent = nextConfig.agents?.list?.find(
        (entry) => normalizeAgentId(entry.id) === agentId,
      );
      if (!agent) {
        throw new Error(`Could not resolve configured default agent "${agentId}".`);
      }
      const agentModels = { ...agent.models };
      const agentKey = modelConfig.upsertCanonicalModelConfigEntry(agentModels, target);
      agentModels[agentKey] = {
        ...agentModels[agentKey],
        agentRuntime: { id: params.agentRuntimeId },
      };
      agent.models = agentModels;
    }
  } else {
    // Runtime resolution checks the default-agent map before defaults, then
    // falls back to defaults. Clear the other scope so neither can revive a
    // stale harness pin after native inference succeeded.
    const agent = nextConfig.agents?.list?.find((entry) => normalizeAgentId(entry.id) === agentId);
    const otherModels = writesAgent ? nextConfig.agents?.defaults?.models : agent?.models;
    if (otherModels) {
      const nextModels = { ...otherModels };
      const otherKey = modelConfig.upsertCanonicalModelConfigEntry(nextModels, target);
      const entry = { ...nextModels[otherKey] };
      delete entry.agentRuntime;
      nextModels[otherKey] = entry;
      if (writesAgent) {
        nextConfig.agents ??= {};
        nextConfig.agents.defaults ??= {};
        nextConfig.agents.defaults.models = nextModels;
      } else if (agent) {
        agent.models = nextModels;
      }
    }
  }
  return nextConfig;
}

export async function createCrestodianModelSelectionUpdater(
  params: Omit<CrestodianModelSelectionParams, "config">,
): Promise<(config: OpenClawConfig) => OpenClawConfig> {
  const [agentScope, modelConfig, runtimePolicy] = await Promise.all([
    import("../agents/agent-scope.js"),
    import("../commands/models/shared.js"),
    import("../agents/model-runtime-policy.js"),
  ]);
  const modules = { agentScope, modelConfig, runtimePolicy };
  return (config) => applyCrestodianModelSelectionWithModules({ ...params, config }, modules);
}

export async function applyCrestodianModelSelection(
  params: CrestodianModelSelectionParams,
): Promise<OpenClawConfig> {
  const update = await createCrestodianModelSelectionUpdater(params);
  return update(params.config);
}

export async function applyCrestodianSetup(
  params: CrestodianSetupApplyParams,
): Promise<CrestodianSetupApplyResult> {
  const { workspace, model, surface, runtime } = params;
  const [
    { readSetupConfigFileSnapshot, resolveQuickstartGatewayDefaults, writeWizardConfigFile },
    onboardHelpers,
    { applyLocalSetupWorkspaceConfig },
  ] = await Promise.all([
    import("../wizard/setup.shared.js"),
    import("../commands/onboard-helpers.js"),
    import("../commands/onboard-config.js"),
  ]);

  let snapshot = await readSetupConfigFileSnapshot();
  let snapshotConfig = requireValidSetupSnapshot(snapshot);
  const assertVerifiedRoute = async (runtimeConfig: OpenClawConfig) => {
    if (!params.expectedInferenceRoute) {
      return;
    }
    const currentRoute = await projectDefaultInferenceRoute(runtimeConfig);
    if (!sameDefaultInferenceRoute(currentRoute, params.expectedInferenceRoute)) {
      throw new Error(
        "The default-agent inference route changed before setup could start, so no workspace or Gateway settings were changed. Retry setup from the current Crestodian session.",
      );
    }
  };
  await assertVerifiedRoute(snapshotConfig.runtimeConfig);
  let baseConfig = snapshotConfig.sourceConfig;

  const prompter = createQuickstartNotePrompter(runtime);
  const { configureGatewayForSetup } = await import("../wizard/setup.gateway-config.js");
  const buildSetupCandidate = async (currentBaseConfig: OpenClawConfig) => {
    let candidate = applyLocalSetupWorkspaceConfig(currentBaseConfig, workspace);
    if (model) {
      candidate = await applyCrestodianModelSelection({
        config: candidate,
        model,
      });
    }
    candidate = applySecurityAcknowledgement(candidate);
    const gateway = await configureGatewayForSetup({
      flow: "quickstart",
      baseConfig: currentBaseConfig,
      nextConfig: candidate,
      localPort: resolveGatewayPort(currentBaseConfig),
      quickstartGateway: resolveQuickstartGatewayDefaults(currentBaseConfig),
      prompter,
      runtime,
    });
    return {
      nextConfig: onboardHelpers.applyWizardMetadata(gateway.nextConfig, {
        command: "onboard",
        mode: "local",
      }),
      settings: gateway.settings,
    };
  };
  let setupCandidate = await buildSetupCandidate(baseConfig);
  for (let attempt = 0; ; attempt += 1) {
    try {
      setupCandidate.nextConfig = await writeWizardConfigFile(setupCandidate.nextConfig, {
        allowConfigSizeDrop: false,
        ...(snapshot.hash ? { baseHash: snapshot.hash } : {}),
        migrationBaseConfig: baseConfig,
      });
      break;
    } catch (error) {
      if (!(error instanceof ConfigMutationConflictError) || !error.retryable || attempt >= 2) {
        throw error;
      }
      snapshot = await readSetupConfigFileSnapshot();
      snapshotConfig = requireValidSetupSnapshot(snapshot);
      await assertVerifiedRoute(snapshotConfig.runtimeConfig);
      baseConfig = snapshotConfig.sourceConfig;
      // Rebuild both config and runtime settings from the same fresh snapshot.
      // Otherwise a preserved concurrent Gateway edit could be installed or
      // probed with settings derived from the stale pre-conflict config.
      setupCandidate = await buildSetupCandidate(baseConfig);
    }
  }
  const { nextConfig, settings } = setupCandidate;

  await onboardHelpers.ensureWorkspaceAndSessions(workspace, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
    skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
  });

  // The user's explicit setup approval (with the security note shown up
  // front) is the consent for Crestodian's own agent loop to run local model
  // harnesses (Codex app-server needs exec). Scope the grant to the
  // crestodian agent only; regular agents keep the interactive approval flow.
  try {
    const { loadExecApprovals, saveExecApprovals } = await import("../infra/exec-approvals.js");
    const approvals = loadExecApprovals();
    const existing = approvals.agents?.crestodian;
    if (!existing) {
      saveExecApprovals({
        ...approvals,
        agents: {
          ...approvals.agents,
          crestodian: { security: "full", ask: "off" },
        },
      });
    }
  } catch (error) {
    runtime.log(
      `Could not record Crestodian exec approval (${error instanceof Error ? error.message : String(error)}); local model harnesses may ask again.`,
    );
  }

  const lines: string[] = [
    `Workspace: ${shortenHomePath(workspace)}`,
    model ? `Default model: ${model}` : undefined,
  ].filter((line): line is string => line !== undefined);

  if (surface === "cli") {
    // The gateway daemon runs outside this process; install/start it so
    // channels and apps have a live gateway. Inside the gateway process
    // (macOS app chat) the app owns the service lifecycle.
    const { ensureGatewayServiceForOnboarding } = await import("../wizard/setup.finalize.js");
    const { installDaemon } = await ensureGatewayServiceForOnboarding({
      flow: "quickstart",
      opts: {},
      nextConfig,
      settings,
      prompter,
      runtime,
      loadedAction: "restart",
    });
    if (installDaemon) {
      const probeLinks = onboardHelpers.resolveLocalControlUiProbeLinks({
        bind: settings.bind,
        port: settings.port,
        customBindHost: settings.customBindHost,
        basePath: undefined,
        tlsEnabled: nextConfig.gateway?.tls?.enabled === true,
      });
      const probe = await onboardHelpers.waitForGatewayReachable({
        url: probeLinks.wsUrl,
        token: settings.authMode === "token" ? settings.gatewayToken : undefined,
        deadlineMs: 15_000,
      });
      lines.push(
        probe.ok
          ? `Gateway: running at ${probeLinks.wsUrl}`
          : `Gateway: not reachable yet (${probe.detail ?? "still starting"}) — say \`gateway status\` to check`,
      );
    } else {
      lines.push(
        "Gateway: service install skipped — say `start gateway` when you want it running.",
      );
    }
  } else {
    lines.push("Gateway: running (managed by this app).");
  }

  return { configPath: snapshot.path, lines };
}
