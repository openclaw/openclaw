import type {
  RequestFrame,
  ResponseFrame,
} from "../../../../packages/gateway-protocol/src/schema/frames.js";

export function startupAdmissionResponse(request: RequestFrame, ready: boolean): ResponseFrame {
  return {
    type: "res",
    id: request.id,
    ok: ready,
    ...(ready
      ? { payload: { status: "ok", runId: "started" } }
      : {
          error: {
            code: "UNAVAILABLE",
            message: "Agent is preparing",
            retryable: true,
            retryAfterMs: 1_000,
            details: { reason: "startup-sidecars", method: request.method },
          },
        }),
  };
}
