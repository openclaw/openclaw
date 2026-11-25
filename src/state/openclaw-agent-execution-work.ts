import { formatErrorMessage } from "../infra/errors.js";
import { notifyListeners } from "../shared/listeners.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "./agent-database-admission-error.js";

/** The executor keeps accepted work until its borrower or resource close joins settlement. */
export function createAgentDatabaseAcceptedWork() {
  const pending = new Map<
    Promise<unknown>,
    { borrower: symbol; queuedReadAbort?: AbortController }
  >();
  const terminalListeners = new Set<(reason: Error) => void>();
  return {
    pending,
    onTerminal: (listener: (reason: Error) => void) => {
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
    },
    reportTerminal: (error: unknown) => {
      if (terminalListeners.size === 0) {
        return;
      }
      const reason = error instanceof Error ? error : new Error(formatErrorMessage(error));
      const listeners = [...terminalListeners];
      terminalListeners.clear();
      // Never join this notification from close/run: accepted work must settle first.
      void Promise.resolve().then(async () => {
        await Promise.allSettled(pending.keys());
        notifyListeners(listeners, reason);
      });
    },
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
