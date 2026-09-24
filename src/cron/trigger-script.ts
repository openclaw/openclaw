import crypto from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { bindAgentToolSourceExecutionGuard } from "../agents/agent-tool-source-execution-guard.js";
import { wrapToolWithAbortSignal } from "../agents/agent-tools.abort.js";
import {
  rewrapToolWithBeforeToolCallHook,
  type HookContext,
} from "../agents/agent-tools.before-tool-call.js";
import {
  createOpenClawCodingTools,
  resolveToolLoopDetectionConfig,
} from "../agents/agent-tools.js";
import { createHeadlessDeadlineScope } from "../agents/code-mode-headless.js";
import type {
  CodeModeNamespaceDescriptor,
  SerializedCodeModeNamespaceValue,
} from "../agents/code-mode-namespaces.js";
import {
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
  runCodeModeScriptHeadless,
  type CodeModeFailureCode,
  type CodeModeHeadlessResult,
} from "../agents/code-mode.js";
import {
  applyEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
} from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { loadAgentRuntimePluginRegistryHandle } from "../agents/runtime-plugins.js";
import { resolveSandboxContext } from "../agents/sandbox.js";
import {
  resolveScheduledToolPolicyContext,
  type ScheduledToolPolicyContext,
} from "../agents/scheduled-tool-policy.js";
import {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  type ToolSearchToolContext,
} from "../agents/tool-search.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  resolveCronActiveRuntimeConfig,
  resolveCronAgentConfig,
} from "./isolated-agent/run-config.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import { resolveCronScheduledToolPolicy } from "./scheduled-tool-policy.js";
import {
  DEFAULT_CRON_SCRIPT_TIMEOUT_SECONDS,
  DEFAULT_CRON_SCRIPT_TOOL_BUDGET,
  MAX_CRON_SCRIPT_TIMEOUT_SECONDS,
  MAX_CRON_SCRIPT_TOOL_BUDGET,
} from "./script-payload.js";
import type { CronServiceDeps } from "./service/state.js";
import {
  parseScriptPayloadResult,
  parseTriggerResult,
  scriptFailure,
  type CronScriptPayloadExecutionResult,
} from "./trigger-script-result.js";
import type {
  CronToolsAllowExecTarget,
  CronTriggerEvaluationResult,
  CronTriggerFailureCode,
} from "./types.js";

const MAX_CONCURRENT_TRIGGER_EVALS = 3;
const MAX_CACHED_TRIGGER_RUNTIMES = 128;
const HEADLESS_TRIGGER_WALL_CLOCK_MS = 30_000;
const HEADLESS_TRIGGER_TOOL_BUDGET = 5;

let activeTriggerEvaluations = 0;

// Compile-time sync with the leaf contract in ./types.ts: a new code-mode
// failure code must be added to CronTriggerFailureCode or this line errors.
type AssertTriggerCodesCoverHeadless = [CodeModeFailureCode | "tool_budget_exceeded"] extends [
  CronTriggerFailureCode,
]
  ? true
  : never;
const assertTriggerCodesCoverHeadless: AssertTriggerCodesCoverHeadless = true;
void assertTriggerCodesCoverHeadless;

type PreparedTriggerRuntime = {
  createTools: (admitted: AdmittedRunContext, signal: AbortSignal) => AnyAgentTool[];
  context: HookContext & { config: OpenClawConfig; agentId: string; sessionKey: string };
  pluginRegistry?: PluginRegistry;
};

type CronScriptInvocation = Parameters<NonNullable<CronServiceDeps["evaluateCronTrigger"]>>[0];

type PrepareTriggerRuntime = (params: {
  runtimeConfig: OpenClawConfig;
  jobId: string;
  agentId?: string;
  toolsAllow?: string[];
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  execTarget?: CronToolsAllowExecTarget;
  signal?: AbortSignal;
  heartbeatCollector?: boolean;
  sessionKey?: string;
}) => Promise<PreparedTriggerRuntime>;

export type HeartbeatContextCommandOutput = { command: string; output: string };

export type HeartbeatContextCollection = {
  agentId: string;
  monitorJobId: string;
  sessionKey: string;
  commands: string[];
  /** Captured by the server from the registering agent's final tool surface. */
  authority: { toolsAllow: string[]; scheduledToolPolicy: ScheduledToolPolicyContext };
  abortSignal: AbortSignal;
  isCurrent: () => boolean;
};

type CodeModeInvocation = Omit<CronScriptInvocation, "job"> & {
  jobId: string;
  agentId?: string;
  toolsAllow?: string[];
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  execTarget?: CronToolsAllowExecTarget;
  sessionKey?: string;
  heartbeatCollector?: boolean;
  isCurrent?: () => boolean;
  collectOutput?: (input: unknown, result: unknown) => void;
};

function cronInvocation(params: CronScriptInvocation): CodeModeInvocation {
  return {
    ...params,
    jobId: params.job.id,
    agentId: params.job.agentId,
    toolsAllow: params.job.payload.toolsAllow,
    scheduledToolPolicy: resolveCronScheduledToolPolicy({
      toolsAllow: params.job.payload.toolsAllow,
      scheduledToolPolicy: params.job.scheduledToolPolicy,
      owner: params.job.owner,
    }),
    execTarget: params.job.toolsAllowExecTarget,
  };
}

type LoadTriggerPluginRegistry = (input: {
  config: OpenClawConfig;
  workspaceDir: string;
  allowGatewaySubagentBinding: boolean;
}) => PluginRegistry;

type CronTriggerEvaluatorDeps = {
  config: OpenClawConfig;
  runHeadless?: typeof runCodeModeScriptHeadless;
  prepareRuntime?: PrepareTriggerRuntime;
  loadPluginRegistry?: LoadTriggerPluginRegistry;
  resolveGatewayContext?: GatewayContextResolver;
};

type TriggerRuntimeCacheEntry = {
  promise: Promise<CachedTriggerRuntime>;
  configEpoch: OpenClawConfig;
  agentId: string;
  toolsAllowKey: string;
};

type CachedTriggerRuntime = PreparedTriggerRuntime & {
  isCurrent: () => boolean;
  invalidate: () => void;
};

function resolveTriggerAgentId(config: OpenClawConfig, agentId?: string): string {
  return agentId?.trim() ? normalizeAgentId(agentId) : resolveDefaultAgentId(config);
}

async function prepareTriggerRuntime(
  params: Parameters<PrepareTriggerRuntime>[0],
  loadPluginRegistry: LoadTriggerPluginRegistry = loadAgentRuntimePluginRegistryHandle,
): Promise<PreparedTriggerRuntime> {
  params.signal?.throwIfAborted();
  const agentId = resolveTriggerAgentId(params.runtimeConfig, params.agentId);
  const selectedAgentConfig = resolveAgentConfig(params.runtimeConfig, agentId);
  const agentConfigOverride = params.agentId?.trim() ? selectedAgentConfig : undefined;
  const { agentDefaults, cfgWithAgentDefaults: config } = resolveCronAgentConfig({
    config: params.runtimeConfig,
    agentConfigOverride,
  });
  const workspaceDirRaw = resolveAgentWorkspaceDir(config, agentId);
  const agentDir = resolveAgentDir(config, agentId);
  const { resolveAcpAgentWorkspaceProvisioningForTurn } =
    await import("../agents/acp-workspace-provisioning.js");
  const workspaceProvisioning = await resolveAcpAgentWorkspaceProvisioningForTurn({
    cfg: config,
    agentId,
    workspaceDir: workspaceDirRaw,
  });
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentDefaults.skipBootstrap,
    skipOptionalBootstrapFiles: agentDefaults.skipOptionalBootstrapFiles,
    provisioning: workspaceProvisioning,
  });
  params.signal?.throwIfAborted();
  const workspaceDir = workspace.dir;
  const pluginRegistry = loadPluginRegistry({
    config,
    workspaceDir,
    allowGatewaySubagentBinding: true,
  });

  const prepare = async (): Promise<PreparedTriggerRuntime> => {
    const rawSessionKey = params.sessionKey ?? `cron:${params.jobId}:trigger`;
    const sessionKey = resolveCronAgentSessionKey({
      sessionKey: rawSessionKey,
      agentId,
      mainKey: config.session?.mainKey,
      cfg: config,
    });
    const sandbox = await resolveSandboxContext({
      config,
      sessionKey,
      workspaceDir,
    });
    params.signal?.throwIfAborted();
    const effectiveWorkspace =
      sandbox?.enabled && sandbox.workspaceAccess !== "rw" ? sandbox.workspaceDir : workspaceDir;
    const toolPlan = resolveEmbeddedAttemptToolConstructionPlan({
      toolsEnabled: true,
      toolsAllow: params.toolsAllow,
    });
    // Bundle MCP tools are source:"mcp", which the headless bridge excludes.
    // LSP runtimes are session-scoped and intentionally outside trigger v1.
    const createTools: PreparedTriggerRuntime["createTools"] = (admitted, signal) => {
      const allTools = toolPlan.constructTools
        ? createOpenClawCodingTools({
            agentId,
            runId: admitted.operationalRunInstance.runId,
            operationalRunInstance: admitted.operationalRunInstance,
            abortSignal: signal,
            exec: {
              config,
              ...(params.heartbeatCollector
                ? { nonInteractiveApproval: true, allowBackground: false, notifyOnExit: false }
                : {}),
            },
            sandbox,
            sessionKey,
            trigger: "cron",
            jobId: params.jobId,
            agentDir,
            cwd: effectiveWorkspace,
            workspaceDir: effectiveWorkspace,
            spawnWorkspaceDir: workspaceDir,
            config,
            allowGatewaySubagentBinding: true,
            includeCoreTools: toolPlan.includeCoreTools,
            runtimeToolAllowlist: toolPlan.runtimeToolAllowlist,
            inheritRuntimeToolAllowlist: Boolean(toolPlan.runtimeToolAllowlist),
            scheduledToolPolicy: resolveScheduledToolPolicyContext({
              toolsAllow: params.toolsAllow,
              scheduledToolPolicy: params.scheduledToolPolicy,
              execTarget: params.execTarget,
            }),
            toolConstructionPlan: toolPlan.codingToolConstructionPlan,
          })
        : [];
      return applyEmbeddedAttemptToolsAllow(allTools, params.toolsAllow, {
        toolMeta: (tool) => getPluginToolMeta(tool),
      });
    };
    const context = {
      agentId,
      config,
      cwd: effectiveWorkspace,
      workspaceDir: effectiveWorkspace,
      sessionKey,
      loopDetection: resolveToolLoopDetectionConfig({ cfg: config, agentId }),
    };
    return {
      createTools,
      context,
      ...(pluginRegistry ? { pluginRegistry } : {}),
    };
  };
  return await withPluginRuntimeRegistryScope(pluginRegistry, prepare);
}

function triggerStateNamespace(state: unknown, streamBatch?: string): CodeModeNamespaceDescriptor {
  const entries: Array<[string, SerializedCodeModeNamespaceValue]> = [
    ["state", { kind: "value", value: state }],
  ];
  if (streamBatch !== undefined) {
    entries.push(["streamBatch", { kind: "value", value: streamBatch }]);
  }
  return {
    id: "cron:trigger",
    globalName: "trigger",
    scope: {
      kind: "object",
      entries,
    },
  };
}

function createCronCodeModeRunner(deps: CronTriggerEvaluatorDeps) {
  const runHeadless = deps.runHeadless ?? runCodeModeScriptHeadless;
  const prepareRuntime =
    deps.prepareRuntime ?? ((params) => prepareTriggerRuntime(params, deps.loadPluginRegistry));
  // Config and plugin lifecycle identity bound preparation reuse. Cache only preparation:
  // tool instances capture run authority, abort signals, and secret egress state.
  const runtimeCache = new Map<string, TriggerRuntimeCacheEntry>();

  const resolveCachedRuntime = async (
    request: Parameters<PrepareTriggerRuntime>[0],
    scope: ReturnType<typeof createHeadlessDeadlineScope>,
  ): Promise<CachedTriggerRuntime> => {
    const agentId = resolveTriggerAgentId(request.runtimeConfig, request.agentId);
    const toolsAllowKey = JSON.stringify([
      request.toolsAllow ?? null,
      request.scheduledToolPolicy ?? null,
      request.execTarget ?? null,
      request.sessionKey ?? null,
      request.heartbeatCollector ?? false,
    ]);
    const cached = runtimeCache.get(request.jobId);
    if (
      cached &&
      cached.configEpoch === request.runtimeConfig &&
      cached.agentId === agentId &&
      cached.toolsAllowKey === toolsAllowKey
    ) {
      runtimeCache.delete(request.jobId);
      runtimeCache.set(request.jobId, cached);
      try {
        return await scope.wait(cached.promise);
      } catch (error) {
        const ownerCanceled =
          error instanceof CodeModeHeadlessAbortError ||
          error instanceof CodeModeHeadlessTimeoutError;
        if (ownerCanceled && !scope.signal.aborted) {
          // A different caller owned and ended the shared cold preparation.
          // Retry under this still-live caller instead of inheriting its abort.
          if (runtimeCache.get(request.jobId) === cached) {
            runtimeCache.delete(request.jobId);
          }
          return await resolveCachedRuntime(request, scope);
        }
        throw error;
      }
    }
    const promise = prepareRuntime({ ...request, signal: scope.signal }).then((runtime) => ({
      ...runtime,
      isCurrent: runtime.pluginRegistry
        ? (capturePluginLifecycleAuthority(runtime.pluginRegistry, undefined, {
            scopedRuntime: true,
          }) ?? (() => false))
        : () => true,
      invalidate: () => {
        if (runtimeCache.get(request.jobId) === entry) {
          runtimeCache.delete(request.jobId);
        }
      },
    }));
    const entry: TriggerRuntimeCacheEntry = {
      promise,
      configEpoch: request.runtimeConfig,
      agentId,
      toolsAllowKey,
    };
    runtimeCache.delete(request.jobId);
    runtimeCache.set(request.jobId, entry);
    pruneMapToMaxSize(runtimeCache, MAX_CACHED_TRIGGER_RUNTIMES);
    // Failed preparations evict themselves so the next tick retries cold.
    void promise.catch(() => {
      if (runtimeCache.get(request.jobId) === entry) {
        runtimeCache.delete(request.jobId);
      }
    });
    return await scope.wait(entry.promise);
  };

  return async function runCronCodeModeScript(
    params: CodeModeInvocation & {
      wallClockMs: number;
      maxToolCalls: number;
      label: string;
      onExecutionStarted?: () => void | Promise<void>;
    },
  ): Promise<
    | { kind: "completed"; result: Extract<CodeModeHeadlessResult, { status: "completed" }> }
    | { kind: "error"; code: CronTriggerFailureCode; error: string }
  > {
    const evaluationScope = createHeadlessDeadlineScope(
      params.abortSignal,
      params.wallClockMs,
      params.label,
    );
    const catalogRef = createToolSearchCatalogRef();
    let admission: PreparedAgentRunAdmission | undefined;
    try {
      const request = {
        runtimeConfig: resolveCronActiveRuntimeConfig(deps.config),
        jobId: params.jobId,
        agentId: params.agentId,
        toolsAllow: params.toolsAllow,
        scheduledToolPolicy: params.scheduledToolPolicy,
        execTarget: params.execTarget,
        sessionKey: params.sessionKey,
        heartbeatCollector: params.heartbeatCollector,
      };
      const runId = `cron-trigger:${params.jobId}:${crypto.randomUUID()}`;
      let runtime: CachedTriggerRuntime | undefined;
      let tools: AnyAgentTool[];
      let admitted: AdmittedRunContext | undefined;
      let assertAdmitted: ReturnType<typeof resolveAdmittedRunActiveAssertion>;
      let caller: ReturnType<typeof createAdmittedGatewayToolCallerIdentity>;
      function assertActive() {
        if (
          params.isCurrent?.() === false ||
          !assertAdmitted ||
          !caller ||
          (caller.gatewayContextResolver && !caller.gatewayContextResolver())
        ) {
          throw new Error("cron script invocation is no longer active");
        }
        assertAdmitted();
      }
      for (let refresh = 0; ; refresh += 1) {
        try {
          runtime = await resolveCachedRuntime(request, evaluationScope);
          if (!runtime.isCurrent()) {
            throw new PluginInstanceUnavailableError();
          }
          if (!admitted) {
            admission = prepareAgentRunAdmission({
              cfg: runtime.context.config,
              operationalRunInstance: createOperationalRunInstanceRef(runId),
              facts: {
                runId,
                agentId: runtime.context.agentId,
                ingress: params.executionIdentity?.ingress ?? {
                  kind: "schedule",
                  boundary: "cron.script",
                  state: "present",
                },
                ...(params.executionIdentity?.invoker
                  ? { invoker: params.executionIdentity.invoker }
                  : {}),
              },
            });
            admitted = await admission.admit("gateway");
            bindGatewayContextResolver(admitted, deps.resolveGatewayContext);
            await params.executionIdentity?.onPostAdmission?.(admitted);
            assertAdmitted = resolveAdmittedRunActiveAssertion(admitted, evaluationScope.signal);
            caller = createAdmittedGatewayToolCallerIdentity({
              admittedRunContext: admitted,
              agentId: runtime.context.agentId,
              sessionKey: runtime.context.sessionKey,
              receiptAuthority: assertActive,
              approvalSignals: [evaluationScope.signal],
            });
          }
          assertActive();
          if (!runtime.isCurrent()) {
            throw new PluginInstanceUnavailableError();
          }
          const selected = runtime;
          const authority = admitted;
          tools = withPluginRuntimeRegistryScope(selected.pluginRegistry, () =>
            selected.createTools(authority, evaluationScope.signal),
          );
          if (!runtime.isCurrent()) {
            throw new PluginInstanceUnavailableError();
          }
          break;
        } catch (error) {
          if (
            error instanceof CodeModeHeadlessAbortError ||
            error instanceof CodeModeHeadlessTimeoutError ||
            evaluationScope.signal.aborted
          ) {
            throw error;
          }
          if (refresh > 0) {
            runtime?.invalidate();
            return scriptFailure(
              `Plugin tool refresh failed before the script started: ${formatErrorMessageWithCode(error)}`,
              "plugin_reload_failed",
            );
          }
          if (!(error instanceof PluginInstanceUnavailableError)) {
            throw error;
          }
          runtime?.invalidate();
          // Retry setup once with the same admission and deadline, never script execution.
        }
      }
      const ctx: ToolSearchToolContext = {
        ...runtime.context,
        runtimeConfig: runtime.context.config,
        runId,
        catalogRef,
        abortSignal: evaluationScope.signal,
        executeTool: (call) =>
          withGatewayToolCallerIdentity(caller, async () => {
            assertActive();
            // Guard the final wrapper so catalog preparation cannot discard the invocation fence.
            const tool = wrapToolWithAbortSignal(
              rewrapToolWithBeforeToolCallHook(
                // SAFETY: Headless registration and preparation retain AnyAgentTool instances.
                bindAgentToolSourceExecutionGuard(call.tool as AnyAgentTool, assertActive),
                undefined,
                params.heartbeatCollector ? { approvalMode: "deny" } : undefined,
              ),
              evaluationScope.signal,
            );
            const result = await tool.execute(
              call.toolCallId,
              call.input,
              call.signal,
              call.onUpdate,
            );
            assertActive();
            params.collectOutput?.(call.input, result);
            return await call.acceptResultBeforeProjection(result);
          }),
      };

      const selectedRuntime = runtime;
      return await withPluginRuntimeRegistryScope(selectedRuntime.pluginRegistry, async () => {
        assertActive();
        registerHeadlessToolSearchCatalog({
          catalogRef,
          tools,
          hookContext: { ...selectedRuntime.context, runId },
        });
        const remainingWallClockMs = Math.ceil(evaluationScope.deadline - performance.now());
        if (remainingWallClockMs <= 0) {
          throw new CodeModeHeadlessTimeoutError(`${params.label} timed out`);
        }
        await params.onExecutionStarted?.();
        assertActive();
        const result = await runHeadless({
          ctx,
          code: params.script,
          wallClockMs: remainingWallClockMs,
          maxToolCalls: params.maxToolCalls,
          extraNamespaces: [triggerStateNamespace(params.state, params.streamBatch)],
          signal: evaluationScope.signal,
        });
        if (result.status === "failed") {
          return scriptFailure(result.error, result.code);
        }
        assertActive();
        return { kind: "completed" as const, result };
      });
    } catch (error) {
      return scriptFailure(
        formatErrorMessageWithCode(error),
        error instanceof CodeModeHeadlessTimeoutError
          ? "timeout"
          : error instanceof CodeModeHeadlessAbortError
            ? "aborted"
            : "internal_error",
      );
    } finally {
      admission?.close();
      clearToolSearchCatalog({ catalogRef });
      evaluationScope.cleanup();
    }
  };
}

export function createCronScriptRuntime(deps: CronTriggerEvaluatorDeps) {
  const run = createCronCodeModeRunner(deps);
  return {
    collectHeartbeatContext: async (
      params: HeartbeatContextCollection,
    ): Promise<
      | { kind: "collected"; outputs: HeartbeatContextCommandOutput[] }
      | { kind: "error"; code: CronTriggerFailureCode; error: string }
    > => {
      if (
        params.commands.length < 1 ||
        params.commands.length > 5 ||
        params.commands.some((command) => !command.trim()) ||
        !params.authority.toolsAllow.includes("exec")
      ) {
        return scriptFailure(
          "Heartbeat context commands require a captured exec grant and 1–5 commands.",
        );
      }
      const outputs: HeartbeatContextCommandOutput[] = [];
      let collectionFailure: Extract<CronTriggerEvaluationResult, { kind: "error" }> | undefined;
      function failCollection(
        error: string,
        code: CronTriggerFailureCode = "internal_error",
      ): never {
        collectionFailure = scriptFailure(error, code);
        throw new Error(error);
      }
      const outcome = await run({
        jobId: params.monitorJobId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        toolsAllow: ["exec"],
        scheduledToolPolicy: params.authority.scheduledToolPolicy,
        heartbeatCollector: true,
        script: `for (const command of ${JSON.stringify(params.commands)}) { await exec({ command, timeoutSeconds: 25, background: false }); }`,
        state: null,
        abortSignal: params.abortSignal,
        isCurrent: params.isCurrent,
        wallClockMs: HEADLESS_TRIGGER_WALL_CLOCK_MS,
        maxToolCalls: params.commands.length,
        label: "heartbeat context collection",
        collectOutput: (input, result) => {
          const details = isRecord(result) ? result.details : undefined;
          if (
            !isRecord(input) ||
            typeof input.command !== "string" ||
            !isRecord(details) ||
            details.status !== "completed" ||
            details.exitCode !== 0 ||
            typeof details.aggregated !== "string"
          ) {
            failCollection(
              "Heartbeat context command failed or requires approval; inspect the group's commands.",
            );
          }
          if (details.truncated !== false) {
            failCollection(
              "Heartbeat context output is incomplete; narrow or split the commands.",
              "output_limit_exceeded",
            );
          }
          outputs.push({ command: input.command, output: details.aggregated });
          if (Buffer.byteLength(JSON.stringify(outputs), "utf8") > 16 * 1024) {
            failCollection(
              "Heartbeat context output exceeds 16 KiB; narrow or split the commands.",
              "output_limit_exceeded",
            );
          }
        },
      });
      if (collectionFailure) {
        return collectionFailure;
      }
      if (outcome.kind === "error") {
        // Tool/provider errors can include command text or output; only the failure class leaves this collector.
        return scriptFailure(
          `Heartbeat context collection failed (${outcome.code}).`,
          outcome.code,
        );
      }
      return outputs.length === params.commands.length
        ? { kind: "collected", outputs }
        : scriptFailure("Heartbeat context collection returned incomplete command results.");
    },
    evaluateTrigger: async (params: CronScriptInvocation): Promise<CronTriggerEvaluationResult> => {
      if (activeTriggerEvaluations >= MAX_CONCURRENT_TRIGGER_EVALS) {
        return { kind: "busy" };
      }
      activeTriggerEvaluations += 1;
      try {
        const outcome = await run({
          ...cronInvocation(params),
          wallClockMs: HEADLESS_TRIGGER_WALL_CLOCK_MS,
          maxToolCalls: HEADLESS_TRIGGER_TOOL_BUDGET,
          label: "cron trigger evaluation",
        });
        return outcome.kind === "completed" ? parseTriggerResult(outcome.result) : outcome;
      } finally {
        activeTriggerEvaluations -= 1;
      }
    },
    executePayload: async (
      params: Parameters<NonNullable<CronServiceDeps["runScriptJob"]>>[0],
    ): Promise<CronScriptPayloadExecutionResult> => {
      const payload = params.job.payload;
      if (payload.kind !== "script") {
        return scriptFailure("cron script payload executor is unavailable", "runtime_unavailable");
      }
      const timeoutSeconds = Math.min(
        MAX_CRON_SCRIPT_TIMEOUT_SECONDS,
        Math.max(1, Math.floor(payload.timeoutSeconds ?? DEFAULT_CRON_SCRIPT_TIMEOUT_SECONDS)),
      );
      const toolBudget = Math.min(
        MAX_CRON_SCRIPT_TOOL_BUDGET,
        Math.max(1, Math.floor(payload.toolBudget ?? DEFAULT_CRON_SCRIPT_TOOL_BUDGET)),
      );
      const outcome = await run({
        ...cronInvocation({
          ...params,
          script: payload.script,
          state: params.job.state.triggerState,
        }),
        wallClockMs: timeoutSeconds * 1000,
        maxToolCalls: toolBudget,
        label: "cron script payload",
        onExecutionStarted: params.executionIdentity?.onExecutionStarted,
      });
      return outcome.kind === "completed" ? parseScriptPayloadResult(outcome.result) : outcome;
    },
  };
}
