import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createSqliteWorkerBackend as createCanonicalBackend } from "../state/openclaw-state.worker.js";
import { getSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

/** Exercise canonical actor retirement with real native reader and transaction faults. */
export function createSqliteWorkerBackend(input: undefined, context: { databasePath: string }) {
  const backend = createCanonicalBackend(input, context);
  const { db } = openOpenClawStateDatabase({
    path: context.databasePath,
    env: getSqliteWorkerStateContext().environment,
  });
  let reader: Iterator<unknown> | undefined;
  let unsettleInspection = false;
  return {
    ...backend,
    execute(command: Parameters<typeof backend.execute>[0]) {
      if (command.type === "database.inspectIdle" && unsettleInspection) {
        db.exec("BEGIN");
      }
      const result = backend.execute(command);
      if (command.type === "deviceIdentity.read") {
        unsettleInspection = command.input.identityKey === "idle-fixture:unsettled-inspection";
        if (command.input.identityKey === "idle-fixture:local-reader" && !reader) {
          reader = db.prepare("SELECT name FROM sqlite_schema").iterate();
          reader.next();
        }
      }
      return result;
    },
  };
}
