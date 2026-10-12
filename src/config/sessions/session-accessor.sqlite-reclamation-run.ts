import { isMainThread } from "node:worker_threads";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { ownedWorkerBytes } from "../../infra/worker-transfer-bytes.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { hasAgentDatabaseMaintenanceAuthority } from "../../state/openclaw-agent-db-lease.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { captureOpenClawAgentDatabaseValidationTransfer } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  deferOpenClawAgentPostCommitPublication,
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import type {
  DeleteSessionEntryLifecycleParams,
  SqliteSessionReclamationDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import { prepareSessionDeletionInDatabase } from "./session-accessor.sqlite-deletion-plan.js";
import {
  captureNativeSessionWorkerDeletion,
  preparedSessionDeletionRequiresNativeTransaction,
} from "./session-accessor.sqlite-deletion.js";
import { assertSessionSubagentRunsCurrent } from "./session-accessor.sqlite-descendant-basis.js";
import { publishSessionEntryWorkerInvalidations } from "./session-accessor.sqlite-entry-worker-publication.js";
import type {
  SessionDeletionPlanningOperation,
  SessionDeletionPlanningResult,
  SessionMaintenanceLiveProtection,
  SessionMaintenanceReadResult,
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
import { SessionEntryChangedDuringReadError } from "./session-entry-read-errors.js";
import { captureSessionEntryNativeMutationWitness } from "./session-entry-read-ordered.js";
import { publishSessionLifecycleWorkerEffects } from "./session-lifecycle-worker-publication.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

function hasNativeReclamationOwner(options: OpenClawAgentDatabaseOptions): boolean {
  return (
    !isMainThread ||
    getOpenClawDatabaseMaintenanceScope()?.ownsSchemaMaintenance === true ||
    hasAgentDatabaseMaintenanceAuthority() ||
    isIncognitoOpenClawAgentSqlitePath(resolveOpenClawAgentSqlitePath(options), options)
  );
}

export async function runSessionDeletionPlanning(
  resolved: ReturnType<typeof resolveSqliteStoreScope>,
  params: DeleteSessionEntryLifecycleParams,
  planning: SessionDeletionPlanningOperation,
  assertCurrent: () => void,
  diagnostics?: SqliteSessionReclamationDiagnostics,
): Promise<SessionDeletionPlanningResult> {
  const databaseOptions = toDatabaseOptions(resolved);
  // Boot migration handoffs and the remaining incognito owner retain native planning.
  if (
    preparedSessionDeletionRequiresNativeTransaction() ||
    params.expectedDatabaseIdentity !== undefined ||
    hasNativeReclamationOwner(databaseOptions)
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
    forceInProcess: false,
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
  consumeReadOnlyMaintenancePlan?: (
    result: Extract<SessionMaintenanceReadResult, { kind: "maintenance-plan" }>,
    assertCurrent: () => void,
  ) => void;
  /** @deprecated Native transactions are selected by the incognito or maintenance owner. */
  forceInProcess?: boolean;
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
  // Doctor/migrations retain exclusive native ownership; worker callers cannot redispatch.
  const native = hasNativeReclamationOwner(params.plan.databaseOptions);
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
              beforeMutation: params.assertCommitAllowed,
              onCommit: (database, result) => {
                // The native connection now sees its own removals; row guards ran before mutation.
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
  const maintenanceReadIdentity =
    params.plan.kind === "maintenance-plan" ||
    (params.plan.kind === "maintenance-age" && params.plan.readOnly)
      ? readDatabasePathIdentitySync(params.plan.databaseOptions.path)
      : undefined;
  return await withSqliteMutationWorkerLifetime(
    params.plan.databaseOptions,
    async ({ assertCurrent, signal }) => {
      const assertRequestCurrent = () => {
        assertCurrent();
        params.assertCommitAllowed?.();
        if (maintenanceReadIdentity) {
          assertExistingDatabaseIdentity(
            params.plan.databaseOptions.path,
            maintenanceReadIdentity.key,
            maintenanceReadIdentity.birthtime,
          );
        }
      };
      const readPlan = params.plan;
      if (
        readPlan.kind === "maintenance-plan" ||
        (readPlan.kind === "maintenance-age" && readPlan.readOnly)
      ) {
        const options = readPlan.databaseOptions;
        const source = {
          agentId: normalizeAgentId(options.agentId),
          path: options.path,
          env: options.env,
        };
        const identity = maintenanceReadIdentity;
        if (!identity) {
          throw new Error("Maintenance read omitted its original physical source");
        }
        const execution = identity.key.startsWith("file:")
          ? captureOpenClawAgentDatabaseExecution(options, {
              expectedIdentity: {
                kind: "file",
                physicalIdentity: identity.key.slice(5),
                birthtime: identity.birthtime,
                nativeLocation: identity.canonicalPath,
              },
            })
          : undefined;
        try {
          const preparedClaim = execution?.capturePreparedGenerationClaim();
          const result = await runExclusiveSqliteSessionWrite(
            options,
            async () => {
              assertRequestCurrent();
              if (readPlan.kind === "maintenance-plan") {
                Object.assign(readPlan.input, params.refreshMaintenanceProtection?.());
              }
              const assertNativeCurrent = captureSessionEntryNativeMutationWitness([source]);
              const consume = (reply: {
                workerThreadId: number;
                result: SessionMaintenanceReadResult;
              }) => {
                assertRequestCurrent();
                if (params.diagnostics) {
                  params.diagnostics.workerThreadId = reply.workerThreadId;
                }
                let readResult = reply.result;
                try {
                  assertNativeCurrent();
                } catch (error) {
                  if (!(error instanceof SessionEntryChangedDuringReadError)) {
                    throw error;
                  }
                  readResult = { kind: "maintenance-plan-stale" };
                }
                if (readResult.kind !== "maintenance-write-required") {
                  params.onWorkerResult?.(readResult, identity.key.slice(5));
                }
                if (
                  readResult.kind === "maintenance-plan" &&
                  params.consumeReadOnlyMaintenancePlan
                ) {
                  let consuming = true;
                  const assertConsumptionCurrent = () => {
                    if (!consuming) {
                      throw new Error("Session maintenance consumption has ended");
                    }
                    assertRequestCurrent();
                    assertNativeCurrent();
                  };
                  try {
                    assertConsumptionCurrent();
                    const value = params.consumeReadOnlyMaintenancePlan(
                      readResult,
                      assertConsumptionCurrent,
                    );
                    if (isPromiseLike(value)) {
                      void Promise.resolve(value).catch(() => {});
                      throw new Error("Session maintenance consumers must remain synchronous");
                    }
                    assertConsumptionCurrent();
                  } catch (error) {
                    if (!(error instanceof SessionEntryChangedDuringReadError)) {
                      throw error;
                    }
                    readResult = { kind: "maintenance-plan-stale" };
                  } finally {
                    consuming = false;
                  }
                }
                return readResult;
              };
              if (execution && preparedClaim) {
                return withSessionEntryWorker(
                  options,
                  identity.key.slice(5),
                  () => {
                    assertRequestCurrent();
                    preparedClaim.assertCurrent();
                  },
                  (owner, authority) =>
                    owner
                      .runExisting(authority, async (worker) =>
                        consume(
                          await worker.execute(
                            {
                              type: "session.maintenance.read",
                              input: { ...readPlan, expectedIdentity: identity },
                            },
                            { signal },
                          ),
                        ),
                      )
                      .then((value) => {
                        if (!value) {
                          throw new Error("Maintenance lost its prepared reader");
                        }
                        return value;
                      }),
                  undefined,
                  execution,
                  signal,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  "prepared-read",
                );
              }
              return withSessionHistoryWorkerDatabase(source, async (reader) => {
                const reply = await reader.readSessionMaintenance(
                  { env: options.env, plan: { ...readPlan, expectedIdentity: identity } },
                  signal,
                );
                reader.assertCurrent();
                return consume(reply);
              });
            },
            "session.maintenance.plan",
            params.diagnostics,
            "foreground",
            signal,
          );
          if (result.kind !== "maintenance-write-required") {
            return result;
          }
        } finally {
          await execution?.release();
        }
      }
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
      const retained = await runExclusiveSqliteSessionWrite(
        params.plan.databaseOptions,
        async () => {
          assertRequestCurrent();
          if (
            params.plan.kind === "maintenance-plan" ||
            params.plan.kind === "maintenance-statistics" ||
            params.plan.kind === "maintenance-age"
          ) {
            // Metadata uses its worker's generation claim, not a host read admission.
            return undefined;
          }
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
        maintenanceReadIdentity?.key.startsWith("file:")
          ? {
              expectedIdentity: {
                kind: "file",
                physicalIdentity: maintenanceReadIdentity.key.slice(5),
                birthtime: maintenanceReadIdentity.birthtime,
                nativeLocation: maintenanceReadIdentity.canonicalPath,
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
  if (typeof identity !== "string") {
    throw new Error("SQLite reclamation Worker requires an admitted file generation");
  }
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
