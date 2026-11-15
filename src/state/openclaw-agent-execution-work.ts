import { AgentDatabaseExecutionAdmissionClosedError } from "./agent-database-admission-error.js";

/** The executor keeps accepted work until its borrower or resource close joins settlement. */
export function createAgentDatabaseAcceptedWork() {
  const pending = new Map<
    Promise<unknown>,
    { borrower: symbol; queuedReadAbort?: AbortController }
  >();
  return {
    pending,
    settleBorrower: (borrower: symbol) =>
      Promise.allSettled(
        [...pending].flatMap(([work, owner]) => (owner.borrower === borrower ? [work] : [])),
      ),
    cancelReadAdmissions: (borrower?: symbol) => {
      for (const work of pending.values()) {
        if (borrower === undefined || work.borrower === borrower) {
          work.queuedReadAbort?.abort(
            new AgentDatabaseExecutionAdmissionClosedError(
              "Agent database read admission is closed",
            ),
          );
        }
      }
    },
    closeAccepted: async (close: () => Promise<void>) => {
      const reads = [...pending].flatMap(([work, owner]) => (owner.queuedReadAbort ? [work] : []));
      // A default prepare may await this close during backoff; native close owns its settlement.
      const nativeClose = close();
      await Promise.allSettled([nativeClose, ...reads]);
      await nativeClose;
    },
  };
}
