import { vi } from "vitest";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";

/** Lose the first signal receipt after its real worker transaction commits. */
export function loseSessionSignalAcknowledgement() {
  const run = stateWorker.runOpenClawStateWorkerOperation;
  let attempts = 0;
  const spy = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      run(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              const result = await scope.execute(command, executeOptions);
              if (command.type === "sessionState.record" && ++attempts === 1) {
                throw new SqliteWorkerError(
                  "Signal commit acknowledgement was lost",
                  "outcome-unknown",
                );
              }
              return result;
            },
          }),
        options,
      ),
    );
  return { attempts: () => attempts, restore: () => spy.mockRestore() };
}
