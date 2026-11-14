import { formatErrorMessage } from "../../infra/errors.js";
import { sessionLog } from "../session-log.js";

/**
 * History mutations answer the client with a generic retry message. Record the
 * raw cause so an operator can tell a conflict from storage exhaustion.
 */
export function logSessionMessageCutFailure(
  action: string,
  stage: "upstream presence" | "local mutation",
  error: unknown,
): void {
  sessionLog.warn(`sessions.${action}: ${stage} failed: ${formatErrorMessage(error)}`);
}
