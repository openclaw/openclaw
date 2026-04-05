import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { createRuntimeTaskFlow } from "../../plugins/runtime/runtime-taskflow.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { isSpawnAcpAcceptedResult, spawnAcpDirect } from "../acp-spawn.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { SUBAGENT_SPAWN_MODES, spawnSubagentDirect } from "../subagent-spawn.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
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

function isTerminalTaskFlowStatus(status: unknown): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "blocked" ||
    status === "cancelled" ||
    status === "lost"
  );
}

function resolveRequesterContext(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
}) {
  const cfg = loadConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const requesterInternalKey = opts?.agentSessionKey
    ? resolveInternalSessionKey({
        key: opts.agentSessionKey,
        alias,
        mainKey,
      })
    : alias;
  const requesterOrigin = normalizeDeliveryContext({
    channel: opts?.agentChannel,
    accountId: opts?.agentAccountId,
    to: opts?.agentTo,
    threadId: opts?.agentThreadId,
  });
  return {
    requesterInternalKey,
    requesterOrigin,
  };
}

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  taskFlow: Type.Optional(
    Type.Object({
      controllerId: Type.Optional(Type.String()),
      goal: Type.Optional(Type.String()),
      currentStep: Type.Optional(Type.String()),
      notifyPolicy: Type.Optional(
        optionalStringEnum(["done_only", "state_changes", "silent"] as const),
      ),
      stateJson: Type.Optional(Type.Any()),
    }),
  ),
  runtime: optionalStringEnum(SESSIONS_SPAWN_RUNTIMES),
  agentId: Type.Optional(Type.String()),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        'Resume an existing agent session by its ID (e.g. a Codex session UUID from ~/.codex/sessions/). Requires runtime="acp". The agent replays conversation history via session/load instead of starting fresh.',
    }),
  ),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  thread: Type.Optional(Type.Boolean()),
  mode: optionalStringEnum(SUBAGENT_SPAWN_MODES),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
  streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS),

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
});

export function createSessionsSpawnTool(
  opts?: {
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
  } & SpawnedToolContext,
): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      'Spawn an isolated session (runtime="subagent" or runtime="acp"). mode="run" is one-shot and mode="session" is persistent/thread-bound. Subagents inherit the parent workspace directory automatically.',
    parameters: SessionsSpawnToolSchema,
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
      const task = readStringParam(params, "task", { required: true });
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const requestedAgentId = readStringParam(params, "agentId");
      const resumeSessionId = readStringParam(params, "resumeSessionId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cwd = readStringParam(params, "cwd");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const sandbox = params.sandbox === "require" ? "require" : "inherit";
      const streamTo = params.streamTo === "parent" ? "parent" : undefined;
      // Back-compat: older callers used timeoutSeconds for this tool.
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
      const taskFlowInput =
        params.taskFlow && typeof params.taskFlow === "object"
          ? (params.taskFlow as Record<string, unknown>)
          : undefined;

      if (taskFlowInput && streamTo === "parent") {
        return jsonResult({
          status: "error",
          error:
            "taskFlow requires tracked child tasks and cannot be combined with streamTo=parent.",
        });
      }

      const requesterContext = resolveRequesterContext({
        agentSessionKey: opts?.agentSessionKey,
        agentChannel: opts?.agentChannel,
        agentAccountId: opts?.agentAccountId,
        agentTo: opts?.agentTo,
        agentThreadId: opts?.agentThreadId,
      });
      const taskFlow = taskFlowInput
        ? createRuntimeTaskFlow().bindSession({
            sessionKey: requesterContext.requesterInternalKey,
            requesterOrigin: requesterContext.requesterOrigin,
          })
        : undefined;
      const createdFlow =
        taskFlow && taskFlowInput
          ? taskFlow.createManaged({
              controllerId:
                readStringParam(taskFlowInput, "controllerId") || "sessions_spawn/long-task",
              goal: readStringParam(taskFlowInput, "goal") || label || task,
              currentStep: readStringParam(taskFlowInput, "currentStep") || "spawn_worker",
              notifyPolicy:
                (readStringParam(taskFlowInput, "notifyPolicy") as
                  | "done_only"
                  | "state_changes"
                  | "silent"
                  | undefined) ?? "done_only",
              stateJson: (taskFlowInput.stateJson ?? {
                task,
                runtime,
                label: label || null,
                launch: {
                  kind: "sessions_spawn_child",
                  runtime,
                  task,
                  ...(label ? { label } : {}),
                  ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
                  ...(modelOverride ? { model: modelOverride } : {}),
                  ...(thinkingOverrideRaw ? { thinking: thinkingOverrideRaw } : {}),
                  ...(typeof runTimeoutSeconds === "number" ? { runTimeoutSeconds } : {}),
                  ...(typeof thread === "boolean" ? { thread } : {}),
                  ...(mode ? { mode } : {}),
                  ...(cleanup ? { cleanup } : {}),
                  ...(sandbox ? { sandbox } : {}),
                  ...(cwd ? { cwd } : {}),
                  ...(resumeSessionId ? { resumeSessionId } : {}),
                },
              }) as import("../../tasks/task-flow-registry.types.js").JsonValue,
            })
          : undefined;

      if (streamTo && runtime !== "acp") {
        if (createdFlow && taskFlow) {
          const latest = taskFlow.get(createdFlow.flowId) ?? createdFlow;
          taskFlow.fail({
            flowId: createdFlow.flowId,
            expectedRevision: latest.revision,
            stateJson: { task, runtime, error: `Unsupported streamTo for runtime=${runtime}` },
            blockedSummary: `Unsupported streamTo for runtime=${runtime}`,
          });
        }
        return jsonResult({
          status: "error",
          error: `streamTo is only supported for runtime=acp; got runtime=${runtime}`,
        });
      }

      if (resumeSessionId && runtime !== "acp") {
        if (createdFlow && taskFlow) {
          const latest = taskFlow.get(createdFlow.flowId) ?? createdFlow;
          taskFlow.fail({
            flowId: createdFlow.flowId,
            expectedRevision: latest.revision,
            stateJson: {
              task,
              runtime,
              error: `Unsupported resumeSessionId for runtime=${runtime}`,
            },
            blockedSummary: `Unsupported resumeSessionId for runtime=${runtime}`,
          });
        }
        return jsonResult({
          status: "error",
          error: `resumeSessionId is only supported for runtime=acp; got runtime=${runtime}`,
        });
      }

      if (runtime === "acp") {
        if (Array.isArray(attachments) && attachments.length > 0) {
          if (createdFlow && taskFlow) {
            const latest = taskFlow.get(createdFlow.flowId) ?? createdFlow;
            taskFlow.fail({
              flowId: createdFlow.flowId,
              expectedRevision: latest.revision,
              stateJson: {
                task,
                runtime,
                error: "attachments are currently unsupported for runtime=acp",
              },
              blockedSummary: "attachments are currently unsupported for runtime=acp",
            });
          }
          return jsonResult({
            status: "error",
            error:
              "attachments are currently unsupported for runtime=acp; use runtime=subagent or remove attachments",
          });
        }
        const result = await spawnAcpDirect(
          {
            task,
            label: label || undefined,
            agentId: requestedAgentId,
            parentFlowId: createdFlow?.flowId,
            resumeSessionId,
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
            sandboxed: opts?.sandboxed,
          },
        );
        const childSessionKey = result.childSessionKey?.trim();
        const childRunId = isSpawnAcpAcceptedResult(result) ? result.runId?.trim() : undefined;
        if (createdFlow && taskFlow) {
          const latest = taskFlow.get(createdFlow.flowId) ?? createdFlow;
          if (!isTerminalTaskFlowStatus(latest.status)) {
            taskFlow.setWaiting({
              flowId: createdFlow.flowId,
              expectedRevision: latest.revision,
              currentStep: "wait_worker",
              stateJson: {
                task,
                runtime,
                label: label || null,
                childSessionKey: childSessionKey ?? null,
                runId: childRunId ?? null,
                launch: {
                  kind: "sessions_spawn_child",
                  runtime,
                  task,
                  ...(label ? { label } : {}),
                  ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
                  ...(cwd ? { cwd } : {}),
                  ...(typeof thread === "boolean" ? { thread } : {}),
                  ...(result.mode ? { mode: result.mode } : {}),
                  ...(sandbox ? { sandbox } : {}),
                  ...(resumeSessionId ? { resumeSessionId } : {}),
                },
              },
              waitJson: {
                kind: "child_task",
                runtime,
                childSessionKey: childSessionKey ?? null,
                runId: childRunId ?? null,
              },
            });
          }
        }
        return jsonResult({
          ...result,
          ...(createdFlow ? { flowId: createdFlow.flowId } : {}),
        });
      }

      const result = await spawnSubagentDirect(
        {
          task,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          runTimeoutSeconds,
          thread,
          mode,
          cleanup,
          sandbox,
          expectsCompletionMessage: true,
          parentFlowId: createdFlow?.flowId,
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
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          workspaceDir: opts?.workspaceDir,
        },
      );

      if (createdFlow && taskFlow && result.status === "accepted") {
        const childSessionKey = result.childSessionKey?.trim() || undefined;
        const childRunId = result.runId?.trim() || undefined;
        const latest = taskFlow.get(createdFlow.flowId) ?? createdFlow;
        if (!isTerminalTaskFlowStatus(latest.status)) {
          taskFlow.setWaiting({
            flowId: createdFlow.flowId,
            expectedRevision: latest.revision,
            currentStep: "wait_worker",
            stateJson: {
              task,
              runtime,
              label: label || null,
              childSessionKey: childSessionKey ?? null,
              runId: childRunId ?? null,
              launch: {
                kind: "sessions_spawn_child",
                runtime,
                task,
                ...(label ? { label } : {}),
                ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
                ...(modelOverride ? { model: modelOverride } : {}),
                ...(thinkingOverrideRaw ? { thinking: thinkingOverrideRaw } : {}),
                ...(typeof runTimeoutSeconds === "number" ? { runTimeoutSeconds } : {}),
                ...(typeof thread === "boolean" ? { thread } : {}),
                ...(mode ? { mode } : {}),
                ...(cleanup ? { cleanup } : {}),
                ...(sandbox ? { sandbox } : {}),
                ...(Array.isArray(result.attachments) && result.attachments.length > 0
                  ? {
                      retryable: false,
                      retryReason:
                        "Retry unavailable: the original child task used attachments that cannot be safely replayed.",
                    }
                  : {}),
              },
            },
            waitJson: {
              kind: "child_task",
              runtime,
              childSessionKey: childSessionKey ?? null,
              runId: childRunId ?? null,
            },
          });
        }
      }

      if (createdFlow && taskFlow && result.status !== "accepted") {
        const latest = taskFlow.get(createdFlow.flowId) ?? createdFlow;
        taskFlow.fail({
          flowId: createdFlow.flowId,
          expectedRevision: latest.revision,
          stateJson: {
            task,
            runtime,
            label: label || null,
            error: result.error ?? "Spawn failed.",
            launch: {
              kind: "sessions_spawn_child",
              runtime,
              task,
              ...(label ? { label } : {}),
              ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
              ...(modelOverride ? { model: modelOverride } : {}),
              ...(thinkingOverrideRaw ? { thinking: thinkingOverrideRaw } : {}),
              ...(typeof runTimeoutSeconds === "number" ? { runTimeoutSeconds } : {}),
              ...(typeof thread === "boolean" ? { thread } : {}),
              ...(mode ? { mode } : {}),
              ...(cleanup ? { cleanup } : {}),
              ...(sandbox ? { sandbox } : {}),
            },
          },
          blockedSummary: result.error ?? "Spawn failed.",
        });
      }

      return jsonResult({
        ...result,
        ...(createdFlow ? { flowId: createdFlow.flowId } : {}),
      });
    },
  };
}
