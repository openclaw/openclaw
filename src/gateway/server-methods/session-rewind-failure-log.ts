import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { ErrorCode } from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { SqliteJsonlReadBudgetExceededError } from "../../infra/sqlite-jsonl-budget-error.js";
import { ModelSelectionLockedError } from "../../sessions/model-overrides.js";
import { sessionLog } from "../session-log.js";
import { LocalWorkspaceConflictError } from "../worker-environments/local-workspace-conflict-error.js";

/**
 * One owner for history-mutation failure answers.
 *
 * A locked model selection, a workspace conflict and an exceeded read budget
 * each name their own next step, so the client sees them verbatim. Everything
 * else answers with the generic retry message, and the raw cause is logged so
 * an operator can tell a conflict from storage exhaustion.
 */
export function rejectSessionMessageCutFailure(
  action: string,
  stage: "upstream presence" | "local mutation",
  error: unknown,
  reject: (message: string, code?: ErrorCode) => void,
): void {
  if (error instanceof ModelSelectionLockedError) {
    reject(error.message);
    return;
  }
  if (
    error instanceof LocalWorkspaceConflictError ||
    error instanceof SqliteJsonlReadBudgetExceededError
  ) {
    reject(error.message, ErrorCodes.UNAVAILABLE);
    return;
  }
  sessionLog.warn(`sessions.${action}: ${stage} failed: ${formatErrorMessage(error)}`);
  reject(`Failed to ${action} the local session. Try again.`, ErrorCodes.UNAVAILABLE);
}
