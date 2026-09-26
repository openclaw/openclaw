import {
  asNullableRecord,
  asOptionalObjectRecord,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NodeInvokeCancelEvent } from "../../packages/gateway-protocol/src/schema/nodes.js";
import type { NodeInvokeRequestPayload } from "./invoke-types.js";

const MAX_INVOKE_INPUT_BYTES = 16 * 1024;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Each command validates its own JSON parameter contract.
export function decodeNodeInvokeParams<T>(raw?: string | null): T {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("INVALID_REQUEST: paramsJSON malformed JSON");
  }
}

export function coerceNodeInvokePayload(payload: unknown): NodeInvokeRequestPayload | null {
  const obj = asOptionalObjectRecord(payload);
  if (!obj) {
    return null;
  }
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const nodeId = typeof obj.nodeId === "string" ? obj.nodeId.trim() : "";
  const command = typeof obj.command === "string" ? obj.command.trim() : "";
  if (!id || !nodeId || !command) {
    return null;
  }
  const paramsJSON =
    typeof obj.paramsJSON === "string"
      ? obj.paramsJSON
      : obj.params !== undefined
        ? JSON.stringify(obj.params)
        : null;
  const timeoutMs = typeof obj.timeoutMs === "number" ? obj.timeoutMs : null;
  const idempotencyKey = typeof obj.idempotencyKey === "string" ? obj.idempotencyKey : null;
  const sessionKey = normalizeOptionalString(obj.sessionKey);
  return {
    id,
    nodeId,
    command,
    paramsJSON,
    timeoutMs,
    idempotencyKey,
    ...(sessionKey ? { sessionKey } : {}),
  };
}

export function coerceNodeInvokeCancelPayload(payload: unknown): NodeInvokeCancelEvent | null {
  const value = asNullableRecord(payload);
  return value && typeof value.invokeId === "string" && typeof value.nodeId === "string"
    ? { invokeId: value.invokeId, nodeId: value.nodeId }
    : null;
}

export function coerceNodeInvokeInputPayload(
  payload: unknown,
): { invokeId: string; nodeId: string; seq: number; payloadJSON: string } | null {
  const value = asNullableRecord(payload);
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.nodeId !== "string" ||
    !Number.isInteger(value.seq) ||
    (value.seq as number) < 0 ||
    typeof value.payloadJSON !== "string" ||
    Buffer.byteLength(value.payloadJSON, "utf8") > MAX_INVOKE_INPUT_BYTES
  ) {
    return null;
  }
  return {
    invokeId: value.id,
    nodeId: value.nodeId,
    seq: value.seq as number,
    payloadJSON: value.payloadJSON,
  };
}
