import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  WorkerSessionsSendParamsSchema,
  WorkerPresenceParamsSchema,
  WorkerSessionsSpawnParamsSchema,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  buildBlockedToolResult,
  runBeforeToolCallHook,
} from "../../agents/agent-tools.before-tool-call.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { WorkerSessionToolRequest } from "./worker-session-tool-result.js";
import type { WorkerSessionToolSource } from "./worker-session-tool-topology.js";

type WorkerSessionOperationRequest = Extract<
  WorkerSessionToolRequest,
  { toolName: "sessions_spawn" | "sessions_send" | "presence" }
>;

export async function applyWorkerSessionToolPolicy<
  T extends WorkerSessionOperationRequest,
>(params: {
  request: T;
  source: Pick<WorkerSessionToolSource, "agentId" | "sessionId" | "sessionKey">;
}): Promise<{ request: T } | { result: ReturnType<typeof buildBlockedToolResult> }> {
  const { toolCallId, ...toolParams } = params.request.request;
  const runId = params.request.identity.runId ?? undefined;
  const outcome = await runBeforeToolCallHook({
    toolName: params.request.toolName,
    params: toolParams,
    toolCallId,
    ctx: {
      agentId: params.source.agentId,
      config: getRuntimeConfig(),
      sessionKey: params.source.sessionKey,
      sessionId: params.source.sessionId,
      runId,
    },
    ...(params.request.signal ? { signal: params.request.signal } : {}),
    approvalMode: "deny",
  });
  if (outcome.blocked) {
    return {
      result: buildBlockedToolResult({
        reason: outcome.reason,
        deniedReason: outcome.deniedReason,
        toolCallId,
        runId,
      }),
    };
  }
  const adjustedRequest = { ...asNonArrayRecord(outcome.params), toolCallId };
  const schema =
    params.request.toolName === "sessions_spawn"
      ? WorkerSessionsSpawnParamsSchema
      : params.request.toolName === "presence"
        ? WorkerPresenceParamsSchema
        : WorkerSessionsSendParamsSchema;
  if (!Value.Check(schema, adjustedRequest)) {
    return {
      result: buildBlockedToolResult({
        reason: `Tool call blocked because before_tool_call returned invalid ${params.request.toolName} input.`,
        toolCallId,
        runId,
      }),
    };
  }
  return {
    // SAFETY: Value.Check used the schema selected by this unchanged toolName discriminant.
    request: { ...params.request, request: adjustedRequest } as T,
  };
}
