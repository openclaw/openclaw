import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly-open.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { iterateSessionColdRecords } from "./session-cold-storage-chunks.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { createToolUsageTranscriptAccumulator } from "./tool-usage-import.js";
import {
  emptyAgentToolUsageState,
  readAgentToolUsageInDatabase,
  readAgentToolUsageLiveRunsInDatabase,
} from "./tool-usage.kernel.js";
import type { AgentToolUsageImportReadInput, AgentToolUsageReadInput } from "./tool-usage.types.js";
import { readTranscriptPayload } from "./transcript-payload-read.js";

function scanAgentToolUsageInDatabase(
  { db, path }: OpenClawAgentReadOnlyDatabase,
  input: Pick<
    AgentToolUsageImportReadInput,
    "catalog" | "since" | "before" | "executingAgentId" | "previous"
  >,
  liveRuns: ReadonlySet<string>,
) {
  const accumulator = createToolUsageTranscriptAccumulator({
    ...input,
    liveRuns,
    liveSince: input.previous.liveSince,
    coveredWindows: input.previous.importedWindows,
  });
  if (input.since >= input.before) {
    return accumulator.result();
  }
  const sql = getNodeSqliteKysely<DB>(db);
  // The durable database never receives incognito windows; also honor explicit imported markers.
  let afterSession = "";
  while (true) {
    const sessions = executeSqliteQuerySync(
      db,
      sql
        .selectFrom("session_windows as window")
        .innerJoin("session_nodes as node", "node.session_key", "window.session_key")
        .select(["window.session_id", "window.session_key", "node.entry_json"])
        .where("window.session_id", ">", afterSession)
        .where((eb) =>
          eb.or([
            eb("window.updated_at", ">=", input.since),
            eb("window.transcript_updated_at", ">=", input.since),
          ]),
        )
        .orderBy("window.session_id")
        .limit(32),
    ).rows;
    if (!sessions.length) {
      break;
    }
    for (const session of sessions) {
      afterSession = session.session_id;
      if (
        resolveAgentIdFromSessionKey(session.session_key, input.executingAgentId) !==
        input.executingAgentId
      ) {
        continue;
      }
      if (asOptionalRecord(JSON.parse(session.entry_json))?.incognito === true) {
        accumulator.skipIncognito();
        continue;
      }
      const archive = readSessionColdTranscript(db, session.session_id);
      if (archive) {
        for (const record of iterateSessionColdRecords(db, path, archive)) {
          if (record.kind === "event") {
            accumulator.append(JSON.parse(record.row.event_json), record.row.created_at);
            accumulator.countColdEvent();
          }
        }
      }
      let afterSeq = archive?.last_seq ?? -1;
      while (true) {
        // Keep call declarations and fork headers even when their timestamps are outside the interval.
        const events = executeSqliteQuerySync(
          db,
          sql
            .selectFrom("transcript_events")
            .select(["seq", "created_at", "event_json", "event_zstd", "event_utf8_bytes"])
            .where("session_id", "=", session.session_id)
            .where("seq", ">", afterSeq)
            .orderBy("seq")
            .limit(16),
        ).rows;
        if (!events.length) {
          break;
        }
        for (const event of events) {
          afterSeq = event.seq;
          if (event.event_json === null && event.event_zstd === null) {
            throw new Error(
              `Tool usage import cannot read unarchived cold event ${session.session_id}:${event.seq}`,
            );
          } else {
            accumulator.append(JSON.parse(readTranscriptPayload(event)), event.created_at);
          }
        }
      }
      accumulator.finishSession();
    }
  }
  return accumulator.result();
}

export function readAgentToolUsageInWorker(input: AgentToolUsageReadInput) {
  const read = withOpenClawAgentDatabaseReadOnly(
    ({ db }) => runSqliteReadSnapshotSync(db, () => readAgentToolUsageInDatabase(db, input.now)),
    { ...input.database, env: input.env },
  );
  if (!read.found && read.reason !== "database-missing") {
    throw new Error(`Tool usage database unavailable: ${read.reason}`);
  }
  return {
    kind: input.kind,
    status: read.found ? read.value : { ...emptyAgentToolUsageState(), rows: [] },
  };
}

export function readAgentToolUsageImportInWorker(input: AgentToolUsageImportReadInput) {
  const receipts = withOpenClawAgentDatabaseReadOnly(
    ({ db }) => readAgentToolUsageLiveRunsInDatabase(db, input.before),
    { ...input.counterDatabase, env: input.env },
  );
  if (!receipts.found && receipts.reason !== "database-missing") {
    throw new Error(`Tool usage coverage unavailable: ${receipts.reason}`);
  }
  const liveRuns = receipts.found ? receipts.value : new Set<string>();
  for (const runId of input.activeRunIds ?? []) {
    liveRuns.add(runId);
  }
  const read = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteReadSnapshotSync(database.db, () =>
        scanAgentToolUsageInDatabase(database, input, liveRuns),
      ),
    { ...input.database, env: input.env },
  );
  if (!read.found && read.reason !== "database-missing") {
    throw new Error(`Tool usage import database unavailable: ${read.reason}`);
  }
  return {
    kind: input.kind,
    scan: read.found ? read.value : createToolUsageTranscriptAccumulator(input).result(),
  };
}
