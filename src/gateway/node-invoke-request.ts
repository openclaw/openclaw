import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  NODE_MCP_TOOL_CALL_TIMEOUT_MS,
  NODE_MCP_TOOLS_CALL_COMMAND,
} from "../infra/node-commands.js";

export function buildNodeInvokeRequest(params: {
  id: string;
  nodeId: string;
  command: string;
  params?: unknown;
  timeoutMs: number;
  idempotencyKey?: string;
  sessionKey?: string;
}) {
  return {
    id: params.id,
    nodeId: params.nodeId,
    command: params.command,
    paramsJSON: params.params === undefined ? null : JSON.stringify(params.params),
    timeoutMs: params.timeoutMs,
    idempotencyKey: params.idempotencyKey,
    sessionKey: normalizeOptionalString(params.sessionKey),
  };
}

/** Snapshot the node's work budget and wire request together before dispatch can yield. */
export function prepareNodeInvokeRequest(params: Parameters<typeof buildNodeInvokeRequest>[0]) {
  // The Gateway waits through human input. The node gets only its active-work budget,
  // including on older hosts that ignore the optional elicitation grant.
  const hasMcpQuestionGrant =
    params.command === NODE_MCP_TOOLS_CALL_COMMAND &&
    isRecord(params.params) &&
    typeof params.params.elicitationId === "string";
  return {
    payload: buildNodeInvokeRequest(params),
    workTimeoutLimit: hasMcpQuestionGrant ? NODE_MCP_TOOL_CALL_TIMEOUT_MS : Infinity,
  };
}

/** Measure the same outer encoding sent to nodes, including paramsJSON escaping. */
export function serializeNodeEvent(event: string, payload: unknown): string {
  return JSON.stringify({ type: "event", event, payload });
}
