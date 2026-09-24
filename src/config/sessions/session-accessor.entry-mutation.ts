import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import {
  resolveAccessStorePath,
  loadSessionEntry,
  patchSessionEntryCore,
} from "./session-accessor.entry.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.lifecycle.js";
import { readSessionCreationSnapshotInDatabase } from "./session-accessor.sqlite-creation-read.js";
import { createSessionEntryWithTranscriptInWorker } from "./session-accessor.sqlite-creation-worker.js";
import { hasPreparedNativeSessionDeletion } from "./session-accessor.sqlite-deletion.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import "./session-accessor.sqlite-entry.js";
import { forkSessionTranscriptFromParent } from "./session-accessor.sqlite-parent-session.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteScope,
  prepareSqliteScope,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import type {
  SessionAccessScope,
  SessionEntryUpdateOptions,
  SessionAbortTargetCutoff,
  SessionAbortTargetContext,
  SessionAbortTargetIdentity,
  SessionAbortTargetResult,
  ForkSessionFromParentTranscriptResult,
  ForkSessionFromParentTranscriptParams,
  SessionEntryCreateWithTranscriptContext,
  SessionEntryCreateWithTranscriptResult,
  SessionEntryCreateWithTranscriptPrepareResult,
  SessionEntryCreateWithTranscriptOptions,
} from "./session-accessor.types.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";
export {
  recordInboundSessionMeta,
  updateSessionLastRoute,
} from "./session-accessor.sqlite-entry.js";
export {
  forkSessionEntryFromParentTarget,
  resolveSessionParentForkDecision,
} from "./session-accessor.sqlite-parent-session.js";

export async function forkSessionFromParentTranscript(
  params: ForkSessionFromParentTranscriptParams,
): Promise<ForkSessionFromParentTranscriptResult> {
  return await forkSessionTranscriptFromParent(params);
}

/**
 * Creates or updates one session entry and initializes its transcript header as
 * one SQLite-backed lifecycle operation. Callers do not compose row creation,
 * transcript initialization, rollback, and normalized session identity.
 */
export async function createSessionEntryWithTranscript<TError = string>(
  scope: SessionAccessScope,
  createEntry: (
    context: SessionEntryCreateWithTranscriptContext,
  ) =>
    | Promise<SessionEntryCreateWithTranscriptPrepareResult<TError>>
    | SessionEntryCreateWithTranscriptPrepareResult<TError>,
  options: SessionEntryCreateWithTranscriptOptions = {},
): Promise<SessionEntryCreateWithTranscriptResult<TError>> {
  const captured = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const storePath = resolveAccessStorePath(captured);
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  const target = { ...captured, agentId, storePath };
  const resolved = captureLifecycleDatabaseScope(
    isMainThread ? await prepareSqliteScope(target) : resolveSqliteScope(target),
  );
  if (
    isMainThread &&
    supportsOpenClawAgentDatabaseExecution(toDatabaseOptions(resolved)) &&
    !hasPreparedNativeSessionDeletion()
  ) {
    return createSessionEntryWithTranscriptInWorker(resolved, createEntry, options);
  }
  // Process-held, already executing, maintenance, and native rollback scopes keep their kernels.
  const storeScope = { agentId, env: resolved.env, storePath: resolved.path };
  // The resolved path is a physical locator, not the original logical store selector.
  // Re-resolving a missing custom-agent suffix as a shared store would assign it to main.
  const creationDatabase = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const { normalizedKey, legacyKeys, labels, ...context } = readSessionCreationSnapshotInDatabase(
    creationDatabase,
    scope.sessionKey,
  );
  const created = await createEntry({ ...context, isLabelInUse: (label) => labels.has(label) });
  if (!created.ok) {
    return { ok: false, error: created.error, phase: "entry" };
  }
  const ownerAssignment = options.resolveOwnerAssignment?.();
  const { cwd, commitGuard, withCommit, onLifecycleCommitted } = options;

  const initializeTranscript = async (assertSourceCurrent?: () => void) => {
    try {
      const transcriptScope = resolveSqliteTranscriptScope({
        ...storeScope,
        sessionId: created.entry.sessionId,
        sessionKey: normalizedKey,
      });
      await runExclusiveSqliteSessionWrite(
        transcriptScope,
        async () => {
          runOpenClawAgentWriteTransaction((database) => {
            commitGuard?.();
            assertSourceCurrent?.();
            ensureTranscriptHeader(database, transcriptScope, cwd);
          }, toDatabaseOptions(transcriptScope));
        },
        "session.entry.create-with-transcript",
      );
      return undefined;
    } catch (err) {
      // Reassert while source custody is still held; acquisition and unwind errors
      // must escape instead of becoming ordinary transcript failures.
      commitGuard?.();
      assertSourceCurrent?.();
      return formatErrorMessage(err);
    }
  };
  const transcriptError = withCommit
    ? await withCommit(initializeTranscript)
    : await initializeTranscript();
  if (transcriptError !== undefined) {
    return {
      ok: false,
      error: transcriptError,
      phase: "transcript",
    };
  }

  const entry = created.entry;
  await applySessionEntryLifecycleMutation({
    ...storeScope,
    removals: legacyKeys.map((sessionKey) => ({ sessionKey })),
    upserts: [{ sessionKey: normalizedKey, entry }],
    skipMaintenance: true,
    ...(commitGuard ? { beforeCommitInTransaction: commitGuard } : {}),
    ...(withCommit ? { withCommit } : {}),
    ...(ownerAssignment
      ? {
          afterFreshUpsertsInTransaction: (database) => {
            if (!replaceSessionOwnerInTransaction(database, normalizedKey, ownerAssignment)) {
              throw new Error(`Session owner assignment lost its target: ${normalizedKey}`);
            }
          },
        }
      : {}),
    ...(onLifecycleCommitted ? { onLifecycleCommitted: () => onLifecycleCommitted(entry) } : {}),
    ...(options.afterCommitted
      ? { afterCommitted: (source) => options.afterCommitted!(entry, source) }
      : {}),
  });
  return { ok: true, entry, sessionFile: normalizedKey };
}

export function cloneSessionEntries(
  store: Record<string, SessionEntry>,
): Record<string, SessionEntry> {
  return Object.fromEntries(
    Object.entries(store).map(([sessionKey, entry]) => [sessionKey, { ...entry }]),
  );
}

function collectSessionEntryKeys(...entries: SessionEntry[]): Array<keyof SessionEntry> {
  return [...new Set(entries.flatMap((entry) => Object.keys(entry) as Array<keyof SessionEntry>))];
}

function sessionEntryFieldUnchanged(
  left: SessionEntry,
  right: SessionEntry,
  key: keyof SessionEntry,
): boolean {
  return isDeepStrictEqual(
    Object.hasOwn(left, key) ? left[key] : undefined,
    Object.hasOwn(right, key) ? right[key] : undefined,
  );
}

// Background activity can mutate non-identity fields after the initialization
// snapshot. Carry forward only same-session changes; the prepared entry still
// wins for any field it explicitly modified relative to the snapshot. This
// preserves heartbeat/delivery/context metadata without resurrecting fields that
// a reset intentionally cleared or carrying old-session metadata into /new.
export function mergeConcurrentReplySessionMetadata(params: {
  currentEntry: SessionEntry;
  preparedEntry: SessionEntry;
  snapshotEntry?: SessionEntry;
}): SessionEntry {
  const { currentEntry, preparedEntry, snapshotEntry } = params;
  if (!snapshotEntry || preparedEntry.sessionId !== snapshotEntry.sessionId) {
    return preparedEntry;
  }
  const merged: SessionEntry = { ...preparedEntry };
  const mergedFields = merged as Partial<
    Record<keyof SessionEntry, SessionEntry[keyof SessionEntry]>
  >;
  for (const key of collectSessionEntryKeys(currentEntry, preparedEntry, snapshotEntry)) {
    const currentChanged = !sessionEntryFieldUnchanged(currentEntry, snapshotEntry, key);
    const preparedKeptSnapshot = sessionEntryFieldUnchanged(preparedEntry, snapshotEntry, key);
    if (currentChanged && preparedKeptSnapshot) {
      if (Object.hasOwn(currentEntry, key)) {
        mergedFields[key] = currentEntry[key];
      } else {
        delete mergedFields[key];
      }
    }
  }
  return merged;
}

export function createReplySessionInitializationRevision(entry: SessionEntry | undefined): string {
  if (!entry) {
    return JSON.stringify(null);
  }
  // The guard only rejects a true session-identity rebind. Same-session
  // activity/context writes are merged below; comparing them here would reject
  // before the merge can preserve the concurrent metadata.
  return JSON.stringify({ sessionId: entry.sessionId });
}

/** Updates an existing entry only; returns null when the session is absent. */
export async function updateSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryUpdateOptions = {},
): Promise<SessionEntry | null> {
  return await patchSessionEntryCore(scope, update, options);
}

/** Resolves one abort target identity without exposing the mutable store. */
export function resolveSessionAbortTarget(
  scope: SessionAccessScope,
): SessionAbortTargetIdentity | null {
  const entry = loadSessionEntry(scope);
  if (!entry) {
    return null;
  }
  return {
    entry: { ...entry },
    sessionId: entry.sessionId,
    sessionKey: normalizeStoreSessionKey(scope.sessionKey),
  };
}

/**
 * Resolves, marks, touches, and canonicalizes one abort target entry as a
 * storage-sized operation. Runtime abort side effects remain with callers.
 */
export async function markSessionAbortTarget(params: {
  isCurrent?: () => boolean;
  resolveAbortCutoff?: (context: SessionAbortTargetContext) => SessionAbortTargetCutoff | undefined;
  scope: SessionAccessScope;
  now?: () => number;
}): Promise<SessionAbortTargetResult | null> {
  const resolution: { target: SessionAbortTargetResult | null } = { target: null };
  try {
    const sessionKey = normalizeStoreSessionKey(params.scope.sessionKey);
    const updated = await patchSessionEntryCore(
      params.scope,
      (currentEntry) => {
        if (params.isCurrent?.() === false) {
          return null;
        }
        resolution.target = {
          entry: { ...currentEntry },
          persisted: false,
          sessionId: currentEntry.sessionId,
          sessionKey,
        };
        const entry = {
          ...currentEntry,
          abortedLastRun: true,
          updatedAt: params.now?.() ?? Date.now(),
        };
        applySessionAbortCutoff(
          entry,
          params.resolveAbortCutoff?.({
            entry: { ...currentEntry },
            sessionKey,
          }),
        );
        return entry;
      },
      {
        replaceEntry: true,
        skipMaintenance: true,
        // The patch callback yields before BEGIN; the conversation can move without
        // changing this session row, so its snapshot comparison cannot fence Stop.
        assertCommitAllowed: () => {
          if (resolution.target && params.isCurrent?.() === false) {
            throw new Error("The selected session changed before it could be stopped.");
          }
        },
      },
    );
    return updated && resolution.target
      ? {
          entry: { ...updated },
          persisted: true,
          sessionId: updated.sessionId,
          sessionKey,
        }
      : null;
  } catch (error) {
    const fallbackTarget = resolution.target;
    if (fallbackTarget) {
      return {
        entry: fallbackTarget.entry,
        persisted: fallbackTarget.persisted,
        sessionId: fallbackTarget.sessionId,
        sessionKey: fallbackTarget.sessionKey,
        persistenceError: formatErrorMessage(error),
      };
    }
    throw error;
  }
}

function applySessionAbortCutoff(
  entry: Pick<SessionEntry, "abortCutoffMessageSid" | "abortCutoffTimestamp">,
  cutoff: SessionAbortTargetCutoff | undefined,
): void {
  entry.abortCutoffMessageSid = cutoff?.messageSid;
  entry.abortCutoffTimestamp = cutoff?.timestamp;
}
