import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import {
  bindSessionWorkerBackend,
  type SessionWorkerDatabaseBinding,
} from "./session-entry-patch.worker.js";
import { commitSessionForkMessageCut } from "./session-message-cut.worker.js";
import type { SessionForkOperations } from "./session-parent-fork.types.js";
import {
  commitParentFork,
  prepareParentForkEntry,
  readParentForkSource,
} from "./session-parent-fork.worker.js";

/** The domain lends the canonical executor's connection and admission, never a second writer. */
export function bindSqliteWorkerBackend(
  input: { agentId: string },
  bound: SessionWorkerDatabaseBinding,
): SqliteWorkerBackend<SessionForkOperations> {
  return bindSessionWorkerBackend<SessionForkOperations>(
    input,
    bound,
    "Session fork",
    (context) => (command) => {
      if (command.type === "session.parentFork.prepare") {
        return prepareParentForkEntry(command.input, context);
      }
      if (command.type === "session.parentFork.source") {
        return readParentForkSource(command.input, context);
      }
      if (command.type === "session.parentFork.commit") {
        return commitParentFork(command.input, context);
      }
      return commitSessionForkMessageCut(command.input, context);
    },
  );
}
