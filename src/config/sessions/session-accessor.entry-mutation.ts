import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import {
  resolveAccessStorePath,
  loadSessionEntry,
  patchSessionEntryCore,
} from "./session-accessor.entry.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.lifecycle.js";
import { readSessionCreationSnapshot } from "./session-accessor.sqlite-creation-read.js";
import "./session-accessor.sqlite-entry.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import { forkSessionTranscriptFromParent } from "./session-accessor.sqlite-parent-session.js";
import {
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
  const storePath = resolveAccessStorePath(scope);
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  // The incognito sentinel is scoped to env; its path alone cannot identify the memory store.
  const storeScope = { agentId, env: scope.env, storePath };
  const { normalizedKey, legacyKeys, ...context } = readSessionCreationSnapshot({
    ...storeScope,
    sessionKey: scope.sessionKey,
  });
  const created = await createEntry(context);
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

function sessionEntryFieldEqual(
  left: SessionEntry[keyof SessionEntry],
  right: SessionEntry[keyof SessionEntry],
): boolean {
  return Object.is(left, right) || isDeepStrictEqual(left, right);
}

function sessionEntryFieldUnset(
  hasValue: boolean,
  value: SessionEntry[keyof SessionEntry],
): boolean {
  return !hasValue || value === undefined;
}

function sessionEntryFieldUnchanged(params: {
  leftHasValue: boolean;
  leftValue: SessionEntry[keyof SessionEntry];
  rightHasValue: boolean;
  rightValue: SessionEntry[keyof SessionEntry];
}): boolean {
  const { leftHasValue, leftValue, rightHasValue, rightValue } = params;
  if (
    sessionEntryFieldUnset(leftHasValue, leftValue) &&
    sessionEntryFieldUnset(rightHasValue, rightValue)
  ) {
    return true;
  }
  return leftHasValue === rightHasValue && sessionEntryFieldEqual(leftValue, rightValue);
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
    const currentHasValue = Object.hasOwn(currentEntry, key);
    const snapshotHasValue = Object.hasOwn(snapshotEntry, key);
    const preparedHasValue = Object.hasOwn(preparedEntry, key);
    const currentValue = currentEntry[key];
    const snapshotValue = snapshotEntry[key];
    const preparedValue = preparedEntry[key];
    const currentChanged = !sessionEntryFieldUnchanged({
      leftHasValue: currentHasValue,
      leftValue: currentValue,
      rightHasValue: snapshotHasValue,
      rightValue: snapshotValue,
    });
    const preparedKeptSnapshot = sessionEntryFieldUnchanged({
      leftHasValue: preparedHasValue,
      leftValue: preparedValue,
      rightHasValue: snapshotHasValue,
      rightValue: snapshotValue,
    });
    if (currentChanged && preparedKeptSnapshot) {
      if (currentHasValue) {
        mergedFields[key] = currentValue;
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
