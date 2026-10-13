import { setTimeout as delay } from "node:timers/promises";
import { isGatewayExternallySupervised } from "../../infra/gateway-supervision.js";
import { runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseValidation,
  getOpenClawAgentDatabaseValidationForTransfer,
  captureOpenClawAgentDatabaseValidationTransfer,
  hasOpenClawAgentCanonicalValidation,
  markOpenClawAgentCanonicalValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import {
  resolveOpenClawStateDirForDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "../../state/openclaw-state-db.paths.js";
import type { SqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker-lifetime.js";
import {
  withSqliteReclamationWorker,
  type ClaimedReclamationWorkerUse,
} from "./session-accessor.sqlite-reclamation-worker.js";
import type { SqliteReclamationClaim } from "./session-accessor.sqlite-reclamation-worker.types.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import {
  withSqliteMutationWorkerLifetime,
  type SqliteMutationWorkerValidationOwner,
} from "./session-accessor.sqlite-worker-request.js";
import type { PendingCanonicalValidation } from "./session-canonical-validation-deferral.js";
import { hasPendingCanonicalSessionValidation } from "./session-canonical-validation.js";

const MAX_BATCH_ROWS = 128;
const MAX_BATCH_BYTES = 1024 * 1024;
const CONTENTION_BACKOFF_MS = [0, 25, 100, 250] as const;
const log = createSubsystemLogger("sessions/canonical-validation");
// Share only active runtime drains; native close/reopen creates a different owner.
const runtimeDrains = new Map<string, Promise<void>>();

/** Runtime consumes captured pending work; startup and Doctor retain their native readiness probe. */
export async function certifySessionCanonicalValidationPending(
  options: OpenClawAgentDatabaseOptions | PendingCanonicalValidation,
  withWorker: ClaimedReclamationWorkerUse = withSqliteReclamationWorker,
  assertCurrentOwner?: () => void,
): Promise<void> {
  const pending = "source" in options ? options : undefined;
  const assertOwnerCurrent = () => {
    assertCurrentOwner?.();
    pending?.assertStateCurrent();
  };
  assertOwnerCurrent();
  const sourceEnv = options.env ?? process.env;
  const pathname = resolveOpenClawAgentSqlitePath(options);
  if (isIncognitoOpenClawAgentSqlitePath(pathname, options)) {
    return;
  }
  // Startup and Doctor own their native probe. Runtime already discovered pending
  // work and captured its physical source in the same synchronous read frame.
  const retained = pending ? undefined : retainOpenClawAgentDatabaseReadOnly(options);
  if (!pending && !retained?.found) {
    return;
  }
  const native = retained?.found ? retained : undefined;
  const database = native?.database;
  let claim: SqliteReclamationClaim | undefined = native?.claim;
  let validationOwner: SqliteMutationWorkerValidationOwner | undefined = native
    ? { database: native.database, isCurrent: native.claim.isCurrent }
    : undefined;
  const source = pending?.source ?? (database && readOpenClawAgentDatabaseIdentity(database));
  if (!source) {
    throw new Error("Canonical validation requires its captured database source");
  }
  const drainKey = source.incarnation;
  let execution: ReturnType<typeof captureOpenClawAgentDatabaseExecution> | undefined;
  let oversizedRows = 0;
  try {
    const readiness = database
      ? runSqliteReadOperationSync(database.db, () => {
          const initialize = !hasOpenClawAgentCanonicalValidation(database);
          return {
            initialize,
            hasWork: initialize || hasPendingCanonicalSessionValidation(database),
          };
        })
      : { initialize: pending!.initializeCanonicalValidation, hasWork: true };
    if (!readiness.hasWork) {
      return;
    }
    let initializeCanonicalValidation = readiness.initialize;
    const databaseOptions = {
      agentId: normalizeAgentId(options.agentId),
      path: database ? readOpenClawAgentDatabaseIdentity(database).filename : source.canonicalPath,
      env: {
        OPENCLAW_STATE_DIR: resolveOpenClawStateDirForDatabasePath(
          options.database?.path ?? resolveOpenClawStateSqlitePath(sourceEnv),
        ),
        ...(isGatewayExternallySupervised(sourceEnv)
          ? { OPENCLAW_SUPERVISOR_MODE: "external" }
          : {}),
      },
    };
    const readValidation = () =>
      database
        ? getOpenClawAgentDatabaseValidation(database)
        : getOpenClawAgentDatabaseValidationForTransfer(databaseOptions);
    if (pending) {
      execution = captureOpenClawAgentDatabaseExecution(databaseOptions, {
        expectedIdentity: {
          kind: "file",
          physicalIdentity: pending.source.key.slice(5),
          nativeLocation: pending.source.canonicalPath,
          birthtime: pending.source.birthtime,
        },
        requestedPath: pathname,
      });
    }
    const useWorker = <T>(
      run: (worker: SqliteReclamationWorker) => Promise<T>,
      assertCurrent: () => void,
      signal: AbortSignal,
    ) =>
      pending
        ? withSqliteReclamationWorker(
            databaseOptions,
            claim ?? pending.source,
            run,
            assertCurrent,
            signal,
            pathname,
          )
        : withWorker(databaseOptions, native!.claim, run, assertCurrent, signal);
    return await withSqliteMutationWorkerLifetime(
      databaseOptions,
      async ({ assertCurrent: assertReadinessCurrent }) => {
        const shareRuntimeDrain =
          withWorker === withSqliteReclamationWorker && assertCurrentOwner === undefined;
        const drain = async () => {
          let contendedBatches = 0;
          let validation = readValidation();
          while (true) {
            assertOwnerCurrent();
            assertReadinessCurrent();
            claim?.assertCurrent();
            const result = await withSqliteMutationWorkerLifetime(
              databaseOptions,
              async ({ assertCurrent, signal }) =>
                await useWorker(
                  async (worker) => {
                    if (!claim) {
                      const receiveValidation =
                        captureOpenClawAgentDatabaseValidationTransfer(databaseOptions);
                      const assertOpeningCurrent = () => {
                        assertOwnerCurrent();
                        assertReadinessCurrent();
                        execution!.assertCurrent();
                      };
                      const prepared = await worker.prepare({
                        plan: { kind: "canonical-validation" },
                        expectedSource: pending!.source,
                        assertCurrent: assertOpeningCurrent,
                        withWriteAdmission: (run, reclamationAdmission) =>
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
                            "session.canonical-validation.prepare",
                            { reclamationAdmission },
                            "worker",
                            signal,
                          ),
                      });
                      assertOpeningCurrent();
                      prepared.claim.assertCurrent();
                      if (!receiveValidation(prepared.claim.identity, prepared.validation)) {
                        throw new Error("Canonical validation admission changed");
                      }
                      claim = prepared.claim;
                      validationOwner = { source: databaseOptions, claim: prepared.claim };
                      validation = readValidation();
                      initializeCanonicalValidation ||=
                        !validation ||
                        Atomics.load(new Int32Array(validation.canonicalReady), 0) !== 1;
                    }
                    const currentClaim = claim;
                    const assertCommitAllowed = () => {
                      assertOwnerCurrent();
                      assertReadinessCurrent();
                      assertCurrent();
                      execution?.assertCurrent();
                      worker.assertCurrent(databaseOptions, currentClaim);
                      if (validation && readValidation() !== validation) {
                        throw new Error("Canonical validation admission changed");
                      }
                    };
                    assertCommitAllowed();
                    return await worker.runCanonicalValidation({
                      databaseOptions,
                      claim: currentClaim,
                      validationOwner,
                      maxRows: MAX_BATCH_ROWS,
                      maxBytes: MAX_BATCH_BYTES,
                      initializeCanonicalValidation,
                      withWriteAdmission: async (run, reclamationAdmission) =>
                        await runExclusiveSqliteSessionWrite(
                          databaseOptions,
                          async () => {
                            let refusal: { error: unknown } | undefined;
                            try {
                              assertCommitAllowed();
                            } catch (error) {
                              refusal = { error };
                            }
                            await run(refusal);
                          },
                          "session.canonical-validation.certify",
                          { reclamationAdmission },
                          "worker",
                          signal,
                        ),
                    });
                  },
                  () => {
                    assertOwnerCurrent();
                    assertReadinessCurrent();
                    assertCurrent();
                    execution?.assertCurrent();
                    claim?.assertCurrent();
                  },
                  signal,
                ),
            );
            assertOwnerCurrent();
            assertReadinessCurrent();
            claim?.assertCurrent();
            const currentValidation = readValidation();
            if (!currentValidation || (validation && validation !== currentValidation)) {
              throw new Error("SQLite session reclamation database owner is no longer current");
            }
            validation ??= currentValidation;
            oversizedRows += result.oversizedRows;
            if (!result.hasMore) {
              if (
                database &&
                (!isOpenClawAgentDatabasePathCurrent(database) ||
                  !markOpenClawAgentCanonicalValidation(database))
              ) {
                throw new Error("SQLite session reclamation database owner is no longer current");
              }
              return;
            }
            if (initializeCanonicalValidation) {
              initializeCanonicalValidation = false;
              continue;
            }
            if (result.certifiedRows === 0) {
              const waitMs = CONTENTION_BACKOFF_MS[contendedBatches] ?? 250;
              contendedBatches = Math.min(contendedBatches + 1, CONTENTION_BACKOFF_MS.length - 1);
              await delay(waitMs);
            } else {
              contendedBatches = 0;
            }
            // The next batch rejoins both existing FIFOs behind already queued work.
          }
        };
        let completion: Promise<void> | undefined;
        let ownsDrain = false;
        try {
          assertOwnerCurrent();
          assertReadinessCurrent();
          execution?.assertCurrent();
          claim?.assertCurrent();
          completion = shareRuntimeDrain ? runtimeDrains.get(drainKey) : undefined;
          ownsDrain = completion === undefined;
          if (!completion) {
            completion = drain();
            if (shareRuntimeDrain) {
              runtimeDrains.set(drainKey, completion);
            }
          }
          await completion;
          assertOwnerCurrent();
          assertReadinessCurrent();
          execution?.assertCurrent();
          claim?.assertCurrent();
          const currentValidation = readValidation();
          if (
            database
              ? !isOpenClawAgentDatabasePathCurrent(database) ||
                !hasOpenClawAgentCanonicalValidation(database)
              : !currentValidation ||
                Atomics.load(new Int32Array(currentValidation.canonicalReady), 0) !== 1
          ) {
            throw new Error("SQLite session reclamation database owner is no longer current");
          }
        } finally {
          if (ownsDrain && runtimeDrains.get(drainKey) === completion) {
            runtimeDrains.delete(drainKey);
          }
          native?.claim.release();
          await execution?.release();
        }
      },
    );
  } finally {
    native?.claim.release();
    await execution?.release();
    if (oversizedRows > 0) {
      log.warn("Canonical session validation processed oversized rows in its Worker", {
        path: pathname,
        rows: oversizedRows,
        batchByteLimit: MAX_BATCH_BYTES,
      });
    }
  }
}
