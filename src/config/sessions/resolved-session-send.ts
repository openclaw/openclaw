import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type ResolvedSessionSendInput = {
  target: { sessionKey: string; sessionId: string };
  message: string;
  idempotencyKey: string;
};

/** Bind the write precondition and the admission receipt to one observed target and request. */
export function prepareResolvedSessionSend(input: ResolvedSessionSendInput) {
  const { sessionKey, sessionId } = input?.target ?? {};
  const requestId = input?.idempotencyKey;
  // Untyped plugin callers must never turn a missing physical target into an ordinary chat.send.
  if (
    typeof sessionKey !== "string" ||
    !sessionKey.trim() ||
    typeof sessionId !== "string" ||
    !sessionId.trim() ||
    typeof requestId !== "string" ||
    !requestId.trim() ||
    typeof input?.message !== "string"
  ) {
    return undefined;
  }
  return {
    params: {
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      message: input.message,
      idempotencyKey: requestId,
    },
    acknowledged(payload: unknown): boolean {
      return (
        isRecord(payload) &&
        payload.runId === requestId &&
        (payload.status === "started" || payload.status === "in_flight")
      );
    },
  };
}
