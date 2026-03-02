import { Type } from "@sinclair/typebox";
import { emit } from "../../infra/events/bus.js";
import { EVENT_TYPES } from "../../infra/events/schemas.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { ACP_SPAWN_MODES, spawnAcpDirect } from "../acp-spawn.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { SUBAGENT_SPAWN_MODES, spawnSubagentDirect } from "../subagent-spawn.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  runtime: optionalStringEnum(SESSIONS_SPAWN_RUNTIMES),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  thread: Type.Optional(Type.Boolean()),
  mode: optionalStringEnum(SUBAGENT_SPAWN_MODES),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  // Collaboration tracking fields
  taskId: Type.Optional(Type.String()),
  workSessionId: Type.Optional(Type.String()),
  parentConversationId: Type.Optional(Type.String()),
  depth: Type.Optional(Type.Number()),
  hop: Type.Optional(Type.Number()),
});

export function createSessionsSpawnTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  sandboxed?: boolean;
  /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      'Spawn an isolated session (runtime="subagent" or runtime="acp"). mode="run" is one-shot and mode="session" is persistent/thread-bound.',
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const requestedAgentId = readStringParam(params, "agentId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cwd = readStringParam(params, "cwd");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
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

      // Collaboration tracking fields
      const taskId = readStringParam(params, "taskId");
      const workSessionId = readStringParam(params, "workSessionId");
      const parentConversationId = readStringParam(params, "parentConversationId");
      const depth = typeof params.depth === "number" ? params.depth : undefined;
      const hop = typeof params.hop === "number" ? params.hop : undefined;

      // Resolve requester agent id for event emission
      const requesterAgentId = normalizeAgentId(
        opts?.requesterAgentIdOverride ?? parseAgentSessionKey(opts?.agentSessionKey)?.agentId,
      );
      const targetAgentId = requestedAgentId
        ? normalizeAgentId(requestedAgentId)
        : requesterAgentId;
      // Use parentConversationId as the shared conversationId for this spawn
      const conversationId = parentConversationId ?? undefined;
      const eventTs = Date.now();

      // Emit spawn event before dispatching
      emit({
        type: EVENT_TYPES.A2A_SPAWN,
        agentId: requesterAgentId,
        ts: eventTs,
        data: {
          fromAgent: requesterAgentId,
          toAgent: targetAgentId,
          conversationId,
          parentConversationId,
          workSessionId,
          taskId,
          depth,
          hop,
        },
      });

      // Emit send event
      emit({
        type: EVENT_TYPES.A2A_SEND,
        agentId: requesterAgentId,
        ts: eventTs,
        data: {
          fromAgent: requesterAgentId,
          toAgent: targetAgentId,
          conversationId,
          workSessionId,
          taskId,
        },
      });

      let result: Awaited<ReturnType<typeof spawnSubagentDirect>>;
      try {
        result =
          runtime === "acp"
            ? await spawnAcpDirect(
                {
                  task,
                  label: label || undefined,
                  agentId: requestedAgentId,
                  cwd,
                  mode: mode && ACP_SPAWN_MODES.includes(mode) ? mode : undefined,
                  thread,
                },
                {
                  agentSessionKey: opts?.agentSessionKey,
                  agentChannel: opts?.agentChannel,
                  agentAccountId: opts?.agentAccountId,
                  agentTo: opts?.agentTo,
                  agentThreadId: opts?.agentThreadId,
                },
              )
            : await spawnSubagentDirect(
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
                  expectsCompletionMessage: true,
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
                  conversationId,
                  parentConversationId,
                  workSessionId,
                  taskId,
                  depth,
                  hop,
                },
              );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        emit({
          type: EVENT_TYPES.A2A_SPAWN_RESULT,
          agentId: requesterAgentId,
          ts: Date.now(),
          data: {
            status: "error",
            error,
            conversationId,
            workSessionId,
            taskId,
          },
        });
        throw err;
      }

      // Emit spawn result event
      emit({
        type: EVENT_TYPES.A2A_SPAWN_RESULT,
        agentId: requesterAgentId,
        ts: Date.now(),
        data: {
          status: result.status,
          runId: result.runId,
          conversationId,
          workSessionId,
          taskId,
          error: result.status === "error" ? result.error : undefined,
        },
      });

      return jsonResult(result);
    },
  };
}
