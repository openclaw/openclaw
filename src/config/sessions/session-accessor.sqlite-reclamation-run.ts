import { isMainThread } from "node:worker_threads";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { ownedWorkerBytes } from "../../infra/worker-transfer-bytes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { hasAgentDatabaseMaintenanceAuthority } from "../../state/openclaw-agent-db-lease.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { captureOpenClawAgentDatabaseValidationTransfer } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  deferOpenClawAgentPostCommitPublication,
  getOpenClawAgentDatabaseIfOpen,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  isOpenClawDatabaseMaintenanceWorkerAccess,
} from "../../state/openclaw-state-db-async-lifecycle.js";
import type {
  DeleteSessionEntryLifecycleParams,
  SqliteSessionReclamationDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import { prepareSessionDeletionInDatabase } from "./session-accessor.sqlite-deletion-plan.js";
import { captureNativeSessionWorkerDeletion } from "./session-accessor.sqlite-deletion.js";
import { publishSessionEntryWorkerInvalidations } from "./session-accessor.sqlite-entry-worker-publication.js";
import type {
  SessionDeletionPlanningOperation,
  SessionDeletionPlanningResult,
  SessionMaintenanceLiveProtection,
  SqliteArchiveReclamationPlan,
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  collectReclamationChangedSessionKeys,
  collectReclamationDeletionEntries,
  prepareReclamationPublication,
} from "./session-accessor.sqlite-reclamation-publication.js";
import type { SqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker-lifetime.js";
import { withSqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker.js";
import type { SqliteReclamationClaim } from "./session-accessor.sqlite-reclamation-worker.types.js";
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
import { publishSessionLifecycleWorkerEffects } from "./session-lifecycle-worker-publication.js";
import type { SessionMaintenancePreservationPlan } from "./store-maintenance-preserve-snapshot.types.js";

function hasNativeReclamationOwner(): boolean {
  return (
    !isMainThread ||
    (!isOpenClawDatabaseMaintenanceWorkerAccess() &&
      (getOpenClawDatabaseMaintenanceScope()?.ownsSchemaMaintenance === true ||
        hasAgentDatabaseMaintenanceAuthority()))
  );
}

export function runSessionDeletionPlanning<Planning extends SessionDeletionPlanningOperation>(
  resolved: ReturnType<typeof resolveSqliteStoreScope>,
  params: DeleteSessionEntryLifecycleParams,
  planning: Planning,
  assertCurrent: () => void,
  diagnostics?: SqliteSessionReclamationDiagnostics,
): Promise<Extract<SessionDeletionPlanningResult, { operation: Planning["operation"] }>>;
export async function runSessionDeletionPlanning(
  resolved: ReturnType<typeof resolveSqliteStoreScope>,
  params: DeleteSessionEntryLifecycleParams,
  planning: SessionDeletionPlanningOperation,
  assertCurrent: () => void,
  diagnostics?: SqliteSessionReclamationDiagnostics,
): Promise<SessionDeletionPlanningResult> {
  const databaseOptions = toDatabaseOptions(resolved);
  // Boot migration handoffs and maintenance owners retain native planning.
  if (params.expectedDatabaseIdentity !== undefined || hasNativeReclamationOwner()) {
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
  return withSessionEntryWorker(
    resolveSessionReclamationDatabaseOptions(databaseOptions),
    undefined,
    assertCurrent,
    async (execution, source) => {
      await execution.prepare(source);
      const result = await execution.runExisting(source, (worker) =>
        worker.execute({ type: "session.lifecycle.deletePlan", input: planning }),
      );
      assertCurrent();
      if (!result) {
        throw new Error("Session deletion planning lost its admitted database");
      }
      return result;
    },
  );
}

type SqliteSessionReclamationParams = {
  diagnostics?: SqliteSessionReclamationDiagnostics;
  assertCommitAllowed?: () => void;
  refreshMaintenanceProtection?: () => SessionMaintenanceLiveProtection;
  assertMaintenanceCommitAllowed?: (plans?: readonly SessionMaintenancePreservationPlan[]) => void;
  onInProcessCommit?: (database: OpenClawAgentDatabase) => void;
  onWorkerResult?: (
    result: SqliteSessionReclamationResult,
    databaseIdentity: string | symbol,
  ) => void;
  plan: SqliteSessionReclamationPlan;
};

type SqliteSessionReclamationReply<Kind extends SqliteSessionReclamationPlan["kind"]> = Extract<
  SqliteSessionReclamationResult,
  {
    kind:
      | Kind
      | (Kind extends "maintenance-plan" | "maintenance-age" ? "maintenance-plan-stale" : never);
  }
>;

export function runSqliteSessionReclamation<Plan extends SqliteSessionReclamationPlan>(
  params: Omit<SqliteSessionReclamationParams, "plan"> & { plan: Plan },
): Promise<SqliteSessionReclamationReply<Plan["kind"]>>;
export async function runSqliteSessionReclamation(
  params: SqliteSessionReclamationParams,
): Promise<SqliteSessionReclamationResult> {
  if (params.diagnostics) {
    params.diagnostics.kind = params.plan.kind;
  }
  // Doctor/migrations retain exclusive native ownership; worker callers cannot redispatch.
  const native = hasNativeReclamationOwner();
  if (
    !native &&
    (params.plan.kind === "entry" ||
      params.plan.kind === "lifecycle-artifacts" ||
      params.plan.kind === "maintenance-finalize" ||
      params.plan.kind === "lifecycle-projection-commit")
  ) {
    const participants = captureNativeSessionWorkerDeletion(
      collectReclamationDeletionEntries(params.plan),
    );
    if (participants) {
      const { deleteSessionWithNativeBindingsInWorker } =
        await import("./session-native-binding.js");
      return deleteSessionWithNativeBindingsInWorker(
        params.plan,
        participants,
        () => params.assertCommitAllowed?.(),
        params.onWorkerResult,
      );
    }
  }
  if (native) {
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
              beforeMutation() {
                params.assertCommitAllowed?.();
                if (params.plan.kind === "maintenance-plan") {
                  params.assertMaintenanceCommitAllowed?.();
                }
              },
              onCommit: (database, result) => {
                // The native connection now sees its own removals; row guards ran before mutation.
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
  const maintenanceIdentity =
    params.plan.kind === "maintenance-plan"
      ? readDatabasePathIdentitySync(params.plan.databaseOptions.path)
      : undefined;
  return await withSqliteMutationWorkerLifetime(
    params.plan.databaseOptions,
    async ({ assertCurrent, signal }) => {
      const assertRequestCurrent = () => {
        assertCurrent();
        params.assertCommitAllowed?.();
        if (maintenanceIdentity) {
          assertExistingDatabaseIdentity(
            params.plan.databaseOptions.path,
            maintenanceIdentity.key,
            maintenanceIdentity.birthtime,
          );
        }
      };
      const runWorker = async (
        claim: SqliteReclamationClaim,
        nativeLocation: string,
        validationOwner?: SqliteMutationWorkerValidationOwner,
      ) => {
        const plan = {
          ...params.plan,
          databaseOptions: { ...params.plan.databaseOptions, path: nativeLocation },
        };
        if (
          plan.kind === "maintenance-plan" ||
          plan.kind === "maintenance-statistics" ||
          plan.kind === "maintenance-age"
        ) {
          const { runSessionMaintenanceMetadataInWorker } =
            await import("./session-accessor.sqlite-maintenance-worker.js");
          return await runSessionMaintenanceMetadataInWorker({
            plan,
            claim,
            refreshMaintenanceProtection: params.refreshMaintenanceProtection,
            assertMaintenanceCommitAllowed: params.assertMaintenanceCommitAllowed,
            assertCurrent: () => {
              assertRequestCurrent();
              claim.assertCurrent();
            },
            signal,
            diagnostics: params.diagnostics,
            onWorkerResult: params.onWorkerResult,
          });
        }
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
                signal,
              },
            ),
          assertRequestCurrent,
          signal,
          params.plan.databaseOptions.path,
        );
      };
      // Metadata uses its worker's generation claim, not a host read admission.
      const retained =
        params.plan.kind === "maintenance-plan" ||
        params.plan.kind === "maintenance-statistics" ||
        params.plan.kind === "maintenance-age"
          ? undefined
          : await runExclusiveSqliteSessionWrite(
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
      const plan = params.plan;
      const execution = captureOpenClawAgentDatabaseExecution(
        plan.databaseOptions,
        maintenanceIdentity?.key.startsWith("file:")
          ? {
              expectedIdentity: {
                kind: "file",
                physicalIdentity: maintenanceIdentity.key.slice(5),
                birthtime: maintenanceIdentity.birthtime,
                nativeLocation: maintenanceIdentity.canonicalPath,
              },
            }
          : undefined,
      );
      try {
        if (
          plan.kind === "maintenance-plan" ||
          plan.kind === "maintenance-statistics" ||
          plan.kind === "maintenance-age"
        ) {
          // Metadata keeps its existing executor; archive preparation uses the reclaimer below.
          const admitted = await withSessionEntryWorker(
            plan.databaseOptions,
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
        }
        // Capture an opening expectation, never a substitute native claim. The existing
        // reclamation actor performs its own validation without occupying the foreground opener.
        const original = execution.fileIdentity;
        const observed = readDatabasePathIdentitySync(plan.databaseOptions.path);
        const expectedSource = Object.freeze(
          original
            ? {
                key: `file:${original.physicalIdentity}`,
                canonicalPath: original.nativeLocation,
                ...(original.birthtime === undefined ? {} : { birthtime: original.birthtime }),
              }
            : { key: observed.key, canonicalPath: observed.canonicalPath },
        );
        const databaseOptions = {
          ...plan.databaseOptions,
          path: expectedSource.canonicalPath,
        };
        const assertOpeningCurrent = () => {
          assertRequestCurrent();
          execution.assertCurrent();
        };
        return await withSqliteReclamationWorker(
          databaseOptions,
          expectedSource,
          async (worker) => {
            const validationSource = { agentId: execution.agentId, path: databaseOptions.path };
            const receiveValidation =
              captureOpenClawAgentDatabaseValidationTransfer(validationSource);
            const prepared = await worker.prepare({
              plan,
              diagnostics: params.diagnostics,
              expectedSource,
              assertCurrent: assertOpeningCurrent,
              withWriteAdmission: (run, diagnostics) =>
                runExclusiveSqliteSessionWrite(
                  databaseOptions,
                  async () => {
                    let refusal: { error: unknown } | undefined;
                    try {
                      assertOpeningCurrent();
                    } catch (error) {
                      refusal = { error };
                    }
                    await run(refusal);
                  },
                  "session.reclamation.prepare",
                  { ...params.diagnostics, reclamationAdmission: diagnostics },
                  "worker",
                  signal,
                ),
            });
            assertOpeningCurrent();
            prepared.claim.assertCurrent();
            receiveValidation(prepared.claim.identity, prepared.validation);
            return runPreparedSqliteSessionReclamation(
              { ...params, plan: { ...plan, databaseOptions } },
              {
                nativeLocation: prepared.source.filename,
                claim: prepared.claim,
                validationOwner: { source: validationSource, claim: prepared.claim },
                worker,
                assertRequestCurrent: assertOpeningCurrent,
                signal,
              },
            );
          },
          assertOpeningCurrent,
          signal,
          params.plan.databaseOptions.path,
        );
      } finally {
        await execution.release();
      }
    },
  );
}

function prepareReclamationWorkerTransferList(plan: SqliteArchiveReclamationPlan): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const materializedPlan of plan.materializedPlans) {
    const archive = materializedPlan.archive;
    if (!archive) {
      continue;
    }
    const bytes = ownedWorkerBytes(archive.bytes);
    materializedPlan.archive = { ...archive, bytes };
    buffers.add(bytes.buffer);
  }
  return [...buffers];
}

async function runPreparedSqliteSessionReclamation(
  params: {
    diagnostics?: SqliteSessionReclamationDiagnostics;
    onWorkerResult?: (
      result: SqliteSessionReclamationResult,
      databaseIdentity: string | symbol,
    ) => void;
    plan: SqliteArchiveReclamationPlan;
  },
  owner: {
    nativeLocation: string;
    validationOwner?: SqliteMutationWorkerValidationOwner;
    claim: SqliteReclamationClaim;
    worker: SqliteReclamationWorker;
    assertRequestCurrent: () => void;
    signal: AbortSignal;
  },
): Promise<SqliteSessionReclamationResult> {
  const { claim, worker, assertRequestCurrent } = owner;
  const identity = claim.identity;
  const { plan } = params;
  const assertCommitAllowed = () => {
    worker.assertCurrent(plan.databaseOptions, claim);
    assertRequestCurrent();
  };
  assertCommitAllowed();
  return await worker.run({
    claim,
    validationOwner: owner.validationOwner,
    plan,
    diagnostics: params.diagnostics,
    withWriteAdmission: async (run, reclamationAdmission) =>
      await runExclusiveSqliteSessionWrite(
        plan.databaseOptions,
        async () => {
          let refusal: { error: unknown } | undefined;
          let publishCommitted: (() => void) | undefined;
          try {
            assertCommitAllowed();
            publishCommitted = prepareReclamationPublication(plan, identity);
          } catch (error) {
            refusal = { error };
          }
          const completed = await run(refusal);
          if (completed) {
            // Publish captured identities after transaction settlement, before releasing the writer.
            const publishRemoval =
              plan.kind === "maintenance-finalize" || plan.kind === "lifecycle-projection-commit"
                ? prepareReclamationPublication(plan, identity, completed)
                : publishCommitted;
            const removedSessionKeys =
              completed.kind === "lifecycle-projection-commit"
                ? completed.value.removedSessionKeys
                : completed.kind === "maintenance-finalize"
                  ? collectReclamationChangedSessionKeys(plan, completed)
                  : completed.kind === "entry" && plan.kind === "entry" && completed.value.deleted
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
                publishSessionLifecycleWorkerEffects(plan, completed);
                publishRemoval?.();
              },
            );
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
  });
}
