import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  createCommittedWorkerMutation,
  type WorkerWriteOperationContext,
  type WorkerOperationHandlers,
} from "../state/worker-operation-registry.js";
import { chunkItems } from "../utils/chunk-items.js";
import type { GeneratedHtmlProvenanceRow } from "./generated-html-provenance.worker-contract.js";

type ProvenanceDatabase = Pick<DB, "outbound_media_provenance">;

export const generatedHtmlProvenanceReadOperations = {
  "generatedHtmlProvenance.read": (realpath: string, db) => {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<ProvenanceDatabase>(db)
        .selectFrom("outbound_media_provenance")
        .select(["kind", "version", "sha256", "size_bytes"])
        .where("realpath", "=", realpath),
    );
    return {
      type: "generatedHtmlProvenance.read" as const,
      marker:
        row?.kind === "trusted-generated-html" && row.version === 1
          ? { sha256: row.sha256, size: row.size_bytes }
          : undefined,
    };
  },
  "generatedHtmlProvenance.list": (_input: undefined, db) => ({
    type: "generatedHtmlProvenance.list" as const,
    rows: executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<ProvenanceDatabase>(db)
        .selectFrom("outbound_media_provenance")
        .selectAll(),
    ).rows,
  }),
} satisfies WorkerOperationHandlers<EngineConnection>;

export const generatedHtmlProvenanceOperations = {
  "generatedHtmlProvenance.upsert": createCommittedWorkerMutation(
    "generatedHtmlProvenance.upsert",
    (db, row: GeneratedHtmlProvenanceRow) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<ProvenanceDatabase>(db)
          .insertInto("outbound_media_provenance")
          .values(row)
          .onConflict((conflict) => conflict.column("realpath").doUpdateSet(row)),
      );
      return 1;
    },
  ),
  "generatedHtmlProvenance.prune": createCommittedWorkerMutation(
    "generatedHtmlProvenance.prune",
    (db, rows: GeneratedHtmlProvenanceRow[]) => {
      let removed = 0;
      // Inspect files before admission; transaction-local predicates preserve a newer marker.
      for (const batch of chunkItems(rows, 100)) {
        const result = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<ProvenanceDatabase>(db)
            .deleteFrom("outbound_media_provenance")
            .where((eb) =>
              eb.or(
                batch.map((row) =>
                  eb.and({
                    realpath: row.realpath,
                    kind: row.kind,
                    version: row.version,
                    sha256: row.sha256,
                    size_bytes: row.size_bytes,
                    created_at_ms: row.created_at_ms,
                  }),
                ),
              ),
            ),
        );
        removed += Number(result.numAffectedRows ?? 0);
      }
      return removed;
    },
  ),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
