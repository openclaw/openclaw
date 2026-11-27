import { once } from "node:events";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { withSqliteDatabaseAdmissionExchange } from "../../infra/sqlite-database-admission-context.js";
import { exchangeSqliteDatabaseAdmissions } from "../../infra/sqlite-worker-database-admission-relay.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import type { SessionModelContextLimits } from "./session-history-read.types.js";
import type { TranscriptEntryAnchor, TranscriptTurnAdmission } from "./transcript-entry-anchor.js";

export type CompactedContextWorkerInput = {
  scope: SessionTranscriptReadScope;
  requests: Array<{
    limits: SessionModelContextLimits;
    through?: TranscriptEntryAnchor;
    admission?: TranscriptTurnAdmission;
  }>;
};
export type CompactedContextWorkerResult = Array<{ json: string; navigationRows: number }>;

// Observe work at the native cursor, including projection done for subsequently discarded rows.
let navigationRows = 0;
// oxlint-disable-next-line typescript/unbound-method -- Reflect.apply forwards each native database receiver.
DatabaseSync.prototype.prepare = new Proxy(DatabaseSync.prototype.prepare, {
  apply(prepare, database, parameters) {
    const statement: StatementSync = Reflect.apply(prepare, database, parameters);
    const iterate = statement.iterate.bind(statement);
    statement.iterate = function* (...bindings): ReturnType<typeof iterate> {
      const rows: ReturnType<typeof iterate> = Reflect.apply(iterate, statement, bindings);
      for (const row of rows) {
        navigationRows += Number("model_bytes" in row);
        yield row;
      }
    };
    return statement;
  },
});
const { readSessionTranscriptModelContext } =
  await import("./session-accessor.sqlite-model-context.js");
const { runWithSessionTranscriptReadFence } = await import("./session-transcript-read-fence.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../state/openclaw-state-db.js");
const { drainGlobalSingletonLifecycleState } = await import("../../shared/global-singleton.js");
const input = workerData as CompactedContextWorkerInput & { admissionPort: MessagePort };
try {
  await withSqliteDatabaseAdmissionExchange(
    (records, location, create, observed) =>
      exchangeSqliteDatabaseAdmissions(input.admissionPort, records, location, create, observed),
    async () => {
      for (const request of input.requests) {
        navigationRows = 0;
        const context = runWithSessionTranscriptReadFence(request.admission, () =>
          readSessionTranscriptModelContext(input.scope, request.through, request.limits),
        );
        const continued = once(parentPort!, "message");
        parentPort!.postMessage({ json: JSON.stringify(context), navigationRows }, []);
        await continued;
      }
    },
  );
} finally {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
  input.admissionPort.close();
  parentPort!.close();
}
