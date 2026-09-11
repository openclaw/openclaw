import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import {
  type AgentRunResultView,
  extractAgentRunTerminalError,
  extractAgentRunText,
} from "../agents/agent-run-result.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store-runtime.js";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { describeFailoverError } from "../agents/failover-error.js";
import type { AgentHarnessPluginSelection } from "../agents/harness/runtime-plugin-load-plan.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { buildAgentRuntimeAuthPlan } from "../agents/runtime-plan/auth.js";
import { loadAgentRuntimePluginRegistryHandle } from "../agents/runtime-plugins.js";
import { SessionManager } from "../agents/sessions/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { formatErrorMessage } from "../infra/errors.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-record-reader.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { getPluginRegistryForContext } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  projectInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig,
  sameDefaultInferenceRoute,
  type SystemAgentConfigSnapshot,
  type SystemAgentConfiguredRoute,
} from "./inference-route.js";
import {
  type ActivateSetupInferenceDeps,
  type BoundVerifySetupInferenceResult,
  type CompleteSetupInferenceResult,
  invalidSetupConfigError,
  mapFailoverReasonToSetupStatus,
  parseInferenceRef,
  redactSetupInferenceError,
  resolveSetupInferenceWinnerError,
  resolveToolFreeCliSetupError,
  SETUP_INFERENCE_TEST_PROMPT,
  SETUP_INFERENCE_TEST_TIMEOUT_MS,
  SetupInferenceCancelledError,
  type SetupInferenceFailureStatus,
  SetupInferenceOwnerDriftError,
  setupInferenceLog,
  type VerifySetupInferenceResult,
} from "./setup-inference-core.js";
import {
  captureSystemAgentOwnerPluginArtifacts,
  createSystemAgentVerifiedInferenceBinding,
  hasCurrentSystemAgentOwnerPluginArtifacts,
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentOwnerPluginArtifactSnapshot,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

const SETUP_INFERENCE_TEST_MAX_TOKENS = 256;

type SetupTurnFailure = { ok: false; status: SetupInferenceFailureStatus; error: string };

type SetupTurnSuccess = {
  ok: true;
  latencyMs: number;
  text: string;
  auth: AgentExecutionAuthBinding;
};

/** A pinned profile must exist and belong to the route before any request leaves the host. */
function resolveConfiguredProfileError(
  route: SystemAgentConfiguredRoute,
  workspaceDir: string,
  deps: ActivateSetupInferenceDeps,
): string | undefined {
  const profileId = route.authProfileId?.trim();
  if (!profileId) {
    return undefined;
  }
  const loadStore = deps.loadAuthProfileStoreForRuntime ?? loadAuthProfileStoreForRuntime;
  const store = loadStore(route.agentDir, {
    readOnly: true,
    allowKeychainPrompt: false,
    config: route.runConfig,
    externalCliProviderIds: [route.provider],
  });
  const credential = store.profiles[profileId];
  if (!credential) {
    return `No credentials found for the configured setup profile "${profileId}".`;
  }
  if (route.runner === "embedded") {
    const authPlan = buildAgentRuntimeAuthPlan({
      provider: route.provider,
      authProfileProvider: credential.provider,
      authProfileMode: credential.type,
      sessionAuthProfileId: profileId,
      config: route.runConfig,
      workspaceDir,
      harnessId: route.agentHarnessRuntimeOverride,
      harnessRuntime: route.agentHarnessRuntimeOverride,
      allowHarnessAuthProfileForwarding: true,
    });
    if (authPlan.forwardedAuthProfileId === profileId) {
      return undefined;
    }
  } else {
    const aliasContext = { config: route.runConfig, workspaceDir };
    try {
      if (
        resolveProviderIdForAuth(route.provider, aliasContext) ===
        resolveProviderIdForAuth(credential.provider, { ...aliasContext, storedCredential: true })
      ) {
        return undefined;
      }
    } catch {
      return `Could not verify that configured setup profile "${profileId}" belongs to the selected ${route.provider} inference route.`;
    }
  }
  return `Configured setup profile "${profileId}" belongs to ${credential.provider}, not the selected ${route.provider} inference route.`;
}

/**
 * Runs one bounded, tool-free turn through the exact configured route. The turn is evidence,
 * never a mutation: auth state stays read-only and the prepared runtime stays isolated so a
 * staged config can be tested before it is written.
 */
export async function runSetupInferenceTurn(params: {
  route: SystemAgentConfiguredRoute;
  prompt?: string;
  deps: ActivateSetupInferenceDeps;
  requireExecutionOwner: boolean;
  signal?: AbortSignal;
  runtime?: RuntimeEnv;
}): Promise<SetupTurnSuccess | SetupTurnFailure> {
  const { route, deps } = params;
  // Probe ids stay under OpenAI's 64-char session cap and match the command-lane log filters.
  const runId = `probe-setup-inference-${randomUUID()}`;
  const sessionKey = `agent:${route.agentId}:setup-inference:incognito-${runId}`;
  const timeoutMs = deps.timeoutMs ?? SETUP_INFERENCE_TEST_TIMEOUT_MS;
  const started = Date.now();
  // A scratch workspace keeps the probe from reading the real workspace's bootstrap files.
  const workspaceDir = await (
    deps.createTempDir ?? (() => fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-inference-")))
  )();
  const failed = (status: SetupInferenceFailureStatus, error: string): SetupTurnFailure => {
    setupInferenceLog.warn("Inference setup probe failed.", {
      event: "setup_inference_probe_failed",
      provider: route.provider,
      model: route.model,
      runner: route.runner,
      runId,
      phase: "response",
      status,
      timeoutMs,
      durationMs: Date.now() - started,
    });
    return {
      ok: false,
      status,
      error:
        status === "timeout"
          ? "The setup response check timed out. Retry setup, or choose another model or runtime. No default model was changed."
          : error,
    };
  };
  const preparedRunAdmission = prepareSystemAgentRunAdmission(
    route.runConfig,
    runId,
    route.agentId,
    "system-agent.setup-inference",
  );
  let successfulAuth: AgentExecutionAuthBinding | undefined;
  const shared = {
    preparedRunAdmission,
    sessionId: runId,
    sessionKey,
    sessionManager: SessionManager.inMemory(workspaceDir),
    agentId: route.agentId,
    trigger: "manual" as const,
    sessionFile: `in-memory:${runId}`,
    workspaceDir,
    agentDir: route.agentDir,
    config: route.runConfig,
    prompt: params.prompt ?? SETUP_INFERENCE_TEST_PROMPT,
    provider: route.provider,
    model: route.model,
    timeoutMs,
    runId,
    messageChannel: "openclaw",
    messageProvider: "openclaw",
    disableTools: true,
    onSuccessfulAuthBinding: (binding: AgentExecutionAuthBinding) => {
      successfulAuth = binding;
    },
    ...(params.signal ? { abortSignal: params.signal } : {}),
  };
  try {
    if (params.signal?.aborted) {
      throw new SetupInferenceCancelledError();
    }
    const cliError = await resolveToolFreeCliSetupError(route);
    if (cliError) {
      return failed("unavailable", cliError);
    }
    const profileError = resolveConfiguredProfileError(route, workspaceDir, deps);
    if (profileError) {
      return failed("auth", profileError);
    }
    let result: AgentRunResultView;
    if (route.runner === "cli") {
      const runCli = deps.runCliAgent ?? (await import("../agents/cli-runner.js")).runCliAgent;
      result = await runCli({
        ...shared,
        ...(route.authProfileId ? { authProfileId: route.authProfileId } : {}),
        executionMode: "side-question",
        cleanupCliLiveSessionOnRunEnd: true,
      });
    } else {
      const runEmbedded =
        deps.runEmbeddedAgent ?? (await import("../agents/embedded-agent.js")).runEmbeddedAgent;
      const harness = route.agentHarnessRuntimeOverride;
      result = await runEmbedded({
        ...shared,
        // The probe owns its transcript; session admission must not create durable agent state.
        sessionPersistence: "detached",
        ...(route.authProfileId
          ? { authProfileId: route.authProfileId, authProfileIdSource: "user" as const }
          : {}),
        authProfileStateMode: "read-only",
        allowAuthProfileFallback: false,
        preparedModelRuntimeMode: "isolated-read-only",
        ...(harness === "codex" ? { cleanupBundleMcpOnRunEnd: true } : {}),
        ...(harness ? { agentHarnessRuntimeOverride: harness } : {}),
        lane: `session:probe-setup-inference:${route.provider}`,
        thinkLevel: "off",
        reasoningLevel: "off",
        verboseLevel: "off",
        disableTrajectory: true,
        // The "reply OK" probe stays bounded; custom completions keep the model's own budget.
        ...(params.prompt === undefined && (!harness || harness === "openclaw")
          ? { streamParams: { maxTokens: SETUP_INFERENCE_TEST_MAX_TOKENS } }
          : {}),
        modelRun: true,
      });
    }
    if (params.signal?.aborted) {
      throw new SetupInferenceCancelledError();
    }
    const terminalError = extractAgentRunTerminalError(result);
    if (terminalError) {
      const described = describeFailoverError(new Error(terminalError));
      return failed(mapFailoverReasonToSetupStatus(described.reason), described.message);
    }
    const text = extractAgentRunText(result)?.trim();
    if (!text) {
      return failed(
        "format",
        "The model started but did not send a reply. Try again or pick another option.",
      );
    }
    const winnerError = await resolveSetupInferenceWinnerError(route, result);
    if (winnerError) {
      return failed("unknown", winnerError);
    }
    if (route.authProfileId && successfulAuth?.authProfileId !== route.authProfileId) {
      return failed(
        "auth",
        `The inference run used profile "${successfulAuth?.authProfileId ?? "unknown"}" instead of the configured profile "${route.authProfileId}".`,
      );
    }
    if (params.requireExecutionOwner && !successfulAuth) {
      return failed(
        "unknown",
        "Inference succeeded, but its runtime did not report an owner that OpenClaw can safely reuse.",
      );
    }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      text,
      auth: successfulAuth ?? (route.authProfileId ? { authProfileId: route.authProfileId } : {}),
    };
  } catch (error) {
    const described = describeFailoverError(error);
    return failed(mapFailoverReasonToSetupStatus(described.reason), described.message);
  } finally {
    preparedRunAdmission.close();
    try {
      await (deps.removeTempDir ?? ((dir: string) => fs.rm(dir, { recursive: true, force: true })))(
        workspaceDir,
      );
    } catch (error) {
      params.runtime?.error?.(
        `Could not remove temporary AI setup files: ${await redactSetupInferenceError(error)}`,
      );
      setupInferenceLog.warn("Could not remove the temporary inference test directory.");
    }
  }
}

type RevalidationDeps = SystemAgentVerifiedInferenceDeps & {
  createSystemAgentVerifiedInferenceBinding?: typeof createSystemAgentVerifiedInferenceBinding;
  resolvePluginMetadataSnapshot?: typeof resolvePluginMetadataSnapshot;
};

/** Setup owns fresh package facts without replacing the Gateway's startup generation. */
export function loadSetupInferencePluginGeneration(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  selection: AgentHarnessPluginSelection;
  pendingPluginInstalls?: Record<string, PluginInstallRecord>;
  resolvePluginMetadataSnapshot?: typeof resolvePluginMetadataSnapshot;
}) {
  // Revalidation must select the probed artifacts: switching a built Gateway
  // owner to source files would report drift even when neither tree changed.
  const preferBuiltPluginArtifacts = getPluginRuntimeLoadContext(
    getPluginRegistryForContext() ?? undefined,
  )?.preferBuiltPluginArtifacts;
  // The install lease may have cached absence before writing the package.
  // This post-mutation owner must capture new facts without retiring that lease's cache.
  return withPluginCache(createPluginCache(), () => {
    const index = params.pendingPluginInstalls
      ? loadInstalledPluginIndex({
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: process.env,
          installRecords: {
            ...loadInstalledPluginIndexInstallRecordsSync(),
            ...params.pendingPluginInstalls,
          },
        })
      : undefined;
    const generation = {
      config: params.config,
      metadataSnapshot: (params.resolvePluginMetadataSnapshot ?? resolvePluginMetadataSnapshot)({
        config: params.config,
        env: process.env,
        workspaceDir: params.workspaceDir,
        allowCurrent: false,
        ...(index ? { index } : {}),
      }),
    };
    const pluginRegistry = withPluginRuntimeGenerationScope(generation, () =>
      loadAgentRuntimePluginRegistryHandle({
        config: params.config,
        workspaceDir: params.workspaceDir,
        metadataSnapshot: generation.metadataSnapshot,
        preferBuiltPluginArtifacts,
        selections: [params.selection],
      }),
    );
    if (!pluginRegistry) {
      throw new Error(`Could not load the ${params.selection.runtime} runtime plugin.`);
    }
    return { ...generation, pluginRegistry };
  });
}

async function revalidateSetupInferenceOwner(params: {
  route: SystemAgentConfiguredRoute;
  auth: AgentExecutionAuthBinding;
  ownerPluginIds?: readonly string[];
  deps: RevalidationDeps;
}): Promise<SystemAgentVerifiedInferenceBinding> {
  const configuredHarnessId =
    params.route.runner === "embedded"
      ? params.route.agentHarnessRuntimeOverride?.trim()
      : undefined;
  const successfulHarnessId =
    params.auth.agentHarnessId?.trim() ||
    (configuredHarnessId && configuredHarnessId !== "auto" ? configuredHarnessId : undefined);
  const createBinding = () =>
    (
      params.deps.createSystemAgentVerifiedInferenceBinding ??
      createSystemAgentVerifiedInferenceBinding
    )({
      configuredRoute: params.route,
      executionRoute: params.route,
      auth: params.auth,
      deps: params.deps,
    });
  if (
    params.ownerPluginIds?.length ||
    (params.route.runner === "embedded" &&
      successfulHarnessId &&
      successfulHarnessId !== "openclaw")
  ) {
    const workspaceDir = resolveAgentWorkspaceDir(
      params.route.runConfig,
      params.route.agentId,
      process.env,
    );
    const generation = loadSetupInferencePluginGeneration({
      config: params.route.runConfig,
      workspaceDir,
      selection: {
        provider: parseInferenceRef(params.route.modelLabel).provider,
        modelId: params.route.model,
        ...(params.route.runner === "cli"
          ? { runtime: params.route.provider }
          : successfulHarnessId
            ? { runtime: successfulHarnessId }
            : {}),
        agentId: params.route.agentId,
      },
      resolvePluginMetadataSnapshot: params.deps.resolvePluginMetadataSnapshot,
    });
    return await withPluginRuntimeGenerationScope(generation, createBinding);
  }
  return await createBinding();
}

function hasSameOwnerPluginArtifacts(
  binding: SystemAgentVerifiedInferenceBinding,
  snapshot: SystemAgentOwnerPluginArtifactSnapshot,
): boolean {
  return (
    isDeepStrictEqual(binding.ownerPluginIds, snapshot.ownerPluginIds) &&
    isDeepStrictEqual(binding.ownerPluginArtifacts, snapshot.ownerPluginArtifacts)
  );
}

/**
 * Revalidate the successful probe's owner against current config. Any drift
 * throws SetupInferenceOwnerDriftError, which activation returns as an auth
 * failure result — a throw that escapes here would crash the onboarding ladder.
 */
export async function revalidateStableSetupInferenceOwner(params: {
  route: SystemAgentConfiguredRoute;
  auth: AgentExecutionAuthBinding;
  stagedOwnerPluginArtifacts: SystemAgentOwnerPluginArtifactSnapshot | undefined;
  deps: ActivateSetupInferenceDeps;
}): Promise<SystemAgentVerifiedInferenceBinding> {
  let binding: SystemAgentVerifiedInferenceBinding;
  try {
    binding = await revalidateSetupInferenceOwner({
      route: params.route,
      auth: params.auth,
      ownerPluginIds: params.stagedOwnerPluginArtifacts?.ownerPluginIds,
      deps: params.deps,
    });
  } catch (error) {
    throw new SetupInferenceOwnerDriftError(
      `The verified inference owner changed before activation completed. Retry the inference check. (${formatErrorMessage(error)})`,
      { cause: error },
    );
  }
  if (
    !params.stagedOwnerPluginArtifacts ||
    !hasSameOwnerPluginArtifacts(binding, params.stagedOwnerPluginArtifacts)
  ) {
    throw new SetupInferenceOwnerDriftError(
      "The verified inference owner changed before activation completed. Retry the inference check. (The owner plugin runtime changed during its live test.)",
    );
  }
  return binding;
}

type SetupInferenceRequestParams = {
  agentId?: string;
  runtime: RuntimeEnv;
  timeoutMs?: number;
  deps?: ActivateSetupInferenceDeps;
};

type VerifySetupInferenceParams = SetupInferenceRequestParams & { kind?: "existing-model" };

/** Live-test the configured default model without changing config or auth state. */
export function verifySetupInference(
  params: VerifySetupInferenceParams & { bindSession: true },
): Promise<BoundVerifySetupInferenceResult>;

export function verifySetupInference(
  params: VerifySetupInferenceParams & { bindSession?: false },
): Promise<VerifySetupInferenceResult>;

export async function verifySetupInference(
  params: VerifySetupInferenceParams & { bindSession?: boolean },
): Promise<VerifySetupInferenceResult | BoundVerifySetupInferenceResult> {
  const readSnapshot =
    params.deps?.readConfigFileSnapshot ??
    (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (!snapshot.exists) {
    return {
      ok: false,
      status: "unavailable",
      error: "No OpenClaw config exists. Run `openclaw onboard` first.",
    };
  }
  if (!snapshot.valid) {
    return { ok: false, status: "format", error: invalidSetupConfigError(snapshot) };
  }
  const cfg: OpenClawConfig = snapshot.runtimeConfig ?? snapshot.config;
  const baselineRoute = await projectInferenceRoute(cfg, params.agentId);
  let verifiedBinding: SystemAgentVerifiedInferenceBinding | undefined;
  const verification = await verifySetupInferenceConfig({
    config: cfg,
    configSnapshot: snapshot,
    runtime: params.runtime,
    requireExecutionOwner: params.bindSession === true,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.deps ? { deps: params.deps } : {}),
    onVerifiedExecution: params.bindSession
      ? (binding) => {
          verifiedBinding = binding;
        }
      : undefined,
  });
  if (!verification.ok) {
    return verification;
  }
  const latestSnapshot = await readSnapshot().catch(() => null);
  const latestConfig =
    latestSnapshot?.exists && latestSnapshot.valid
      ? (latestSnapshot.runtimeConfig ?? latestSnapshot.config)
      : undefined;
  const latestRoute = latestConfig
    ? await projectInferenceRoute(latestConfig, params.agentId)
    : undefined;
  if (!latestRoute || !sameDefaultInferenceRoute(baselineRoute, latestRoute)) {
    return {
      ok: false,
      status: "unknown",
      error:
        "The inference route changed during its live test. Review current model/auth/runtime settings and retry.",
    };
  }
  if (!params.bindSession) {
    return verification;
  }
  if (!verifiedBinding) {
    return {
      ok: false,
      status: "unknown",
      error:
        "The successful inference run did not report an exact execution binding. Retry setup before starting OpenClaw.",
    };
  }
  return { ...verification, binding: verifiedBinding };
}

type BoundSetupInferenceVerifier = (params: {
  runtime: RuntimeEnv;
  bindSession: true;
  agentId?: string;
  deps?: ActivateSetupInferenceDeps;
}) => Promise<BoundVerifySetupInferenceResult>;

export type ResolvePersistentApplyInferenceDeps = SystemAgentVerifiedInferenceDeps & {
  resolveVerifiedInferenceRoute?: typeof resolveSystemAgentVerifiedInferenceRoute;
  hasCurrentOwnerPluginArtifacts?: typeof hasCurrentSystemAgentOwnerPluginArtifacts;
  verifyBoundInference?: BoundSetupInferenceVerifier;
};

function executionRouteIdentity(route: SystemAgentConfiguredRoute): unknown {
  const { runConfig: _runConfig, sourceConfig: _sourceConfig, ...identity } = route;
  return identity;
}

/**
 * Strict credentials need only the static owner check. Opaque runtimes can
 * prove liveness only by completing another exact turn at the side-effect
 * boundary; the result must still be the original frozen route.
 */
export async function resolvePersistentApplyInference(params: {
  binding: SystemAgentVerifiedInferenceBinding;
  runtime: RuntimeEnv;
  deps?: ResolvePersistentApplyInferenceDeps;
}): Promise<SystemAgentConfiguredRoute | null> {
  const deps = params.deps ?? {};
  const resolveVerified =
    deps.resolveVerifiedInferenceRoute ?? resolveSystemAgentVerifiedInferenceRoute;
  const initialRoute = await resolveVerified(params.binding, deps);
  if (!initialRoute) {
    return null;
  }
  const hasCurrentOwnerPluginArtifacts =
    deps.hasCurrentOwnerPluginArtifacts ?? hasCurrentSystemAgentOwnerPluginArtifacts;
  if (!(await hasCurrentOwnerPluginArtifacts(params.binding, deps))) {
    return null;
  }
  if (params.binding.auth.proofKind !== "runtime-owner") {
    return initialRoute;
  }

  const verifyBound = deps.verifyBoundInference ?? verifySetupInference;
  const live = await verifyBound({
    runtime: params.runtime,
    bindSession: true,
    agentId: params.binding.execution.agentId,
    deps,
  });
  if (
    !live.ok ||
    !isDeepStrictEqual(live.binding.configuredRoute, params.binding.configuredRoute) ||
    !isDeepStrictEqual(
      executionRouteIdentity(live.binding.execution),
      executionRouteIdentity(params.binding.execution),
    ) ||
    !isDeepStrictEqual(live.binding.executionFingerprint, params.binding.executionFingerprint) ||
    !isDeepStrictEqual(live.binding.ownerPluginIds, params.binding.ownerPluginIds) ||
    !isDeepStrictEqual(live.binding.ownerPluginArtifacts, params.binding.ownerPluginArtifacts) ||
    !isDeepStrictEqual(live.binding.auth, params.binding.auth)
  ) {
    return null;
  }
  // The live probe is not a lock. Recheck the authored route after it returns,
  // then keep using the original frozen execution snapshot.
  const finalRoute = await resolveVerified(params.binding, deps);
  if (!finalRoute || !(await hasCurrentOwnerPluginArtifacts(params.binding, deps))) {
    return null;
  }
  return finalRoute;
}

/** Live-test a candidate config through the same route used after activation. */
export async function verifySetupInferenceConfig(
  params: SetupInferenceRequestParams & {
    config: OpenClawConfig;
    configSnapshot?: SystemAgentConfigSnapshot;
    /** Credential directory selected by the onboarding import owner. */
    agentDir?: string;
    onVerifiedExecution?: (binding: SystemAgentVerifiedInferenceBinding) => void;
    requireExecutionOwner?: boolean;
  },
): Promise<VerifySetupInferenceResult> {
  const deps: ActivateSetupInferenceDeps = {
    ...params.deps,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
  const configuredRoute = await resolveSystemAgentConfiguredRouteFromConfig(
    params.config,
    params.agentId,
    { loadAuthProfileStoreForRuntime: deps.loadAuthProfileStoreForRuntime },
    params.configSnapshot,
  );
  if (!configuredRoute) {
    return {
      ok: false,
      status: "unavailable",
      error: "No agent model is configured. Run `openclaw onboard` first.",
    };
  }
  const route = params.agentDir
    ? { ...configuredRoute, agentDir: params.agentDir }
    : configuredRoute;
  const requireExecutionOwner =
    params.requireExecutionOwner === true || params.onVerifiedExecution !== undefined;
  let stagedOwnerPluginArtifacts: SystemAgentOwnerPluginArtifactSnapshot | undefined;
  if (requireExecutionOwner) {
    try {
      stagedOwnerPluginArtifacts = (
        deps.captureSystemAgentOwnerPluginArtifacts ?? captureSystemAgentOwnerPluginArtifacts
      )({ config: route.sourceConfig, executionRoute: route, deps });
    } catch (error) {
      return {
        ok: false,
        status: "unavailable",
        error: `Could not bind the configured inference plugin runtime. Refresh or reinstall the plugin and retry. (${await redactSetupInferenceError(error)})`,
      };
    }
  }
  const turn = await runSetupInferenceTurn({
    route,
    deps,
    requireExecutionOwner,
    runtime: params.runtime,
  });
  if (!turn.ok) {
    return { ...turn, error: await redactSetupInferenceError(turn.error) };
  }
  if (requireExecutionOwner) {
    try {
      const binding = await revalidateStableSetupInferenceOwner({
        route,
        auth: turn.auth,
        stagedOwnerPluginArtifacts,
        deps,
      });
      params.onVerifiedExecution?.(binding);
    } catch (error) {
      return { ok: false, status: "auth", error: await redactSetupInferenceError(error) };
    }
  }
  return { ok: true, modelRef: route.modelLabel, latencyMs: turn.latencyMs };
}

/** Run one tool-free completion through the configured setup inference route. */
export async function completeSetupInference(
  params: SetupInferenceRequestParams & { prompt: string },
): Promise<CompleteSetupInferenceResult> {
  const readSnapshot =
    params.deps?.readConfigFileSnapshot ??
    (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (!snapshot.exists) {
    return { ok: false, status: "unavailable", error: "No OpenClaw config exists." };
  }
  if (!snapshot.valid) {
    return { ok: false, status: "format", error: invalidSetupConfigError(snapshot) };
  }
  return await completeSetupInferenceConfig({
    ...params,
    config: snapshot.runtimeConfig ?? snapshot.config,
    configSnapshot: snapshot,
  });
}

/** Config-injected variant used by setup clients and live provider tests. */
export async function completeSetupInferenceConfig(
  params: SetupInferenceRequestParams & {
    config: OpenClawConfig;
    configSnapshot?: SystemAgentConfigSnapshot;
    prompt: string;
  },
): Promise<CompleteSetupInferenceResult> {
  const deps: ActivateSetupInferenceDeps = {
    ...params.deps,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
  const route = await resolveSystemAgentConfiguredRouteFromConfig(
    params.config,
    params.agentId,
    { loadAuthProfileStoreForRuntime: deps.loadAuthProfileStoreForRuntime },
    params.configSnapshot,
  );
  if (!route) {
    return { ok: false, status: "unavailable", error: "No agent model is configured." };
  }
  const turn = await runSetupInferenceTurn({
    route,
    prompt: params.prompt,
    deps,
    requireExecutionOwner: false,
    runtime: params.runtime,
  });
  if (!turn.ok) {
    return { ...turn, error: await redactSetupInferenceError(turn.error) };
  }
  return { ok: true, modelRef: route.modelLabel, latencyMs: turn.latencyMs, text: turn.text };
}
