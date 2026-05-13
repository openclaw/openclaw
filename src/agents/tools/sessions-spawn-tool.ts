import { Type } from "typebox";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import {
  resolveThreadBindingSpawnPolicy,
  supportsAutomaticThreadBindingSpawn,
} from "../../channels/thread-bindings-policy.js";
import { resolveSubagentMaxConcurrent } from "../../config/agent-limits.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import {
  findAcpUnsupportedInheritedToolAllow,
  findAcpUnsupportedInheritedToolDeny,
  formatAcpInheritedToolAllowError,
  formatAcpInheritedToolDenyError,
} from "../inherited-tool-deny.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { registerSubagentRun } from "../subagent-registry.js";
import {
  SUBAGENT_SPAWN_CONTEXT_MODES,
  SUBAGENT_SPAWN_MODES,
  spawnSubagentDirect,
} from "../subagent-spawn.js";
import { normalizeSubagentTaskName } from "../subagent-task-name.js";
import {
  describeSessionsSpawnTool,
  SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  normalizeToolModelOverride,
  readStringParam,
  ToolInputError,
} from "./common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
const SESSIONS_SPAWN_AUTO_YIELD_DELAY_MS = 15_000;
// Keep the schema local to avoid a circular import through acp-spawn/openclaw-tools.
const SESSIONS_SPAWN_ACP_STREAM_TARGETS = ["parent"] as const;
const UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS = [
  "target",
  "transport",
  "channel",
  "to",
  "threadId",
  "thread_id",
  "replyTo",
  "reply_to",
] as const;

type AcpSpawnModule = typeof import("../acp-spawn.js");

const acpSpawnModuleLoader = createLazyImportLoader<AcpSpawnModule>(
  () => import("../acp-spawn.js"),
);

async function loadAcpSpawnModule(): Promise<AcpSpawnModule> {
  return await acpSpawnModuleLoader.load();
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function addRoleToFailureResult<T extends { status: string }>(
  result: T,
  role: string | undefined,
): T | (T & { role: string }) {
  if (!role || (result.status !== "error" && result.status !== "forbidden")) {
    return result;
  }
  return { ...result, role };
}

function normalizeAcceptedSpawnToolResult<T extends { status: string }>(
  result: T,
): T | (Omit<T, "status"> & { status: "ok"; accepted: true; spawnStatus: "accepted" }) {
  if (result.status !== "accepted") {
    return result;
  }
  return {
    ...result,
    status: "ok",
    accepted: true,
    spawnStatus: "accepted",
  };
}

function resolveTrackedSpawnMode(params: {
  requestedMode?: "run" | "session";
  threadRequested: boolean;
}): "run" | "session" {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  return params.threadRequested ? "session" : "run";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(items.length || 1, Math.floor(concurrency)));
  const results: R[] = [];
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

async function cleanupUntrackedAcpSession(sessionKey: string): Promise<void> {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  try {
    await callGateway({
      method: "sessions.delete",
      params: {
        key,
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

type SessionsSpawnThreadAvailability = {
  subagent: boolean;
  acp: boolean;
};

function hasAnyThreadAvailability(availability: SessionsSpawnThreadAvailability): boolean {
  return availability.subagent || availability.acp;
}

function resolveSessionsSpawnThreadAvailability(opts?: {
  config?: OpenClawConfig;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
}): SessionsSpawnThreadAvailability {
  const channel = opts?.agentChannel;
  const cfg = opts?.config;
  if (!channel || !cfg || !supportsAutomaticThreadBindingSpawn(channel)) {
    return { subagent: false, acp: false };
  }
  const resolve = (kind: "subagent" | "acp") => {
    const policy = resolveThreadBindingSpawnPolicy({
      cfg,
      channel,
      accountId: opts?.agentAccountId,
      kind,
    });
    return policy.enabled && policy.spawnEnabled;
  };
  return {
    subagent: resolve("subagent"),
    acp: resolve("acp"),
  };
}

function createSessionsSpawnToolSchema(params: {
  acpAvailable: boolean;
  threadAvailable: boolean;
  sequentialSubagentMode: boolean;
}) {
  const spawnModes = params.threadAvailable ? SUBAGENT_SPAWN_MODES : (["run"] as const);
  const batchChildSchema = Type.Object({
    task: Type.String(),
    taskName: Type.Optional(
      Type.String({
        description:
          "Stable optional alias for later subagents targeting. Use lowercase letters, digits, and underscores, starting with a letter.",
      }),
    ),
    label: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    mode: optionalStringEnum(spawnModes),
    cleanup: optionalStringEnum(["delete", "keep"] as const),
    sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
    context: optionalStringEnum(SUBAGENT_SPAWN_CONTEXT_MODES),
    lightContext: Type.Optional(Type.Boolean()),
  });
  const schema = {
    task: Type.Optional(Type.String()),
    taskName: Type.Optional(
      Type.String({
        description:
          "Stable optional alias for later subagents targeting. Use lowercase letters, digits, and underscores, starting with a letter.",
      }),
    ),
    ...(params.sequentialSubagentMode
      ? {}
      : {
          children: Type.Optional(
            Type.Array(batchChildSchema, {
              minItems: 1,
              maxItems: 20,
              description:
                'Batch subagent fan-out. Each child accepts task, agentId, label, model, thinking, runTimeoutSeconds, mode, cleanup, sandbox, context, and lightContext. Batch mode supports runtime="subagent" only.',
            }),
          ),
        }),
    label: Type.Optional(Type.String()),
    runtime: optionalStringEnum(
      params.acpAvailable ? SESSIONS_SPAWN_RUNTIMES : (["subagent"] as const),
    ),
    agentId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    // Back-compat: older callers used timeoutSeconds for this tool.
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    ...(params.threadAvailable
      ? {
          thread: Type.Optional(
            Type.Boolean({
              description:
                'Bind the spawned session to a new chat thread when the current channel/account supports thread-bound session spawns. `thread=true` defaults mode to "session".',
            }),
          ),
        }
      : {}),
    mode: optionalStringEnum(spawnModes),
    cleanup: optionalStringEnum(["delete", "keep"] as const),
    sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
    context: optionalStringEnum(SUBAGENT_SPAWN_CONTEXT_MODES, {
      description:
        'Native subagent context mode. Omit or use "isolated" for a clean child session; use "fork" only when the child needs the requester transcript context.',
    }),
    lightContext: Type.Optional(
      Type.Boolean({
        description:
          "When true, spawned subagent runs use lightweight bootstrap context. Only applies to runtime='subagent'.",
      }),
    ),

    // Inline attachments (snapshot-by-value).
    // NOTE: Attachment contents are redacted from transcript persistence by sanitizeToolCallInputs.
    attachments: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          content: Type.String(),
          encoding: Type.Optional(optionalStringEnum(["utf8", "base64"] as const)),
          mimeType: Type.Optional(Type.String()),
        }),
        { maxItems: 50 },
      ),
    ),
    attachAs: Type.Optional(
      Type.Object({
        // Where the spawned agent should look for attachments.
        // Kept as a hint; implementation materializes into the child workspace.
        mountPath: Type.Optional(Type.String()),
      }),
    ),
    ...(params.acpAvailable
      ? {
          resumeSessionId: Type.Optional(
            Type.String({
              description:
                'ACP-only resume target. Only meaningful with runtime="acp"; ignored for runtime="subagent". Use only an ACP/harness session ID already recorded for this requester so the ACP backend replays conversation history instead of starting fresh.',
            }),
          ),
          streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS, {
            description:
              'ACP-only stream target. Only meaningful with runtime="acp"; ignored for runtime="subagent". Use "parent" to stream the ACP turn back to the requester instead of tracking it as a background sessions_spawn run.',
          }),
        }
      : {}),
  };
  return Type.Object(schema);
}

function resolveAcpUnavailableMessage(opts?: { sandboxed?: boolean; config?: OpenClawConfig }) {
  if (opts?.sandboxed === true) {
    return 'runtime="acp" is unavailable from sandboxed sessions because ACP sessions run on the host. Use runtime="subagent".';
  }
  if (opts?.config?.acp?.enabled === false) {
    return 'runtime="acp" is unavailable because ACP is disabled by policy (`acp.enabled=false`). Use runtime="subagent".';
  }
  return 'runtime="acp" is unavailable in this session because no ACP runtime backend is loaded. Enable the acpx plugin or use runtime="subagent".';
}

export function createSessionsSpawnTool(
  opts?: {
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
    sessionId?: string;
    onYield?: (message: string) => Promise<void> | void;
  } & SpawnedToolContext,
): AnyAgentTool {
  const subagentMaxConcurrent = resolveSubagentMaxConcurrent(opts?.config ?? getRuntimeConfig());
  const sequentialSubagentMode = subagentMaxConcurrent <= 1;
  const acpAvailable = isAcpRuntimeSpawnAvailable({
    config: opts?.config,
    sandboxed: opts?.sandboxed,
  });
  const threadAvailability = resolveSessionsSpawnThreadAvailability(opts);
  const threadAvailable = hasAnyThreadAvailability(threadAvailability);
  let autoYieldTimer: ReturnType<typeof setTimeout> | undefined;
  let autoYieldFired = false;

  const scheduleAutoYieldAfterAcceptedSpawn = (result: unknown) => {
    if (!opts?.sessionId || !opts.onYield || autoYieldFired) {
      return;
    }
    if (!result || typeof result !== "object") {
      return;
    }
    const record = result as Record<string, unknown>;
    if (record.status !== "accepted" || record.inlineDelivery === true) {
      return;
    }
    if (record.mode !== undefined && record.mode !== "run") {
      return;
    }
    if (autoYieldTimer) {
      clearTimeout(autoYieldTimer);
    }
    autoYieldTimer = setTimeout(() => {
      autoYieldFired = true;
      void opts.onYield?.("Waiting for spawned subagent completion.");
    }, SESSIONS_SPAWN_AUTO_YIELD_DELAY_MS);
    autoYieldTimer.unref?.();
  };

  return {
    label: "Sessions",
    name: "sessions_spawn",
    displaySummary: acpAvailable
      ? SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY
      : SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSpawnTool({
      acpAvailable,
      threadAvailable,
      subagentMaxConcurrent,
    }),
    parameters: createSessionsSpawnToolSchema({
      acpAvailable,
      threadAvailable,
      sequentialSubagentMode,
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find((key) =>
        Object.hasOwn(params, key),
      );
      if (unsupportedParam) {
        throw new ToolInputError(
          `sessions_spawn does not support "${unsupportedParam}". Use "message" or "sessions_send" for channel delivery.`,
        );
      }
      const children = Array.isArray(params.children)
        ? (params.children as Record<string, unknown>[])
        : undefined;
      const task = readStringParam(params, "task", { required: !children });
      const taskNameResult = normalizeSubagentTaskName(params.taskName);
      if (taskNameResult.error) {
        return jsonResult({
          status: "error",
          error: taskNameResult.error,
        });
      }
      const taskName = taskNameResult.taskName;
      const label = readStringParam(params, "label") ?? "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const requestedAgentId = readStringParam(params, "agentId");
      const resumeSessionId = readStringParam(params, "resumeSessionId");
      const modelOverride = normalizeToolModelOverride(readStringParam(params, "model"));
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cwd = readStringParam(params, "cwd");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const expectsCompletionMessage = params.expectsCompletionMessage !== false;
      const sandbox = params.sandbox === "require" ? "require" : "inherit";
      const context =
        params.context === "fork" || params.context === "isolated" ? params.context : undefined;
      const streamTo = runtime === "acp" && params.streamTo === "parent" ? "parent" : undefined;
      const lightContext = params.lightContext === true;
      const roleContext = requestedAgentId ? { role: requestedAgentId } : {};
      if (runtime === "acp" && !acpAvailable) {
        return jsonResult({
          status: "error",
          error: resolveAcpUnavailableMessage(opts),
          ...roleContext,
        });
      }
      const acpUnsupportedInheritedTool =
        runtime === "acp"
          ? findAcpUnsupportedInheritedToolDeny(opts?.inheritedToolDenylist)
          : undefined;
      if (acpUnsupportedInheritedTool) {
        return jsonResult({
          status: "forbidden",
          error: formatAcpInheritedToolDenyError(acpUnsupportedInheritedTool),
          ...roleContext,
        });
      }
      const acpUnsupportedInheritedAllow =
        runtime === "acp"
          ? findAcpUnsupportedInheritedToolAllow(opts?.inheritedToolAllowlist)
          : undefined;
      if (acpUnsupportedInheritedAllow) {
        return jsonResult({
          status: "forbidden",
          error: formatAcpInheritedToolAllowError(acpUnsupportedInheritedAllow),
          ...roleContext,
        });
      }
      if (runtime === "acp" && lightContext) {
        throw new Error("lightContext is only supported for runtime='subagent'.");
      }
      if (runtime === "acp" && context === "fork") {
        throw new Error('context="fork" is only supported for runtime="subagent".');
      }
      if (
        typeof params.runTimeoutSeconds === "number" &&
        typeof params.timeoutSeconds === "number" &&
        Math.floor(params.runTimeoutSeconds) !== Math.floor(params.timeoutSeconds)
      ) {
        throw new ToolInputError(
          "sessions_spawn received both runTimeoutSeconds and timeoutSeconds with different values. timeoutSeconds is a deprecated alias for runTimeoutSeconds; use only runTimeoutSeconds.",
        );
      }
      // Back-compat: older callers used timeoutSeconds as the child run timeout.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;
      const thread = params.thread === true;
      const attachments = Array.isArray(params.attachments)
        ? (params.attachments as Array<{
            name: string;
            content: string;
            encoding?: "utf8" | "base64";
            mimeType?: string;
          }>)
        : undefined;

      if (children) {
        if (runtime === "acp") {
          return jsonResult({
            status: "error",
            error: 'children batch mode supports only runtime="subagent".',
            ...roleContext,
          });
        }
        if (sequentialSubagentMode) {
          return jsonResult({
            status: "forbidden",
            error:
              "children batch mode is disabled while agents.defaults.subagents.maxConcurrent=1; spawn one child with a single sessions_spawn call, immediately call sessions_yield, wait for its completion, then spawn the next child.",
            ...roleContext,
          });
        }
        if (Array.isArray(attachments) && attachments.length > 0) {
          return jsonResult({
            status: "error",
            error:
              "attachments are unsupported in children batch mode; pass attachments in single-spawn mode",
            ...roleContext,
          });
        }
        const results = await mapWithConcurrency(
          children,
          subagentMaxConcurrent,
          async (child, index) => {
            try {
              const childTask = readStringParam(child, "task", { required: true });
              const childAgentId = readStringParam(child, "agentId") ?? requestedAgentId;
              const childLabel = readStringParam(child, "label") ?? label;
              const childModel = readStringParam(child, "model") ?? modelOverride;
              const childThinking = readStringParam(child, "thinking") ?? thinkingOverrideRaw;
              const childMode =
                child.mode === "run" || child.mode === "session" ? child.mode : mode;
              const childCleanup =
                child.cleanup === "keep" || child.cleanup === "delete" ? child.cleanup : cleanup;
              const childSandbox = child.sandbox === "require" ? "require" : sandbox;
              const childContext =
                child.context === "fork" || child.context === "isolated" ? child.context : context;
              const childLightContext =
                typeof child.lightContext === "boolean" ? child.lightContext : lightContext;
              if (
                typeof child.runTimeoutSeconds === "number" &&
                typeof child.timeoutSeconds === "number" &&
                Math.floor(child.runTimeoutSeconds) !== Math.floor(child.timeoutSeconds)
              ) {
                throw new ToolInputError(
                  `children[${index}] received both runTimeoutSeconds and timeoutSeconds with different values.`,
                );
              }
              const childTimeoutSecondsCandidate =
                typeof child.runTimeoutSeconds === "number"
                  ? child.runTimeoutSeconds
                  : typeof child.timeoutSeconds === "number"
                    ? child.timeoutSeconds
                    : runTimeoutSeconds;
              const childRunTimeoutSeconds =
                typeof childTimeoutSecondsCandidate === "number" &&
                Number.isFinite(childTimeoutSecondsCandidate)
                  ? Math.max(0, Math.floor(childTimeoutSecondsCandidate))
                  : undefined;
              const childResult = await spawnSubagentDirect(
                {
                  task: childTask,
                  label: childLabel || undefined,
                  agentId: childAgentId,
                  model: childModel,
                  thinking: childThinking,
                  runTimeoutSeconds: childRunTimeoutSeconds,
                  thread,
                  mode: childMode,
                  cleanup: childCleanup,
                  sandbox: childSandbox,
                  context: childContext,
                  lightContext: childLightContext,
                  expectsCompletionMessage,
                },
                {
                  agentSessionKey: opts?.agentSessionKey,
                  agentChannel: opts?.agentChannel,
                  agentAccountId: opts?.agentAccountId,
                  agentTo: opts?.agentTo,
                  agentThreadId: opts?.agentThreadId,
                  agentGroupId: opts?.agentGroupId,
                  agentGroupChannel: opts?.agentGroupChannel,
                  agentGroupSpace: opts?.agentGroupSpace,
                  agentMemberRoleIds: opts?.agentMemberRoleIds,
                  requesterAgentIdOverride: opts?.requesterAgentIdOverride,
                  workspaceDir: opts?.workspaceDir,
                },
              );
              scheduleAutoYieldAfterAcceptedSpawn(childResult);
              return normalizeAcceptedSpawnToolResult(
                addRoleToFailureResult(childResult, childAgentId),
              );
            } catch (err) {
              return {
                status: "error",
                index,
                error: summarizeError(err),
              };
            }
          },
        );
        const failed = results.filter((result) => result.status === "error");
        return jsonResult({
          status: failed.length > 0 ? "partial_error" : "ok",
          accepted: failed.length === 0,
          spawnStatus: failed.length === 0 ? "accepted" : "partial_error",
          count: results.length,
          failures: failed.length,
          results,
        });
      }
      if (!task) {
        throw new ToolInputError(
          "sessions_spawn requires task unless children batch mode is used.",
        );
      }

      if (runtime === "acp") {
        const { isSpawnAcpAcceptedResult, spawnAcpDirect } = await loadAcpSpawnModule();
        if (Array.isArray(attachments) && attachments.length > 0) {
          return jsonResult({
            status: "error",
            error:
              "attachments are currently unsupported for runtime=acp; use runtime=subagent or remove attachments",
            ...roleContext,
          });
        }
        const result = await spawnAcpDirect(
          {
            task,
            label: label || undefined,
            agentId: requestedAgentId,
            resumeSessionId,
            model: modelOverride,
            thinking: thinkingOverrideRaw,
            runTimeoutSeconds,
            cwd,
            mode: mode === "run" || mode === "session" ? mode : undefined,
            thread,
            sandbox,
            streamTo,
          },
          {
            agentSessionKey: opts?.agentSessionKey,
            agentChannel: opts?.agentChannel,
            agentAccountId: opts?.agentAccountId,
            agentTo: opts?.agentTo,
            agentThreadId: opts?.agentThreadId,
            agentGroupId: opts?.agentGroupId ?? undefined,
            agentGroupSpace: opts?.agentGroupSpace,
            agentMemberRoleIds: opts?.agentMemberRoleIds,
            sandboxed: opts?.sandboxed,
            inheritedToolAllowlist: opts?.inheritedToolAllowlist,
            inheritedToolDenylist: opts?.inheritedToolDenylist,
          },
        );
        const childSessionKey = result.childSessionKey?.trim();
        const childRunId = isSpawnAcpAcceptedResult(result) ? result.runId?.trim() : undefined;
        const shouldTrackViaRegistry =
          result.status === "accepted" &&
          Boolean(childSessionKey) &&
          Boolean(childRunId) &&
          streamTo !== "parent";
        if (shouldTrackViaRegistry && childSessionKey && childRunId) {
          const cfg = getRuntimeConfig();
          const trackedSpawnMode = resolveTrackedSpawnMode({
            requestedMode: result.mode,
            threadRequested: thread,
          });
          const trackedCleanup = trackedSpawnMode === "session" ? "keep" : cleanup;
          const { mainKey, alias } = resolveMainSessionAlias(cfg);
          const requesterInternalKey = opts?.agentSessionKey
            ? resolveInternalSessionKey({
                key: opts.agentSessionKey,
                alias,
                mainKey,
              })
            : alias;
          const requesterDisplayKey = resolveDisplaySessionKey({
            key: requesterInternalKey,
            alias,
            mainKey,
          });
          const requesterOrigin = normalizeDeliveryContext({
            channel: opts?.agentChannel,
            accountId: opts?.agentAccountId,
            to: opts?.agentTo,
            threadId: opts?.agentThreadId,
          });
          const shouldExpectCompletionMessage = result.inlineDelivery
            ? false
            : expectsCompletionMessage;
          try {
            registerSubagentRun({
              runId: childRunId,
              childSessionKey,
              requesterSessionKey: requesterInternalKey,
              requesterOrigin,
              requesterDisplayKey,
              task,
              taskName,
              cleanup: trackedCleanup,
              label: label || undefined,
              runTimeoutSeconds,
              expectsCompletionMessage: shouldExpectCompletionMessage,
              spawnMode: trackedSpawnMode,
            });
          } catch (err) {
            // Best-effort only: the ACP turn was already started above, so deleting the
            // child session record here does not guarantee the in-flight run was aborted.
            await cleanupUntrackedAcpSession(childSessionKey);
            return jsonResult({
              status: "error",
              error: `Failed to register ACP run: ${summarizeError(err)}. Cleanup was attempted, but the already-started ACP run may still finish in the background.`,
              childSessionKey,
              runId: childRunId,
              ...roleContext,
            });
          }
        }
        scheduleAutoYieldAfterAcceptedSpawn(result);
        return jsonResult(
          normalizeAcceptedSpawnToolResult(addRoleToFailureResult(result, requestedAgentId)),
        );
      }

      const result = await spawnSubagentDirect(
        {
          task,
          taskName,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          runTimeoutSeconds,
          thread,
          mode,
          cleanup,
          sandbox,
          context,
          lightContext,
          expectsCompletionMessage,
          attachments,
          attachMountPath:
            params.attachAs && typeof params.attachAs === "object"
              ? readStringParam(params.attachAs as Record<string, unknown>, "mountPath")
              : undefined,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          agentMemberRoleIds: opts?.agentMemberRoleIds,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          workspaceDir: opts?.workspaceDir,
          inheritedToolAllowlist: opts?.inheritedToolAllowlist,
          inheritedToolDenylist: opts?.inheritedToolDenylist,
        },
      );

      scheduleAutoYieldAfterAcceptedSpawn(result);
      return jsonResult(
        normalizeAcceptedSpawnToolResult(addRoleToFailureResult(result, requestedAgentId)),
      );
    },
  };
}
