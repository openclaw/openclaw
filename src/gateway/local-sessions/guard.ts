// Execution fence for live local sessions: the device's native harness owns the
// thread, so every Gateway path that would run, rewrite, or rotate it fails
// closed here instead of silently executing on the Gateway.
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions/types.js";

export type LocalSessionFencedAction = "run" | "compact" | "rewind" | "fork" | "reset";

export function resolveLocalSessionExecutionError(
  entry: Pick<SessionEntry, "localSource"> | undefined,
  action: LocalSessionFencedAction,
): ErrorShape | null {
  if (!entry?.localSource) {
    return null;
  }
  const verb =
    action === "run"
      ? "run turns for"
      : action === "compact"
        ? "compact"
        : action === "reset"
          ? "reset"
          : action;
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `This session runs on ${entry.localSource.deviceId} (${entry.localSource.sourceId}); the Gateway cannot ${verb} it. Send a message to steer it, or ask the owner to act in their local session.`,
  );
}
