import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { isGatewayProtocolResponseError } from "../../packages/gateway-client/src/protocol-request.js";

export function acceptSupersededHistoryRead(error: unknown): void {
  if (
    isGatewayProtocolResponseError(error) &&
    error.code === "UNAVAILABLE" &&
    error.retryable &&
    error.message === "session changed while reading history; reload the conversation" &&
    asRecord(error.details)?.method === "chat.history" &&
    error.responsePayload === undefined
  ) {
    return;
  }
  throw error;
}

/** Retry only an authoritative pre-delete conflict, after the owned run settles. */
export async function deleteAfterLifecycleRace(params: {
  key: string;
  remove: () => Promise<{ ok?: boolean; deleted?: boolean }>;
  settle: () => Promise<void>;
}): Promise<void> {
  let result: { ok?: boolean; deleted?: boolean };
  try {
    result = await params.remove();
  } catch (error) {
    if (
      !isGatewayProtocolResponseError(error) ||
      error.code !== "INVALID_REQUEST" ||
      error.message !== `Session ${params.key} changed before deletion. Retry.` ||
      asRecord(error.details)?.reason !== "session-changed" ||
      error.responsePayload !== undefined
    ) {
      throw error;
    }
    await params.settle();
    result = await params.remove();
  }
  if (result.ok !== true || result.deleted !== true) {
    throw new Error(`sessions.delete failed for ${params.key}: ${JSON.stringify(result)}`);
  }
}
