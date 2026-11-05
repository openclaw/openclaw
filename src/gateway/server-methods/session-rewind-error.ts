import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type {
  SessionMessageCutIntent,
  SessionMessageCutResult,
} from "../../config/sessions/session-message-cut.types.js";

export function resolveSessionMessageCutError(
  result: Exclude<SessionMessageCutResult, { status: "created" }>,
  action: SessionMessageCutIntent["mode"],
  entryId: string,
) {
  const actionLabel = action === "switch" ? "branch switch" : action;
  const message = {
    conflict: `Session changed; retry ${action}.`,
    "missing-session": "session not found",
    "missing-entry": `${action === "switch" ? "branch" : "message"} entry not found: ${entryId}`,
    "not-branch-tip": `entry is not a branch tip: ${entryId}`,
    "already-active": `branch is already active: ${entryId}`,
    "not-user-message": `entry is not a user message: ${entryId}`,
    "not-latest-reset": "Only the latest active reset can be undone. Reload the conversation.",
    "missing-reset-history": "The history before this reset is unavailable.",
    "off-active-path": `message entry is not on the active path: ${entryId}`,
    "unsupported-storage": `session transcript storage does not support ${actionLabel}`,
    failed: `failed to ${actionLabel} session`,
  }[result.status];
  return errorShape(
    result.status === "failed" ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
    message,
  );
}
