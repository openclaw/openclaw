import {
  deferSqlitePostCommitPublication,
  withSqlitePostCommitPublications,
} from "../../infra/sqlite-post-commit.js";
import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import type {
  SqliteArchiveReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { withSqliteReclamationAuthorization } from "./session-accessor.sqlite-reclamation-commit.js";
import {
  collectReclamationChangedSessionKeys,
  prepareReclamationPublication,
} from "./session-accessor.sqlite-reclamation-publication.js";
import type { SqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";

function prepareReclamationWorkerTransferList(plan: SqliteArchiveReclamationPlan): ArrayBuffer[] {
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
    onWorkerResult?: (
      result: SqliteSessionReclamationResult,
      databaseIdentity: string | symbol,
    ) => void;
    plan: SqliteArchiveReclamationPlan;
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
        publishCommitted = prepareReclamationPublication(plan, claim.identity);
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
                  params.onWorkerResult?.(completed, claim.identity);
                  withSqlitePostCommitPublications(database.db, () => {
                    const publishRemoval =
                      plan.kind === "maintenance-finalize"
                        ? prepareReclamationPublication(plan, claim.identity, completed)
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
  return await runAuthorized();
}
