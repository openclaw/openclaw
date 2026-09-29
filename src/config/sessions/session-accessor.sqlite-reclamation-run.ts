import { isMainThread } from "node:worker_threads";
import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { getChildLogger } from "../../logging/logger.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  deferOpenClawAgentPostCommitPublication,
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import type {
  DeleteSessionEntryLifecycleParams,
  SqliteSessionReclamationDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import { prepareSessionDeletionInDatabase } from "./session-accessor.sqlite-deletion-plan.js";
import { hasPreparedNativeSessionDeletion } from "./session-accessor.sqlite-deletion.js";
import { assertSessionSubagentRunsCurrent } from "./session-accessor.sqlite-descendant-basis.js";
import { publishSessionEntryWorkerInvalidations } from "./session-accessor.sqlite-entry-cache-publication.js";
import type {
  SessionDeletionPlanningOperation,
  SessionDeletionPlanningResult,
  SessionMaintenanceLiveProtection,
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { withSqliteReclamationAuthorization } from "./session-accessor.sqlite-reclamation-commit.js";
import {
  collectReclamationChangedSessionKeys,
  prepareReclamationPublication,
} from "./session-accessor.sqlite-reclamation-publication.js";
import {
  withSqliteReclamationWorker,
  type SqliteReclamationClaim,
  type SqliteReclamationWorker,
} from "./session-accessor.sqlite-reclamation-worker.js";
import {
  reclaimSqliteSessionInTransaction,
  resolveSessionReclamationDatabaseOptions,
} from "./session-accessor.sqlite-reclamation.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import {
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  withSqliteSessionDatabase,
  type resolveSqliteStoreScope,
} from "./session-accessor.sqlite-scope.js";
import {
  withSqliteMutationWorkerLifetime,
  type SqliteMutationWorkerValidationOwner,
} from "./session-accessor.sqlite-worker-request.js";

export async function runSessionDeletionPlanning(
  resolved: ReturnType<typeof resolveSqliteStoreScope>,
  params: DeleteSessionEntryLifecycleParams,
  planning: SessionDeletionPlanningOperation,
  assertCurrent: () => void,
  diagnostics?: SqliteSessionReclamationDiagnostics,
): Promise<SessionDeletionPlanningResult> {
  const databaseOptions = toDatabaseOptions(resolved);
  // Cross-store handoffs retain their original connection identity comparison.
  if (
    params.expectedDatabaseIdentity !== undefined ||
    !isMainThread ||
    !supportsOpenClawAgentDatabaseExecution(databaseOptions)
  ) {
    return await runExclusiveSqliteSessionWrite(
      resolved,
      async () =>
        withSqliteSessionDatabase(
          databaseOptions,
          (database) =>
            prepareSessionDeletionInDatabase(database, planning, params.expectedDatabaseIdentity),
          assertCurrent,
        ),
      planning.operation === "entry"
        ? "session.lifecycle.delete-prepare"
        : planning.operation === "history"
          ? "session.lifecycle.archive-plan"
          : "session.lifecycle.reclamation-plan",
      diagnostics,
    );
  }
  const result = await runSqliteSessionReclamation({
    diagnostics,
    assertCommitAllowed: assertCurrent,
    forceInProcess: hasPreparedNativeSessionDeletion(),
    plan: {
      kind: "deletion-plan",
      databaseOptions: resolveSessionReclamationDatabaseOptions(databaseOptions),
      materializedPlans: [],
      planning,
    },
  });
  if (result.kind !== "deletion-plan") {
    throw new Error(`SQLite session deletion planning returned ${result.kind}`);
  }
  return result.value;
}

export async function runSqliteSessionReclamation(params: {
  diagnostics?: SqliteSessionReclamationDiagnostics;
  assertCommitAllowed?: () => void;
  refreshMaintenanceProtection?: () => SessionMaintenanceLiveProtection;
  forceInProcess: boolean;
  onInProcessCommit?: (database: OpenClawAgentDatabase) => void;
  onWorkerResult?: (
    result: SqliteSessionReclamationResult,
    databaseIdentity: string | symbol,
  ) => void;
  plan: SqliteSessionReclamationPlan;
}): Promise<SqliteSessionReclamationResult> {
  if (params.diagnostics) {
    params.diagnostics.kind = params.plan.kind;
  }
  if (
    params.forceInProcess ||
    isIncognitoOpenClawAgentSqlitePath(params.plan.databaseOptions.path, {
      agentId: params.plan.databaseOptions.agentId,
      env: params.plan.databaseOptions.env,
    })
  ) {
    return await runExclusiveSqliteSessionWrite(
      params.plan.databaseOptions,
      async () => {
        if (params.plan.kind === "maintenance-plan") {
          Object.assign(params.plan.input, params.refreshMaintenanceProtection?.());
        }
        params.assertCommitAllowed?.();
        return await withSqliteSessionDatabase(
          params.plan.databaseOptions,
          () => {
            params.assertCommitAllowed?.();
            return reclaimSqliteSessionInTransaction(params.plan, {
              beforeMutation: params.assertCommitAllowed,
              onCommit: (database, result) => {
                params.assertCommitAllowed?.();
                assertSessionSubagentRunsCurrent(params.plan, params.plan.databaseOptions.env);
                const publish = prepareReclamationPublication(
                  params.plan,
                  readOpenClawAgentDatabaseIdentity(database).identity,
                  result,
                );
                if (publish) {
                  deferOpenClawAgentPostCommitPublication(database, publish);
                }
                params.onInProcessCommit?.(database);
              },
            });
          },
          params.assertCommitAllowed,
        );
      },
      "session.reclamation.in-process",
      params.diagnostics,
    );
  }
  return await withSqliteMutationWorkerLifetime(
    params.plan.databaseOptions,
    async ({ assertCurrent, commitGate, signal }) => {
      const assertRequestCurrent = () => {
        assertCurrent();
        params.assertCommitAllowed?.();
      };
      const runWorker = (
        claim: SqliteReclamationClaim,
        nativeLocation: string,
        validationOwner?: SqliteMutationWorkerValidationOwner,
      ) => {
        const plan = {
          ...params.plan,
          databaseOptions: { ...params.plan.databaseOptions, path: nativeLocation },
        };
        return withSqliteReclamationWorker(
          plan.databaseOptions,
          claim,
          async (worker) =>
            runPreparedSqliteSessionReclamation(
              { ...params, plan },
              {
                nativeLocation,
                validationOwner,
                claim,
                worker,
                assertRequestCurrent,
                commitGate,
                signal,
              },
            ),
          assertRequestCurrent,
          signal,
        );
      };
      const retained = await runExclusiveSqliteSessionWrite(
        params.plan.databaseOptions,
        async () => {
          assertRequestCurrent();
          const database = getOpenClawAgentDatabaseIfOpen(params.plan.databaseOptions);
          // Reuse an already-owned handle, but never open a host connection for reclamation.
          return database && !database.db.isTransaction
            ? retainOpenClawAgentDatabaseReadOnly(params.plan.databaseOptions)
            : undefined;
        },
        "session.reclamation.retain",
        undefined,
        "foreground",
        signal,
      );
      if (retained?.found) {
        const { database, claim } = retained;
        try {
          return await runWorker(claim, readOpenClawAgentDatabaseIdentity(database).filename, {
            database,
            isCurrent: claim.isCurrent,
          });
        } finally {
          claim.release();
        }
      }
      const execution = captureOpenClawAgentDatabaseExecution(params.plan.databaseOptions);
      try {
        // Existing-only native admission supplies the same authority without a cold host handle.
        const admitted = await withSessionEntryWorker(
          params.plan.databaseOptions,
          undefined,
          assertRequestCurrent,
          (owner, source) => owner.runExisting(source, async () => true),
          undefined,
          execution,
          signal,
        );
        const identity = execution.fileIdentity;
        if (!admitted || !identity) {
          throw new Error("SQLite session reclamation lost its prepared database");
        }
        const claim = execution.captureGenerationClaim();
        return await runWorker(claim, identity.nativeLocation, {
          source: { agentId: execution.agentId, path: identity.nativeLocation },
          claim,
        });
      } finally {
        await execution.release();
      }
    },
  );
}

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

async function runPreparedSqliteSessionReclamation(
  params: {
    diagnostics?: SqliteSessionReclamationDiagnostics;
    refreshMaintenanceProtection?: () => SessionMaintenanceLiveProtection;
    onWorkerResult?: (
      result: SqliteSessionReclamationResult,
      databaseIdentity: string | symbol,
    ) => void;
    plan: SqliteSessionReclamationPlan;
  },
  owner: {
    nativeLocation: string;
    validationOwner?: SqliteMutationWorkerValidationOwner;
    claim: SqliteReclamationClaim;
    worker: SqliteReclamationWorker;
    assertRequestCurrent: () => void;
    commitGate: SharedArrayBuffer;
    signal: AbortSignal;
  },
): Promise<SqliteSessionReclamationResult> {
  const { claim, worker, assertRequestCurrent, commitGate } = owner;
  const identity = claim.identity;
  if (typeof identity !== "string") {
    throw new Error("SQLite reclamation Worker requires an admitted file generation");
  }
  const { plan } = params;
  const assertCommitAllowed = () => {
    worker.assertCurrent(plan.databaseOptions, claim);
    assertRequestCurrent();
  };
  assertCommitAllowed();
  let publishCommitted: (() => void) | undefined;
  return await withSqliteReclamationAuthorization(
    commitGate,
    owner.nativeLocation,
    () => {
      assertCommitAllowed();
      // A blocked writer may authorize before the Worker's queued request.
      publishCommitted = prepareReclamationPublication(plan, identity);
    },
    (authorize) =>
      worker.run({
        claim,
        validationOwner: owner.validationOwner,
        commitGate,
        plan,
        diagnostics: params.diagnostics,
        onCommitRequest: authorize,
        withWriteAdmission: async (run, reclamationAdmission) =>
          await runExclusiveSqliteSessionWrite(
            plan.databaseOptions,
            async () => {
              let refusal: { error: unknown } | undefined;
              let maintenanceProtection: SessionMaintenanceLiveProtection | undefined;
              try {
                maintenanceProtection = params.refreshMaintenanceProtection?.();
                assertCommitAllowed();
              } catch (error) {
                refusal = { error };
              }
              const completed = await run(refusal, maintenanceProtection);
              if (completed) {
                // Publish captured identities after transaction settlement, before releasing the writer.
                const publishRemoval =
                  plan.kind === "maintenance-finalize" ||
                  plan.kind === "lifecycle-projection-commit"
                    ? prepareReclamationPublication(plan, identity, completed)
                    : publishCommitted;
                const removedSessionKeys =
                  completed.kind === "lifecycle-projection-commit"
                    ? completed.value.removedSessionKeys
                    : completed.kind === "maintenance-finalize"
                      ? completed.value.committedEntries.map(({ sessionKey }) => sessionKey)
                      : completed.kind === "entry" &&
                          plan.kind === "entry" &&
                          completed.value.deleted
                        ? plan.preparedTargetSnapshot.map(({ sessionKey }) => sessionKey)
                        : [];
                publishSessionEntryWorkerInvalidations(
                  {
                    agentId: plan.databaseOptions.agentId,
                    storePath: owner.nativeLocation,
                    databaseIdentity: identity,
                    removedSessionKeys: new Set(removedSessionKeys),
                  },
                  collectReclamationChangedSessionKeys(plan, completed),
                  () => {
                    params.onWorkerResult?.(completed, identity);
                    publishRemoval?.();
                  },
                );
                const database =
                  plan.kind === "maintenance-statistics"
                    ? getOpenClawAgentDatabaseIfOpen(plan.databaseOptions)
                    : undefined;
                if (database) {
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
}
