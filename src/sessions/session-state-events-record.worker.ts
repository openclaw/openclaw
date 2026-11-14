import { readAcpSessionControlInWorker } from "../acp/runtime/session-meta-source.worker.js";
import { requestSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.worker.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import {
  hasSessionStateWatchersInDatabase,
  isSessionStateUpstreamCurrentInDatabase,
  recordSessionStateEventsInDatabase,
  type SessionStateEventInput,
} from "./session-state-events.kernel.js";
import type { SessionStateWorkerOperations } from "./session-state-events.worker-contract.js";

export const sessionStateRecordOperations = {
  "sessionState.record": (
    input: SessionStateWorkerOperations["sessionState.record"]["input"],
    context,
  ) => {
    const database = context.open();
    const admit = (stage: "transaction" | "commit") =>
      requestSessionEntryCurrentAdmission(input.sessionEntryCurrentSource, {
        stage,
        facts: undefined,
      });
    const { events, now, onlyIfWatched, expectedUpstream, acpControl } = input;
    const assertAcpControl = () => {
      if (acpControl && !readAcpSessionControlInWorker(database, acpControl).row) {
        throw new Error("ACP task owner could not be verified.");
      }
    };
    const current = (db: OpenClawStateDatabase["db"], event: SessionStateEventInput) =>
      (!onlyIfWatched || hasSessionStateWatchersInDatabase(db, event.sessionKey)) &&
      (!expectedUpstream || isSessionStateUpstreamCurrentInDatabase(db, expectedUpstream));
    // Unwatched human turns stay write-free; queued writes repeat the check under the lock.
    if (!events.some((event) => current(database.db, event))) {
      return { rows: [], notices: [] };
    }
    admit("transaction");
    return context.write(({ db }) => {
      assertAcpControl();
      const recorded = recordSessionStateEventsInDatabase(
        db,
        events.filter((event) => current(db, event)).map((event) => ({ event, now })),
      );
      admit("commit");
      assertAcpControl();
      return recorded;
    });
  },
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
