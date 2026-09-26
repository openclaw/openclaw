import { randomUUID } from "node:crypto";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { extractAgentRunTerminalError, extractAgentRunText } from "../agents/agent-run-result.js";
import type { AgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.types.js";
import { createAgentToolExecutionBudget } from "../agents/agent-tool-source-execution-guard.js";
import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import { resolveExecToolConfig } from "../agents/lazy-exec-tool.js";
import { recordAgentCleanupFailure } from "../agents/run-cleanup-timeout.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../agents/tool-policy.js";
import { buildExecRunConfig } from "../commands/agent-exec-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import type { SystemAgentConfiguredRoute } from "../system-agent/inference-route.js";
import { sanitizeHostExecEnv, withHostExecInheritedEnvOmitted } from "./host-env-security.js";
import {
  installationTargetEnv,
  withInstallationTarget,
  LOCAL_INSTALLATION_TARGET_UNSUPPORTED,
} from "./installation-target-context.js";
import {
  readUpdateRepairMaintenanceRequest,
  updateRepairMaintenanceTool,
  type UpdateRepairMaintenanceRequest,
} from "./update-repair-maintenance.js";
import type { UpdateRepairTarget } from "./update-repair-protocol.js";
import { buildUpdateDoctorEnv } from "./update-runner-doctor.js";

const repairRuntime = {
  log: () => {},
  error: () => {},
  exit: (code: number): never => {
    throw new Error(`Repair agent exited (${code}).`);
  },
};

/** The orchestrator serializes this phase; restore every config-load env effect. */
export async function withUpdateRepairEnvironment<T>(
  target: UpdateRepairTarget,
  run: () => Promise<T>,
): Promise<T> {
  const [io, paths] = await Promise.all([import("../config/io.js"), import("../config/paths.js")]);
  const previousConfig = io.getRuntimeConfigSnapshot();
  const previousEnv = io.snapshotEnv(process.env);
  if (target.environment) {
    // Rehearsal may clear live selectors, but only its isolation paths can
    // override the host environment. Keep executable lookup and credentials host-owned.
    const environment: NodeJS.ProcessEnv = {};
    for (const key of Object.keys(process.env)) {
      if (target.environment[key] !== undefined) {
        environment[key] = process.env[key];
      }
    }
    for (const key of [
      "HOME",
      "USERPROFILE",
      "TMPDIR",
      "TMP",
      "TEMP",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "OPENCLAW_HOME",
      "OPENCLAW_AGENT_DIR",
      "PI_CODING_AGENT_DIR",
    ]) {
      environment[key] = target.environment[key];
    }
    const sanitized = sanitizeHostExecEnv({ baseEnv: environment });
    for (const key of Object.keys(process.env)) {
      if (sanitized[key] === undefined) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, sanitized);
  }
  Object.assign(
    process.env,
    installationTargetEnv({
      stateDir: target.stateDir,
      configPath: target.configPath,
      defaultWorkspaceDir: target.workspaceDir,
    }),
    buildUpdateDoctorEnv({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
      serviceRepairPolicy: "external",
      deferConfiguredPluginInstallRepair: Boolean(target.environment),
    }),
  );
  io.clearRuntimeConfigSnapshot();
  paths.pinRuntimePaths();
  try {
    return await run();
  } finally {
    io.restoreEnvChangesIfUnchanged({
      env: process.env,
      before: previousEnv,
      after: io.snapshotEnv(process.env),
    });
    if (previousConfig) {
      io.setRuntimeConfigSnapshot(previousConfig);
    } else {
      io.clearRuntimeConfigSnapshot();
    }
    paths.pinRuntimePaths();
  }
}

async function withRepairResources<T>(run: () => Promise<T>): Promise<T> {
  const resources = createOpenClawDatabaseMaintenanceScope();
  const [outcome] = await Promise.allSettled([Promise.resolve().then(() => resources.run(run))]);
  try {
    await resources.close();
  } catch (error) {
    recordAgentCleanupFailure();
    if (outcome.status === "rejected") {
      throw new AggregateError(
        [outcome.reason, error],
        "Repair turn and database resource cleanup failed.",
        { cause: error },
      );
    }
    throw error;
  }
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}

export async function prepareUpdateRepairInference(signal: AbortSignal, timeoutMs: number) {
  return withRepairResources(() => prepareRepairInference(signal, timeoutMs));
}

async function prepareRepairInference(signal: AbortSignal, timeoutMs: number) {
  signal.throwIfAborted();
  const { getRuntimeConfig } = await import("../config/io.js");
  signal.throwIfAborted();
  const config = getRuntimeConfig();
  const { selectUpdateRepairInference } = await import("./update-repair-inference.js");
  signal.throwIfAborted();
  return await selectUpdateRepairInference({ config, runtime: repairRuntime, signal, timeoutMs });
}

// Operator-owned updates permit prompt-free exec, never past an explicit deny.
// The repair workspace and filesystem tools stay within the install/candidate root;
// host commands must follow that same scope contract.
function repairRunConfig(
  route: SystemAgentConfiguredRoute,
  fallbacks: string[],
): Result<{ runConfig: OpenClawConfig; modelFallbacks: string[] }, string> {
  const base = route.runConfig;
  const exec = resolveExecToolConfig({ cfg: base, agentId: route.agentId });
  if (
    resolveSandboxConfigForAgent(base, route.agentId).mode !== "off" ||
    exec.host === "node" ||
    exec.host === "sandbox"
  ) {
    return err(LOCAL_INSTALLATION_TARGET_UNSUPPORTED);
  }
  const allowedToolsForModel = (modelProvider: string, modelId: string) => {
    const policy = resolveEffectiveToolPolicy({
      config: base,
      agentId: route.agentId,
      modelProvider,
      modelId,
    });
    const policies = [
      policy.globalPolicy,
      policy.agentPolicy,
      policy.globalProviderPolicy,
      policy.agentProviderPolicy,
      mergeAlsoAllowPolicy(resolveToolProfilePolicy(policy.profile), policy.profileAlsoAllow),
      mergeAlsoAllowPolicy(
        resolveToolProfilePolicy(policy.providerProfile),
        policy.providerProfileAlsoAllow,
      ),
    ];
    return ["exec", "process", "read", "write", "edit", "apply_patch"].filter((tool) =>
      isToolAllowedByPolicies(tool, policies),
    );
  };
  const permitsRepair = (tools: string[]) =>
    ["exec", "write", "edit", "apply_patch"].every((tool) => tools.includes(tool));
  const allowedTools = allowedToolsForModel(route.provider, route.model);
  if (exec.security === "deny" || !permitsRepair(allowedTools)) {
    return err("exec-denied-by-policy");
  }
  // Inference selection supplies canonical provider/model refs. A fallback must
  // pass the same repair gate before it can inherit prompt-free host execution.
  const modelFallbacks = fallbacks.filter((ref) => {
    const slash = ref.indexOf("/");
    return permitsRepair(allowedToolsForModel(ref.slice(0, slash), ref.slice(slash + 1)));
  });
  const localExec = {
    host: "gateway" as const,
    mode: "full" as const,
    security: undefined,
    ask: undefined,
    node: undefined,
  };
  const nativeModels = Object.fromEntries(
    [route.modelLabel, ...modelFallbacks].map((ref) => [
      ref,
      {
        ...base.agents?.defaults?.models?.[ref],
        ...base.agents?.entries?.[route.agentId]?.models?.[ref],
        agentRuntime: { id: "openclaw" },
      },
    ]),
  );
  return ok({
    modelFallbacks,
    runConfig: {
      ...base,
      agents: {
        ...base.agents,
        defaults: {
          ...base.agents?.defaults,
          models: { ...base.agents?.defaults?.models, ...nativeModels },
        },
        entries: Object.fromEntries(
          Object.entries(base.agents?.entries ?? {}).map(([id, entry]) => [
            id,
            {
              ...entry,
              models: { ...entry.models, ...nativeModels },
              tools: {
                ...entry.tools,
                exec: { ...entry.tools?.exec, ...localExec },
                fs: { ...entry.tools?.fs, workspaceOnly: true },
              },
            },
          ]),
        ),
      },
      tools: {
        ...base.tools,
        profile: base.tools?.profile ?? "coding",
        allow: allowedTools,
        alsoAllow: base.tools?.alsoAllow?.length ? allowedTools : undefined,
        exec: { ...base.tools?.exec, ...localExec },
        fs: { ...base.tools?.fs, workspaceOnly: true },
      },
    },
  });
}

type UpdateRepairTurnParams = {
  target: UpdateRepairTarget;
  route: Extract<SystemAgentConfiguredRoute, { runner: "embedded" }>;
  modelFallbacks: string[];
  prompt: string;
  timeoutMs: number;
  maxToolCalls: number;
  signal: AbortSignal;
  isCurrent?: () => boolean;
  maintenanceHandoff?: true;
};

export async function runUpdateRepairTurn(params: UpdateRepairTurnParams) {
  return withRepairResources(() => runScopedUpdateRepairTurn(params));
}

async function runScopedUpdateRepairTurn(params: UpdateRepairTurnParams) {
  params.signal.throwIfAborted();
  const { route, target } = params;
  const config = repairRunConfig(route, params.modelFallbacks);
  if (!config.ok) {
    return { status: "unavailable" as const, reason: config.error };
  }
  const { modelFallbacks } = config.value;
  const runConfig = buildExecRunConfig({ base: config.value.runConfig, cwd: target.installRoot });
  const controller = new AbortController();
  const signal = AbortSignal.any([params.signal, controller.signal]);
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (params.isCurrent?.() === false) {
      throw new Error("Repair no longer owns the failed update.");
    }
  };
  const runId = `update-repair-${randomUUID()}`;
  const sessionKey = `agent:${route.agentId}:update-repair:${runId}`;
  const preparedRunAdmission = prepareSystemAgentRunAdmission(
    runConfig,
    runId,
    route.agentId,
    "update.repair",
    assertCurrent,
  );
  const toolBudget = createAgentToolExecutionBudget({
    maxToolCalls: params.maxToolCalls,
    signal,
    abort: (reason) => controller.abort(reason),
    isCurrent: params.isCurrent,
  });
  const deadline = Date.now() + params.timeoutMs;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("per-turn-budget"));
  }, params.timeoutMs);
  let cleanupProcessScope: (() => Promise<void>) | undefined;
  let maintenance: UpdateRepairMaintenanceRequest | undefined;
  let envelope: {
    model: string;
    provider: string;
    final: string;
    error?: { message: string };
    status: AgentRunTerminalOutcome["status"];
  };
  try {
    const [{ runEmbeddedAgent }, { runEmbeddedAgentEntry }, { getProcessSupervisor }, secrets] =
      await Promise.all([
        import("../agents/embedded-agent.js"),
        import("../agents/embedded-agent-runner/run-entry.js"),
        import("../process/supervisor/index.js"),
        import("../secrets/provider-env-vars.js"),
      ]);
    assertCurrent();
    cleanupProcessScope = getProcessSupervisor().acquireScopeCleanup(sessionKey, {
      processTree: "required-all",
    });
    const sessionManager = SessionManager.inMemory(target.installRoot);
    const result = await withInstallationTarget(
      {
        stateDir: target.stateDir,
        configPath: target.configPath,
        defaultWorkspaceDir: target.workspaceDir,
      },
      () =>
        toolBudget.run(() =>
          withHostExecInheritedEnvOmitted(
            secrets.listKnownProviderAuthEnvVarNamesCore({ env: process.env }),
            () =>
              runEmbeddedAgentEntry({
                preparedRunAdmission,
                selection: {
                  cfg: runConfig,
                  provider: route.provider,
                  model: route.model,
                  agentDir: route.agentDir,
                  userLockedAuthProfileId: route.authProfileId,
                  fallbacksOverride: modelFallbacks,
                  requestedRouteResolution: "resolved",
                },
                identity: { runId, agentId: route.agentId, sessionId: runId, sessionKey },
                harness: {
                  workspaceDir: target.installRoot,
                  sessionKey,
                  preparation: { kind: "direct" },
                  resolveRuntimeOverride: () => "openclaw",
                },
                behavior: {
                  kind: "command-rpc",
                  hasCommittedSideEffect: () => toolBudget.toolCalls > 0,
                },
                sessionOverride: { kind: "preserve" },
                abortSignal: signal,
                runCandidate: (provider, model, options) => {
                  assertCurrent();
                  return runEmbeddedAgent({
                    ...options,
                    preparedRunAdmission,
                    runId,
                    sessionId: runId,
                    sessionKey,
                    sessionFile: `in-memory:${runId}`,
                    sessionManager,
                    sessionPersistence: "detached",
                    agentId: route.agentId,
                    // Keep the credential owner durable; temporary agent-exec state
                    // intentionally excludes shared OAuth to avoid duplicate refresh owners.
                    agentDir: route.agentDir,
                    workspaceDir: target.installRoot,
                    cwd: target.installRoot,
                    config: runConfig,
                    prompt: params.prompt,
                    clientTools: params.maintenanceHandoff
                      ? [updateRepairMaintenanceTool]
                      : undefined,
                    provider,
                    model,
                    ...(route.authProfileId && provider === route.provider
                      ? { authProfileId: route.authProfileId, authProfileIdSource: "user" as const }
                      : {}),
                    modelFallbacksOverride: modelFallbacks,
                    codeModeOverride: false,
                    disableTrajectory: true,
                    trigger: "manual",
                    timeoutMs: Math.max(1, deadline - Date.now()),
                    abortSignal: signal,
                    lane: sessionKey,
                  });
                },
              }),
          ),
        ),
    );
    const error = extractAgentRunTerminalError(result.result);
    if (params.maintenanceHandoff && result.terminal.outcome.status === "ok" && !error) {
      assertCurrent();
      maintenance = readUpdateRepairMaintenanceRequest(result.result.meta);
    }
    envelope = {
      model: result.model,
      provider: result.provider,
      final: extractAgentRunText(result.result) ?? "",
      ...(error ? { error: { message: error } } : {}),
      status: result.terminal.outcome.status,
    };
  } catch (error) {
    envelope = {
      model: route.model,
      provider: route.provider,
      final: "",
      error: { message: error instanceof Error ? error.message : String(error) },
      status: timedOut ? "timeout" : "error",
    };
  } finally {
    clearTimeout(timeout);
    preparedRunAdmission.close();
    controller.abort(new Error("Update repair turn completed"));
  }
  try {
    await cleanupProcessScope?.();
  } catch (error) {
    recordAgentCleanupFailure();
    throw error;
  }
  return {
    status: "completed" as const,
    toolCalls: toolBudget.toolCalls,
    envelope,
    ...(maintenance ? { maintenance } : {}),
  };
}
