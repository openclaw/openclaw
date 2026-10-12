import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { findAgentRunTerminalOutcome } from "../agents/agent-run-terminal-error.js";
import { createAgentToolExecutionBudget } from "../agents/agent-tool-source-execution-guard.js";
import {
  recordAgentCleanupFailure,
  createAgentCleanupScope,
} from "../agents/run-cleanup-timeout.js";
import { isExecutionIdentityCollectionEnabled } from "../audit/audit-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { EmbeddedStateLockHandle } from "../infra/embedded-state-lock.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayLockIdentity } from "../infra/gateway-lock.js";
import {
  getInstallationTarget,
  LOCAL_INSTALLATION_TARGET_UNSUPPORTED,
} from "../infra/installation-target-context.js";
import { writeRuntimeJson, writeRuntimeStdout, type RuntimeEnv } from "../runtime.js";
import {
  buildExecRunConfig,
  resolveAgentExecPrompt,
  resolveExecBaseConfig,
  type AgentExecCliOptions,
} from "./agent-exec-input.js";
import { classifyAgentExecResult, type AgentExecEnvelope } from "./agent-exec-result.js";

const AGENT_EXEC_DEFAULT_TIMEOUT_SECONDS = 600;

type AgentExecCommandResult = {
  envelope: AgentExecEnvelope;
  exitCode: 0 | 1 | 2;
  toolCalls: number;
};

function normalizeCodeMode(
  value: AgentExecCliOptions["codeMode"],
): false | "auto" | true | undefined {
  if (value === undefined) {
    return undefined;
  }
  const modes = { direct: false, auto: "auto", code: true } as const;
  if (typeof value === "string" && Object.hasOwn(modes, value)) {
    return modes[value];
  }
  throw new Error("--code-mode must be one of direct, auto, code.");
}

function normalizeTimeoutSeconds(value: string | undefined): string {
  const raw = value ?? String(AGENT_EXEC_DEFAULT_TIMEOUT_SECONDS);
  if (parseStrictNonNegativeInteger(raw) === undefined) {
    throw new Error("--timeout must be a non-negative integer in seconds.");
  }
  return raw;
}

function normalizeFallbacks(model: string | undefined, values: string[] | undefined): string[] {
  const fallbacks = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (fallbacks.length > 0 && !model?.trim()) {
    throw new Error("--fallback requires --model so the primary model is explicit.");
  }
  return fallbacks;
}

async function requireDirectory(value: string, label: string): Promise<string> {
  const resolved = path.resolve(value);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (error) {
    throw new Error(`${label} does not exist: ${resolved}`, { cause: error });
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${resolved}`);
  }
  return resolved;
}

function setAgentExecEnvironment(params: { stateDir: string; cwd: string }): () => void {
  const previous = {
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_WORKSPACE_DIR: process.env.OPENCLAW_WORKSPACE_DIR,
  };
  // The published runtime snapshot owns config while state/workspace paths are redirected.
  process.env.OPENCLAW_STATE_DIR = params.stateDir;
  delete process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_WORKSPACE_DIR = params.cwd;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function formatActiveGatewayExecRefusal(identity: GatewayLockIdentity): string {
  return `A Gateway is running for this state directory (pid ${identity.pid}, port ${identity.port}). Omit --state-dir to use isolated temporary state, or stop the Gateway first (${formatCliCommand("openclaw gateway stop")}).`;
}

function isStructuredTimeoutError(error: unknown): boolean {
  if (findAgentRunTerminalOutcome(error)?.status === "timeout") {
    return true;
  }
  let candidate = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!candidate || typeof candidate !== "object") {
      return false;
    }
    const record = candidate as {
      cause?: unknown;
      code?: unknown;
      name?: unknown;
      reason?: unknown;
    };
    if (
      record.name === "TimeoutError" ||
      record.code === "ETIMEDOUT" ||
      record.reason === "timeout"
    ) {
      return true;
    }
    candidate = record.cause;
  }
  return false;
}

function errorEnvelope(error: unknown, sessionId: string): AgentExecEnvelope {
  const status = isStructuredTimeoutError(error) ? "timeout" : "error";
  return {
    ok: false,
    status,
    final: "",
    payloads: [],
    model: null,
    provider: null,
    sessionId,
    error: {
      message: formatErrorMessage(error),
      kind: status === "timeout" ? "timeout" : "exception",
    },
  };
}

function writeAgentExecOutput(
  runtime: RuntimeEnv,
  envelope: AgentExecEnvelope,
  json: boolean,
): void {
  if (json) {
    writeRuntimeJson(runtime, envelope);
  } else if (envelope.final) {
    writeRuntimeStdout(runtime, envelope.final);
  }
  if (!envelope.ok && envelope.error) {
    runtime.error(envelope.error.message);
  }
}

/** Run one isolated embedded agent turn and project its stable CLI result. */
export async function agentExecCommand(
  positionalMessage: string | undefined,
  opts: AgentExecCliOptions,
  runtime: RuntimeEnv,
): Promise<AgentExecCommandResult> {
  const sessionId = randomUUID();
  const abortController = new AbortController();
  const signal = abortController.signal;
  const toolBudget = createAgentToolExecutionBudget({
    signal,
    abort: (reason) => abortController.abort(reason),
  });
  const resultForEnvelope = (envelope: AgentExecEnvelope): AgentExecCommandResult => ({
    envelope,
    exitCode: envelope.status === "ok" ? 0 : envelope.status === "timeout" ? 2 : 1,
    toolCalls: toolBudget.toolCalls,
  });
  let commandResult: AgentExecCommandResult;
  const runtimeCleanup = createAgentCleanupScope();
  let temporaryStateDir: string | undefined;
  let restoreEnvironment: (() => void) | undefined;
  let restoreConfigEnvironment: (() => void) | undefined;
  let restoreRuntimeConfigSnapshot: (() => void) | undefined;
  let runtimePaths: typeof import("../config/paths.js") | undefined;
  let configIo: typeof import("../config/io.js") | undefined;
  let stopLocalAuditWriter: (() => Promise<void>) | undefined;
  let stateLock: EmbeddedStateLockHandle | null | undefined;
  let temporaryDatabaseScope:
    | import("../state/openclaw-state-db-async-lifecycle.js").OpenClawDatabaseMaintenanceScope
    | undefined;
  let abortSignal = signal;
  let signalBridge:
    | ReturnType<
        (typeof import("../infra/embedded-state-lock.js"))["createEmbeddedStateSignalBridge"]
      >
    | undefined;
  try {
    signal.throwIfAborted();
    const codeModeOverride = normalizeCodeMode(opts.codeMode);
    const prompt = await resolveAgentExecPrompt(positionalMessage, opts.messageFile, process.stdin);
    const cwd = await requireDirectory(opts.cwd ?? process.cwd(), "Working directory");
    const stateDir = opts.stateDir
      ? await requireDirectory(opts.stateDir, "State directory")
      : await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-exec-"));
    // Cleanup owns only the temporary state directory, never the caller's --state-dir.
    temporaryStateDir = opts.stateDir ? undefined : stateDir;
    configIo = await import("../config/io.js");
    // Ambient loading publishes a snapshot, so capture the caller's snapshot first.
    const previousRuntimeConfigSnapshot = configIo.getRuntimeConfigSnapshot();
    const snapshotIo = configIo;
    restoreRuntimeConfigSnapshot = () => {
      if (previousRuntimeConfigSnapshot) {
        snapshotIo.setRuntimeConfigSnapshot(previousRuntimeConfigSnapshot);
      } else {
        snapshotIo.clearRuntimeConfigSnapshot();
      }
    };
    // Load before redirecting state, then undo its env/shell imports so later runs
    // cannot inherit these credentials. The loader rolls back its own failed loads.
    const { restoreEnvChangesIfUnchanged, snapshotEnv } = configIo;
    const envBeforeConfigLoad = snapshotEnv(process.env);
    const baseConfig = await resolveExecBaseConfig(opts);
    const envAfterConfigLoad = snapshotEnv(process.env);
    restoreConfigEnvironment = () =>
      restoreEnvChangesIfUnchanged({
        env: process.env,
        before: envBeforeConfigLoad,
        after: envAfterConfigLoad,
      });
    const runConfig = buildExecRunConfig({ base: baseConfig, cwd, opts });
    // Plugin discovery and its index keep the operator's roots after state moves.
    const inheritInstalledPlugins = opts.isolated !== true && opts.authEnvOnly !== true;
    const pluginInstallContext = inheritInstalledPlugins
      ? await import("../plugins/install-root-context.js")
      : undefined;
    const pluginInstallRoots = pluginInstallContext?.resolvePluginInstallRoots();
    const timeout = normalizeTimeoutSeconds(opts.timeout);
    const fallbacks = normalizeFallbacks(opts.model, opts.fallback);
    const { resolveAgentDir, resolveAmbientOwnerAgentId } =
      await import("../agents/agent-scope-config.js");
    // Credentials follow the inherited agentDir, which runConfig strips for isolation.
    // Resolve their owner before redirecting state so default paths also stay real.
    const execAgentId = resolveAmbientOwnerAgentId(baseConfig, undefined, {
      surface: "agent exec",
      hint: "Set agents.defaults.systemAgent.agentId.",
    });
    if (getInstallationTarget()) {
      const [{ resolveSandboxConfigForAgent }, { resolveExecToolConfig }] = await Promise.all([
        import("../agents/sandbox/config.js"),
        import("../agents/lazy-exec-tool.js"),
      ]);
      const execHost = resolveExecToolConfig({ cfg: runConfig, agentId: execAgentId }).host;
      // Exec creates a fresh explicit (non-main) session. Preserve its configured
      // isolation instead of launching a fixer against a remote or sandbox copy.
      if (
        resolveSandboxConfigForAgent(runConfig, execAgentId).mode !== "off" ||
        execHost === "node" ||
        execHost === "sandbox"
      ) {
        throw new Error(LOCAL_INSTALLATION_TARGET_UNSUPPORTED);
      }
    }
    // Auth, session keys, and SQLite ownership must share one resolved owner.
    // Splitting these paths can select an agent's store but emit a `main` key.
    const storedAuthAgentDir = resolveAgentDir(baseConfig, execAgentId);
    runtimePaths = await import("../config/paths.js");
    const storedAuthStateDir = runtimePaths.resolveStateDir();
    restoreEnvironment = setAgentExecEnvironment({ stateDir, cwd });
    runtimePaths.pinRuntimePaths();
    if (temporaryStateDir) {
      const { createOpenClawDatabaseMaintenanceScope } =
        await import("../state/openclaw-state-db-async-lifecycle.js");
      // Temporary runs own their resources without borrowing maintenance schema authority.
      temporaryDatabaseScope = createOpenClawDatabaseMaintenanceScope();
    }
    if (opts.stateDir) {
      const { acquireEmbeddedStateLock, createEmbeddedStateSignalBridge } =
        await import("../infra/embedded-state-lock.js");
      signalBridge = createEmbeddedStateSignalBridge(process);
      // Retained-state signals and caller cancellation both own the turn's lifetime.
      abortSignal = AbortSignal.any([abortSignal, signalBridge.signal]);
      stateLock = await acquireEmbeddedStateLock({
        signal: abortSignal,
        formatActiveGatewayRefusal: formatActiveGatewayExecRefusal,
      });
    }
    // Publish in memory; a temporary config file would expose resolved provider keys to tools.
    snapshotIo.setRuntimeConfigSnapshot(runConfig);
    const [
      { withAuthProfileStoreAgentDir, withEnvOnlyAuthProfileStore },
      { withHostExecInheritedEnvOmitted },
      { listKnownProviderAuthEnvVarNamesCore },
      { agentCommand },
    ] = await Promise.all([
      import("../agents/auth-profiles.js"),
      import("../infra/host-env-security.js"),
      import("../secrets/provider-env-vars.js"),
      import("./agent.js"),
    ]);
    let fallbackExhausted = false;
    let resultErrorPayload: string | true | undefined;
    const silentRuntime: RuntimeEnv = {
      log: () => {},
      error: (...args) => runtime.error(...args),
      exit: (code, exitOpts) => runtime.exit(code, exitOpts),
    };
    const invoke = async () => {
      abortSignal.throwIfAborted();
      return await agentCommand(
        {
          message: prompt,
          sessionId,
          agentId: execAgentId,
          workspaceDir: cwd,
          cwd,
          model: opts.model,
          codeModeOverride,
          thinking: opts.thinking,
          timeout,
          modelFallbacksOverride: fallbacks.length > 0 ? fallbacks : undefined,
          cleanupBundleMcpOnRunEnd: true,
          cleanupCliLiveSessionOnRunEnd: true,
          oneShotCliRun: true,
          abortSignal,
          onModelFallbackExhausted: () => {
            fallbackExhausted = true;
          },
          onResultErrorPayload: (message?: string) => {
            resultErrorPayload = message ?? true;
          },
        },
        silentRuntime,
      );
    };
    const runWithPluginInstallRoots = () =>
      pluginInstallContext && pluginInstallRoots
        ? pluginInstallContext.withPluginInstallRoots(pluginInstallRoots, invoke)
        : invoke();
    const runWithAuthScope = () =>
      opts.authEnvOnly === true
        ? withEnvOnlyAuthProfileStore(runWithPluginInstallRoots)
        : withAuthProfileStoreAgentDir(
            storedAuthAgentDir,
            storedAuthStateDir,
            runWithPluginInstallRoots,
          );
    const run = async () => {
      if (isExecutionIdentityCollectionEnabled(runConfig)) {
        try {
          stopLocalAuditWriter = (
            await import("./agent-local-audit.js")
          ).startAgentLocalAuditWriter(runConfig, { stateDir });
        } catch {
          // Admission emits a bounded warning if the direct-process writer is unavailable.
        }
      }
      return await toolBudget.run(() =>
        withHostExecInheritedEnvOmitted(
          listKnownProviderAuthEnvVarNamesCore({ env: process.env }),
          runWithAuthScope,
        ),
      );
    };
    const result = await runtimeCleanup.run(() =>
      temporaryDatabaseScope ? temporaryDatabaseScope.run(run) : run(),
    );
    signal.throwIfAborted();
    if (!result) {
      throw new Error("Agent run returned no result");
    }
    const envelope = classifyAgentExecResult(result, fallbackExhausted, resultErrorPayload);
    if (!envelope.sessionId) {
      envelope.sessionId = sessionId;
    }
    commandResult = resultForEnvelope(envelope);
  } catch (error) {
    commandResult = resultForEnvelope(errorEnvelope(error, sessionId));
  }

  let cleanupError: unknown =
    runtimeCleanup.outcome === "uncertain"
      ? new Error(
          "Agent runtime cleanup did not settle; state ownership retained until this process exits",
        )
      : undefined;
  const recordCleanupError = (error: unknown) => {
    cleanupError = error;
  };
  const stopAudit = async () => await stopLocalAuditWriter?.();
  await (temporaryDatabaseScope ? temporaryDatabaseScope.run(stopAudit) : stopAudit()).catch(
    () => undefined,
  );
  // Delayed worker registration can outlive its lexical maintenance scope. Drain the
  // exact temporary owners before the scope closes and the filesystem root is removed.
  if (!cleanupError && temporaryStateDir) {
    const { closeOpenClawAgentDatabasesAsync } =
      await import("../state/openclaw-agent-db-lifecycle.js");
    await closeOpenClawAgentDatabasesAsync(temporaryStateDir).catch(recordCleanupError);
  }
  if (!cleanupError && temporaryStateDir) {
    const [{ closeOpenClawStateDatabaseByPathAsync }, { resolveOpenClawStateSqlitePath }] =
      await Promise.all([
        import("../state/openclaw-state-db-cache.js"),
        import("../state/openclaw-state-db.paths.js"),
      ]);
    const temporaryStatePath = resolveOpenClawStateSqlitePath({
      ...process.env,
      OPENCLAW_STATE_DIR: temporaryStateDir,
    });
    await closeOpenClawStateDatabaseByPathAsync(temporaryStatePath).catch(recordCleanupError);
  }
  if (!cleanupError) {
    await temporaryDatabaseScope?.close().catch(recordCleanupError);
  }
  if (!cleanupError) {
    await stateLock?.release().catch(recordCleanupError);
  }
  const runCleanupStep = (step: () => void) => {
    try {
      step();
    } catch (error) {
      cleanupError ??= error;
    }
  };
  runCleanupStep(() => restoreEnvironment?.());
  runCleanupStep(() => restoreConfigEnvironment?.());
  runCleanupStep(() => configIo?.clearConfigCache());
  runCleanupStep(() =>
    restoreRuntimeConfigSnapshot
      ? restoreRuntimeConfigSnapshot()
      : configIo?.clearRuntimeConfigSnapshot(),
  );
  runCleanupStep(() => runtimePaths?.pinRuntimePaths());
  if (temporaryStateDir && !cleanupError) {
    try {
      await fs.rm(temporaryStateDir, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError) {
    recordAgentCleanupFailure();
    const cleanupFailure = new Error(
      `Agent exec cleanup failed: ${formatErrorMessage(cleanupError)}`,
    );
    if (commandResult.envelope.ok) {
      commandResult = resultForEnvelope(errorEnvelope(cleanupFailure, sessionId));
    } else {
      runtime.error(cleanupFailure.message);
    }
  }

  const receivedSignal = signalBridge?.getReceivedSignal();
  signalBridge?.dispose();
  if (receivedSignal) {
    runtime.exit(receivedSignal === "SIGINT" ? 130 : 143, { resetStream: process.stderr });
    return commandResult;
  }

  writeAgentExecOutput(runtime, commandResult.envelope, opts.json === true);
  return commandResult;
}
