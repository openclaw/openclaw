import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { captureSessionActiveSteerTarget } from "../../config/sessions/session-active-steer.js";
import type { RespondFn } from "./response-types.js";

/** Capture the exact backend synchronously, before admission can yield. */
export function prepareActiveSteerInput(
  request: { activeSteer?: { runId: string } },
  session: Omit<Parameters<typeof captureSessionActiveSteerTarget>[0], "runId" | "sessionId"> & {
    requestedSessionId?: string;
  },
  respond: RespondFn,
) {
  const target = request.activeSteer
    ? captureSessionActiveSteerTarget({
        ...session,
        sessionId: session.requestedSessionId,
        runId: request.activeSteer.runId,
      })
    : undefined;
  if (request.activeSteer && !target) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "The requested run is not active or does not support steering.",
        { details: { reason: "active-steer-unavailable" } },
      ),
    );
    return { ok: false as const };
  }
  return { ok: true as const, target };
}
