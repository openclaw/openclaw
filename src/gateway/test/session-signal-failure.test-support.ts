import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";

/** Lose the first signal receipt after its real worker transaction commits. */
export function loseSessionSignalAcknowledgement() {
  let attempts = 0;
  const spy = probe.command(stateWorker, async (command, executeOptions, scope) => {
    const result = await scope.execute(command, executeOptions);
    if (command.type === "sessionState.record" && ++attempts === 1) {
      throw new SqliteWorkerError("Signal commit acknowledgement was lost", "outcome-unknown");
    }
    return result;
  });
  return { attempts: () => attempts, restore: () => spy.mockRestore() };
}
