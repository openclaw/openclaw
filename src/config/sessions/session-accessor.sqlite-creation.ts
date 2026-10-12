import { isMainThread } from "node:worker_threads";
import { formatErrorMessage } from "../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.lifecycle.js";
import {
  readSessionCreationSnapshotInDatabase,
  assertSessionCreationLabelAvailable,
  type SessionCreationSnapshot,
} from "./session-accessor.sqlite-creation-read.js";
import { hasPreparedNativeSessionDeletion } from "./session-accessor.sqlite-deletion.js";
import {
  withSessionEntryCreationPublication,
  runWithSessionEntryCreationPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import { applySessionEntryCreationReplacement } from "./session-accessor.sqlite-replacement-projection.js";
import {
  initializeSessionTranscriptInWorker,
  prepareSessionEntryReplacementDatabase,
} from "./session-accessor.sqlite-replacement-worker.js";
import {
  runExclusiveSqliteSessionWrite,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type {
  SessionEntryCreateWithTranscriptContext,
  SessionEntryCreateWithTranscriptOptions,
  SessionEntryCreateWithTranscriptPrepareResult,
  SessionEntryCreateWithTranscriptResult,
  SessionEntryCommitContext,
} from "./session-accessor.types.js";
import { createSessionActorEntryWithTranscript } from "./session-actor-entry-adapter.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import { publishSessionStateArchivesInWorker } from "./session-archive-publication.js";
import { captureIncognitoSessionBinding } from "./session-incognito-binding.js";
import { createIncognitoSessionEntryWithTranscript } from "./session-incognito-entry-creation.js";
import { retainSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

type CreationScope = ResolvedSqliteScope & { path: string; env: NodeJS.ProcessEnv };
type CreationSource = {
  snapshot: SessionCreationSnapshot;
} & (
  | { kind: "native"; database: OpenClawAgentDatabase }
  | { kind: "worker"; databaseIdentity: string; databasePath: string; assertCurrent: () => void }
);

/** One creation owner retains source custody across preparation, commit, and publication. */
export async function createSessionEntryWithTranscriptInScope<TError>(
  scope: CreationScope,
  createEntry: (
    context: SessionEntryCreateWithTranscriptContext,
  ) =>
    | Promise<SessionEntryCreateWithTranscriptPrepareResult<TError>>
    | SessionEntryCreateWithTranscriptPrepareResult<TError>,
  options: SessionEntryCreateWithTranscriptOptions,
): Promise<SessionEntryCreateWithTranscriptResult<TError>> {
  const memory = getSessionActorStorageBinding({ ...scope, storePath: scope.path });
  if (memory) {
    return createSessionActorEntryWithTranscript(memory, scope.env, createEntry, options);
  }
  const binding = captureIncognitoSessionBinding({ ...scope, storePath: scope.path });
  if (binding) {
    return createIncognitoSessionEntryWithTranscript(binding, scope, createEntry, options);
  }
  const databaseOptions = { ...toDatabaseOptions(scope), path: scope.path };
  const useWorker =
    isMainThread &&
    supportsOpenClawAgentDatabaseExecution(databaseOptions) &&
    !hasPreparedNativeSessionDeletion();
  const retained = useWorker ? retainSessionHistoryWorkerDatabase(databaseOptions) : undefined;
  try {
    let source: CreationSource;
    if (retained) {
      const reader = retained.owner;
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
      const { databaseIdentity, databasePath } = snapshot;
      const assertCurrent = () => {
        reader.assertCurrent();
        assertExistingDatabaseIdentity(scope.path, `file:${databaseIdentity}`);
      };
      source = {
        kind: "worker",
        databaseIdentity,
        databasePath,
        snapshot,
        assertCurrent,
      };
    } else {
      // This is the retained physical locator, not a logical selector to resolve again.
      const database = openOpenClawAgentDatabase(databaseOptions);
      const snapshot = readSessionCreationSnapshotInDatabase(
        database,
        scope.sessionKey,
        options.label,
      );
      source = {
        kind: "native",
        snapshot,
        database,
      };
    }
    const { normalizedKey, legacyKeys, existingEntry, targetEntry, labelInUse } = source.snapshot;
    return await withSessionEntryCreationPublication<
      SessionEntryCreateWithTranscriptResult<TError>
    >(
      {
        agentId: scope.agentId,
        sessionKey: normalizedKey,
        bind: options.bindCreation,
        ...(source.kind === "native"
          ? { database: source.database }
          : {
              file: {
                path: source.databasePath,
                agentId: databaseOptions.agentId,
                databaseIdentity: source.databaseIdentity,
                assertCurrent: source.assertCurrent,
              },
            }),
      },
      async (operation) => {
        const withSourceCommit = options.withCommit;
        const withCommit: typeof options.withCommit = withSourceCommit
          ? (run) =>
              withSourceCommit((assertCurrent) =>
                runWithSessionEntryCreationPublication(operation, () => run(assertCurrent)),
              )
          : undefined;
        const assertCurrent = () => {
          if (source.kind === "worker") {
            source.assertCurrent();
          }
          options.commitGuard?.();
        };
        options.onPhase?.("entry");
        const created = await createEntry({ existingEntry, targetEntry, labelInUse });
        if (!created.ok) {
          return { ok: false, error: created.error, phase: "entry" };
        }
        const owner = options.resolveOwnerAssignment?.();
        const preparedTranscript = created.transcriptEvents
          ? {
              sessionKey: normalizedKey,
              sessionId: created.entry.sessionId,
              events: created.transcriptEvents,
            }
          : undefined;
        const initialization = {
          sessionKey: normalizedKey,
          sessionId: created.entry.sessionId,
          cwd: options.cwd,
        };
        const separateHeader = source.kind === "native" || legacyKeys.length > 0;
        if (separateHeader) {
          options.onPhase?.("transcript");
          const initialize = async (assertSourceCurrent?: () => void) => {
            const assertHeld = () => {
              assertCurrent();
              assertSourceCurrent?.();
            };
            try {
              if (source.kind === "worker") {
                await initializeSessionTranscriptInWorker(
                  databaseOptions,
                  source.databaseIdentity,
                  initialization,
                  assertHeld,
                );
              } else {
                const transcriptScope = resolveSqliteTranscriptScope({
                  agentId: scope.agentId,
                  env: scope.env,
                  storePath: scope.path,
                  sessionKey: normalizedKey,
                  sessionId: created.entry.sessionId,
                });
                await runExclusiveSqliteSessionWrite(
                  transcriptScope,
                  async () => {
                    runOpenClawAgentWriteTransaction(
                      (database) => {
                        assertHeld();
                        ensureTranscriptHeader(database, transcriptScope, options.cwd);
                      },
                      toDatabaseOptions(transcriptScope),
                      { operationLabel: "session.entry.create-transcript" },
                    );
                  },
                  "session.entry.create-with-transcript",
                );
              }
            } catch (error) {
              if (source.kind === "worker" && hasSqliteWorkerOutcomeUnknown(error)) {
                throw error;
              }
              assertHeld();
              return formatErrorMessage(error);
            }
            return undefined;
          };
          const transcriptError = preparedTranscript
            ? undefined
            : withCommit
              ? await withCommit(initialize)
              : await initialize();
          if (transcriptError !== undefined) {
            return { ok: false, error: transcriptError, phase: "transcript" };
          }
        }
        let pendingArchiveRecovery = false;
        if (!separateHeader) {
          options.onPhase?.("writerAdmission");
        } else if (source.kind === "native") {
          options.onPhase?.("commit");
        }
        const afterSourceCommit = options.afterCommitted;
        const afterCommitted = afterSourceCommit
          ? (context: SessionEntryCommitContext) => afterSourceCommit(created.entry, context)
          : undefined;
        if (source.kind === "native") {
          // Native lifecycle replacement retires an old SID; canonical alias adoption rehomes it.
          await applySessionEntryLifecycleMutation({
            agentId: scope.agentId,
            env: scope.env,
            storePath: scope.path,
            removals: legacyKeys.map((sessionKey) => ({ sessionKey })),
            upserts: [{ sessionKey: normalizedKey, entry: created.entry }],
            skipMaintenance: true,
            withCommit,
            beforeCommitInTransaction: () => {
              assertCurrent();
              assertSessionCreationLabelAvailable(source.database, normalizedKey, options.label);
            },
            afterFreshUpsertsInTransaction: (database) => {
              if (created.transcriptEvents) {
                appendTranscriptEventsInTransaction(
                  database,
                  { ...scope, sessionKey: normalizedKey, sessionId: created.entry.sessionId },
                  created.transcriptEvents,
                );
              }
              if (owner && !replaceSessionOwnerInTransaction(database, normalizedKey, owner)) {
                throw new Error(`Session owner assignment lost its target: ${normalizedKey}`);
              }
            },
            onLifecycleCommitted: () => options.onLifecycleCommitted?.(created.entry),
            afterCommitted,
          });
          return { ok: true, entry: created.entry, sessionFile: normalizedKey };
        }
        try {
          assertCurrent();
          await applySessionEntryCreationReplacement({
            scope,
            agentId: scope.agentId,
            storePath: scope.path,
            env: scope.env,
            sessionKey: normalizedKey,
            previousSessionKeys: legacyKeys,
            entry: created.entry,
            assertCommitAllowed: assertCurrent,
            withCommit,
            ownerAssignment: owner ? { sessionKey: normalizedKey, owner } : undefined,
            labelClaim:
              options.label === undefined
                ? undefined
                : { sessionKey: normalizedKey, label: options.label },
            preparedTranscript,
            initializeTranscript: separateHeader || preparedTranscript ? undefined : initialization,
            onWriterAdmitted: separateHeader ? undefined : () => options.onPhase?.("commit"),
            onLifecycleCommitted: (pending) => {
              pendingArchiveRecovery = pending;
              options.onLifecycleCommitted?.(created.entry);
            },
            checkPendingArchiveRecovery: true,
            afterCommitted,
          });
        } catch (error) {
          if (
            !separateHeader &&
            !hasSqliteWorkerOutcomeUnknown(error) &&
            error instanceof Error &&
            error.name === "SessionTranscriptInitializationError"
          ) {
            assertCurrent();
            return { ok: false, error: error.message, phase: "transcript" };
          }
          throw error;
        }
        if (pendingArchiveRecovery) {
          await publishSessionStateArchivesInWorker({
            scope,
            requested: [],
            databaseIdentity: source.databaseIdentity,
            assertCurrent,
          });
        }
        return { ok: true, entry: created.entry, sessionFile: normalizedKey };
      },
    );
  } finally {
    retained?.release();
  }
}
