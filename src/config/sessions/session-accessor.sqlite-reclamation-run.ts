import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import {
  deferSqlitePostCommitPublication,
  withSqlitePostCommitPublications,
} from "../../infra/sqlite-post-commit.js";
import { getChildLogger } from "../../logging/logger.js";
import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import type {
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { withSqliteReclamationAuthorization } from "./session-accessor.sqlite-reclamation-commit.js";
import {
  collectReclamationChangedSessionKeys,
  prepareReclamationPublication,
} from "./session-accessor.sqlite-reclamation-publication.js";
import type { SqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";

function prepareReclamationWorkerTransferList(plan: SqliteSessionReclamationPlan): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const materializedPlan of plan.materializedPlans) {
    const archive = materializedPlan.archive;
    if (!archive) {
      continue;
    }
    const bytes = archive.bytes;
    let owned = bytes;
    let buffer: ArrayBuffer;
    if (
      bytes.buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength
    ) {
      buffer = bytes.buffer;
    } else {
      buffer = new ArrayBuffer(bytes.byteLength);
      owned = new Uint8Array(buffer);
      owned.set(bytes);
    }
    materializedPlan.archive = { ...archive, bytes: owned };
    buffers.add(buffer);
  }
  return [...buffers];
}

export async function runPreparedSqliteSessionReclamation(
  params: {
    diagnostics?: SqliteSessionReclamationDiagnostics;
    onWorkerResult?: (result: SqliteSessionReclamationResult) => void;
    plan: SqliteSessionReclamationPlan;
  },
  owner: {
    database: OpenClawAgentReadOnlyDatabase;
    claim: OpenClawAgentDatabaseClaim;
    worker: SqliteReclamationWorker;
    assertRequestCurrent: () => void;
    commitGate: SharedArrayBuffer;
    signal: AbortSignal;
  },
): Promise<SqliteSessionReclamationResult> {
  const { database, claim, worker, assertRequestCurrent, commitGate } = owner;
  const { plan } = params;
  const assertCommitAllowed = () => {
    worker.assertCurrent(plan.databaseOptions, claim);
    assertRequestCurrent();
  };
  assertCommitAllowed();
  let publishCommitted: (() => void) | undefined;
  const runAuthorized = () =>
    withSqliteReclamationAuthorization(
      commitGate,
      database.db,
      () => {
        assertCommitAllowed();
        // A blocked writer may authorize before the Worker's queued request.
        publishCommitted = prepareReclamationPublication(plan);
      },
      (authorize) =>
        worker.run({
          claim,
          validationOwner: { database, isCurrent: claim.isCurrent },
          commitGate,
          plan,
          diagnostics: params.diagnostics,
          onCommitRequest: authorize,
          withWriteAdmission: async (run, reclamationAdmission) =>
            await runExclusiveSqliteSessionWrite(
              plan.databaseOptions,
              async () => {
                let refusal: { error: unknown } | undefined;
                try {
                  assertCommitAllowed();
                } catch (error) {
                  refusal = { error };
                }
                const completed = await run(refusal);
                if (completed) {
                  // Publish captured identities after transaction settlement, before releasing the writer.
                  params.onWorkerResult?.(completed);
                  withSqlitePostCommitPublications(database.db, () => {
                    const publishRemoval =
                      plan.kind === "maintenance-finalize"
                        ? prepareReclamationPublication(plan, completed)
                        : publishCommitted;
                    if (publishRemoval) {
                      deferSqlitePostCommitPublication(database.db, publishRemoval);
                    }
                    // Clear parent caches before identity observers, then notify row
                    // listeners so a recreated key cannot precede its old deletion.
                    for (const sessionKey of new Set(
                      collectReclamationChangedSessionKeys(plan, completed),
                    )) {
                      publishSessionEntryCacheInvalidation(database, { sessionKey });
                    }
                  });
                  if (
                    plan.kind === "maintenance-statistics" &&
                    getOpenClawAgentDatabaseIfOpen(plan.databaseOptions)?.db === database.db
                  ) {
                    try {
                      assertCommitAllowed();
                      runWithSqliteBusyTimeout(database.db, 0, () => {
                        // sqlite-allow-raw -- Reload this connection's committed planner metadata without scanning tables.
                        database.db.exec("ANALYZE sqlite_schema;");
                      });
                    } catch (error) {
                      // The Worker already committed. Parent refresh failure must not
                      // reject durable success or retire its settled Worker as uncertain.
                      try {
                        getChildLogger({ subsystem: "session-sqlite" }).warn(
                          "Committed SQLite session statistics could not refresh parent planner metadata",
                          { agentId: database.agentId, error, path: database.path },
                        );
                      } catch {
                        // Diagnostic transport failure cannot undo the committed result.
                      }
                    }
                  }
                }
              },
              "session.reclamation.worker-commit",
              { ...params.diagnostics, reclamationAdmission },
              "worker",
              owner.signal,
            ).catch((error: unknown) => {
              // Queue cancellation must retain the domain owner's more specific
              // claim/authority refusal, just like an admitted callback does.
              if (owner.signal.aborted) {
                assertCommitAllowed();
              }
              throw error;
            }),
          transferList: prepareReclamationWorkerTransferList(plan),
        }),
    );
  // Finalization retains its logical FIFO place across cold validation.
  // Acquire here, after the archive FIFO, so earlier worker work can settle.
  return plan.kind === "maintenance-finalize"
    ? await runExclusiveSqliteSessionWrite(
        plan.databaseOptions,
        runAuthorized,
        "session.maintenance.finalize",
        params.diagnostics,
        "foreground",
        owner.signal,
      )
    : await runAuthorized();
}
