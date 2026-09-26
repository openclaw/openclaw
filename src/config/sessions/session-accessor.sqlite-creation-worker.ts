import { formatErrorMessage } from "../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import {
  withSessionEntryCreationPublication,
  runWithSessionEntryCreationPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import {
  commitSessionEntryReplacementsInWorker,
  initializeSessionTranscriptInWorker,
  prepareSessionEntryReplacementDatabase,
  withSessionEntryWorker,
} from "./session-accessor.sqlite-replacement-worker.js";
import type { ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";
import {
  runExclusiveSqliteSessionWrite,
  resolveSqliteTranscriptArchiveDirectory,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type {
  SessionEntryCreateWithTranscriptContext,
  SessionEntryCreateWithTranscriptOptions,
  SessionEntryCreateWithTranscriptPrepareResult,
  SessionEntryCreateWithTranscriptResult,
} from "./session-accessor.types.js";
import { retainSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

/** Durable creation uses the existing read owner and the canonical agent writer. */
export async function createSessionEntryWithTranscriptInWorker<TError>(
  scope: ResolvedSqliteScope & { path: string; env: NodeJS.ProcessEnv },
  createEntry: (
    context: SessionEntryCreateWithTranscriptContext,
  ) =>
    | Promise<SessionEntryCreateWithTranscriptPrepareResult<TError>>
    | SessionEntryCreateWithTranscriptPrepareResult<TError>,
  options: SessionEntryCreateWithTranscriptOptions,
): Promise<SessionEntryCreateWithTranscriptResult<TError>> {
  const databaseOptions = { ...toDatabaseOptions(scope), path: scope.path };
  const retained = retainSessionHistoryWorkerDatabase(databaseOptions);
  const reader = retained.owner;
  try {
    const read = () =>
      reader.readExactEntries({
        projection: "creation",
        creationLabel: options.label,
        sessionKeys: [scope.sessionKey],
        env: { ...scope.env },
      });
    let snapshot = (await read()).creation;
    if (!snapshot) {
      await prepareSessionEntryReplacementDatabase(databaseOptions, () => {
        reader.assertCurrent();
        options.commitGuard?.();
      });
      snapshot = (await read()).creation;
    }
    if (!snapshot) {
      throw new Error("Session creation lost its initialized database");
    }
    const { normalizedKey, legacyKeys, databaseIdentity, databasePath, ...context } = snapshot;
    const assertDatabaseCurrent = () => {
      reader.assertCurrent();
      assertExistingDatabaseIdentity(scope.path, `file:${databaseIdentity}`);
    };
    return await withSessionEntryCreationPublication<
      SessionEntryCreateWithTranscriptResult<TError>
    >(
      {
        agentId: scope.agentId,
        sessionKey: normalizedKey,
        file: {
          path: databasePath,
          agentId: databaseOptions.agentId,
          databaseIdentity,
          assertCurrent: assertDatabaseCurrent,
        },
        bind: options.bindCreation,
      },
      async (operation) => {
        const withSourceCommit = options.withCommit;
        const withCommit: typeof options.withCommit = withSourceCommit
          ? (run) =>
              withSourceCommit((assertCurrent) =>
                runWithSessionEntryCreationPublication(operation, () => run(assertCurrent)),
              )
          : undefined;
        options.onPhase?.("entry");
        const created = await createEntry(context);
        if (!created.ok) {
          return { ok: false, error: created.error, phase: "entry" };
        }
        const owner = options.resolveOwnerAssignment?.();
        const assertCurrent = () => {
          assertDatabaseCurrent();
          options.commitGuard?.();
        };
        let pendingArchiveRecovery = false;
        const onLifecycleCommitted = (pending: boolean) => {
          pendingArchiveRecovery = pending;
          options.onLifecycleCommitted?.(created.entry);
        };
        const publishArchives = async () => {
          if (!pendingArchiveRecovery) {
            return;
          }
          // Match lifecycle adoption recovery, after registration and writer release.
          // The archive owner retains batching, byte validation, events and failure semantics.
          const run = <T>(
            execute: (
              worker: import("../../state/openclaw-agent-execution-native.js").AgentDatabaseExecutionScope,
            ) => Promise<T>,
          ) =>
            withSessionEntryWorker(
              databaseOptions,
              databaseIdentity,
              assertCurrent,
              async (execution, source) => {
                const result = await execution.runExisting(source, async (worker) => ({
                  value: await execute(worker),
                }));
                if (!result) {
                  throw new Error("Session database disappeared before archive publication");
                }
                return result.value;
              },
            );
          await publishSessionStateArchives({ ...scope, agentId: databaseOptions.agentId }, [], {
            prepare: (requested) =>
              run((worker) =>
                worker.execute({
                  type: "session.archives.preparePublication",
                  input: {
                    archiveDirectory: resolveSqliteTranscriptArchiveDirectory(scope),
                    requested,
                  },
                }),
              ),
            record: (results) =>
              run((worker) =>
                worker.execute({
                  type: "session.archives.recordPublication",
                  input: { results, nowMs: Date.now() },
                }),
              ),
          });
        };
        if (legacyKeys.length > 0) {
          const initialize = async (assertSourceCurrent?: () => void) => {
            const assertHeld = () => {
              assertCurrent();
              assertSourceCurrent?.();
            };
            try {
              await initializeSessionTranscriptInWorker(
                databaseOptions,
                databaseIdentity,
                {
                  sessionKey: normalizedKey,
                  sessionId: created.entry.sessionId,
                  cwd: options.cwd,
                },
                assertHeld,
              );
            } catch (error) {
              if (hasSqliteWorkerOutcomeUnknown(error)) {
                throw error;
              }
              assertHeld();
              return formatErrorMessage(error);
            }
            return undefined;
          };
          options.onPhase?.("transcript");
          const transcriptError = withCommit ? await withCommit(initialize) : await initialize();
          if (transcriptError !== undefined) {
            return { ok: false, error: transcriptError, phase: "transcript" };
          }
          // Admitted folded aliases still belong to canonical replacement: it owns
          // their row CAS, native deletion preparation, and atomic artifact rehoming.
          await applySessionEntryCanonicalReplacements({
            agentId: scope.agentId,
            storePath: scope.path,
            env: scope.env,
            sessionKeys: [normalizedKey, ...legacyKeys],
            assertCommitAllowed: assertCurrent,
            withCommit,
            ownerAssignment: owner ? { sessionKey: normalizedKey, owner } : undefined,
            onLifecycleCommitted,
            checkPendingArchiveRecovery: true,
            afterCommitted: options.afterCommitted
              ? (_result, source) => options.afterCommitted!(created.entry, source)
              : undefined,
            update: () => ({
              result: undefined,
              replacements: [
                {
                  sessionKey: normalizedKey,
                  previousSessionKeys: legacyKeys,
                  entry: created.entry,
                },
              ],
            }),
          });
          await publishArchives();
          return { ok: true, entry: created.entry, sessionFile: normalizedKey };
        }
        options.onPhase?.("writerAdmission");
        const commit = (assertSourceCurrent?: () => void) =>
          runExclusiveSqliteSessionWrite(
            scope,
            async () => {
              options.onPhase?.("commit");
              const assertHeld = () => {
                assertCurrent();
                assertSourceCurrent?.();
              };
              assertHeld();
              const replacement = (
                await reader.readExactEntries({
                  projection: "replacement",
                  sessionKeys: [normalizedKey],
                  replacementSelection: { sessionKeys: [normalizedKey] },
                  env: { ...scope.env },
                })
              ).replacement;
              assertHeld();
              if (!replacement || replacement.databaseIdentity !== databaseIdentity) {
                throw new Error("Session creation database changed before entry commit");
              }
              // Creation owns its canonical target, including hidden run-owned nodes. The
              // canonical-replacement projection deliberately does not admit those nodes.
              try {
                await commitSessionEntryReplacementsInWorker(
                  databaseOptions,
                  databaseIdentity,
                  {
                    expectedRows: replacement.expectedRows,
                    labelOwnerKeys: replacement.labelOwnerKeys,
                    validationKeys: [normalizedKey],
                    replacements: [{ sessionKey: normalizedKey, entry: created.entry }],
                    checkPendingArchiveRecovery: true,
                    initializeTranscript: {
                      sessionKey: normalizedKey,
                      sessionId: created.entry.sessionId,
                      cwd: options.cwd,
                    },
                    ...(owner ? { ownerAssignment: { sessionKey: normalizedKey, owner } } : {}),
                  },
                  assertHeld,
                  {
                    identityAgentId: scope.agentId,
                    afterCommitted: options.afterCommitted
                      ? (source) => options.afterCommitted!(created.entry, source)
                      : undefined,
                    onLifecycleCommitted,
                  },
                );
              } catch (error) {
                if (
                  !hasSqliteWorkerOutcomeUnknown(error) &&
                  error instanceof Error &&
                  error.name === "SessionTranscriptInitializationError"
                ) {
                  assertHeld();
                  return error.message;
                }
                throw error;
              }
              return undefined;
            },
            "session.entry.create-with-transcript",
          );
        const transcriptError = withCommit ? await withCommit(commit) : await commit();
        if (transcriptError !== undefined) {
          return { ok: false, error: transcriptError, phase: "transcript" };
        }
        await publishArchives();
        return { ok: true, entry: created.entry, sessionFile: normalizedKey };
      },
    );
  } finally {
    retained.release();
  }
}
