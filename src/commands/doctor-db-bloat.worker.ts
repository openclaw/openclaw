import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { withSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import {
  runWithSqliteWorkerStateContext,
  type SqliteWorkerStateContext,
} from "../infra/sqlite-worker-state-context.js";
import { serveWorkerTasks } from "../infra/worker-task-server.js";
import { readSqliteDatabaseBloat } from "./doctor-db-bloat.read.js";

export type DoctorDatabaseBloatInput = {
  path: string;
  context: SqliteWorkerStateContext;
};
export type DoctorDatabaseBloatResult = Awaited<ReturnType<typeof readSqliteDatabaseBloat>>;

serveWorkerTasks<DoctorDatabaseBloatResult, DoctorDatabaseBloatInput>(
  (input, _channel, control) => {
    const inspect = () =>
      runWithSqliteWorkerStateContext(input.context, () =>
        withSqliteReadOnlyWorkerScope(
          () =>
            readSqliteDatabaseBloat({
              path: input.path,
              env: input.context.environment,
              signal: control.signal,
            }),
          { signal: control.signal, deadlineOwnedByCaller: true },
        ),
      );
    // Cancellation retains the worker until its snapshot children and private files close.
    return control.runNativeSection(() =>
      input.context.databaseEngineSelection
        ? withDatabaseEngineSelection(input.context.databaseEngineSelection, inspect)
        : inspect(),
    );
  },
);
