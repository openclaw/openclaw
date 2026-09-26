import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { registerOpenClawAgentDatabaseReadCandidateResource } from "../../state/openclaw-agent-db-resources.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
  type OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  resolveAccessStorePath,
  loadSessionEntry,
  patchSessionEntryCore,
} from "./session-accessor.entry.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.lifecycle.js";
import {
  assertSessionCreationLabelAvailable,
  readSessionCreationSnapshotInDatabase,
} from "./session-accessor.sqlite-creation-read.js";
import { createSessionEntryWithTranscriptInWorker } from "./session-accessor.sqlite-creation-worker.js";
import { hasPreparedNativeSessionDeletion } from "./session-accessor.sqlite-deletion.js";
import {
  withSessionEntryCreationPublication,
  runWithSessionEntryCreationPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import "./session-accessor.sqlite-entry.js";
import { forkSessionTranscriptFromParent } from "./session-accessor.sqlite-parent-session.js";
import { prepareSessionEntryReplacementDatabase } from "./session-accessor.sqlite-replacement-worker.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteScope,
  prepareSqliteScope,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
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
import { captureSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
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

/** Capture source custody before authority or physical-owner discovery yields. */
function captureSessionEntryDatabasePreparation(
  scope: SessionAccessScope,
  assertCurrent: () => void,
  relatedScopes: readonly SessionAccessScope[] = [],
) {
  const captureScope = (source: SessionAccessScope) => ({
    ...source,
    env: Object.freeze(captureSessionTranscriptStorageEnvironment(source.env ?? process.env)),
  });
  const captured = captureScope(scope);
  const target = {
    ...captured,
    agentId: captured.agentId ?? resolveAgentIdFromSessionKey(captured.sessionKey),
    storePath: resolveAccessStorePath(captured),
  };
  const shared = captureOpenClawStateWorkerContext({ env: target.env });
  const candidates = [target, ...relatedScopes.map(captureScope)].flatMap((related) =>
    captureSessionStoreReadCandidates(resolveAccessStorePath(related)).map((candidate) => ({
      path: candidate.path,
      physicalPath: candidate.physicalPath,
      scope: candidate.scope,
      identity: readDatabasePathIdentitySync(candidate.path),
    })),
  );
  const releases: Array<() => void> = [];
  let active = true;
  let execution: OpenClawAgentDatabaseExecution | undefined;
  let preparedPath: string | undefined;
  let preparedIdentity: ReturnType<typeof readDatabasePathIdentitySync> | undefined;
  let creatingPath: string | undefined;
  const assertSourceCurrent = () => {
    if (!active) {
      throw new Error("Session creation database preparation is closed");
    }
    shared.admission.assertCurrent();
    execution?.assertCurrent();
    for (const candidate of candidates) {
      const isCreating = candidate.path === creatingPath || candidate.physicalPath === creatingPath;
      const isPrepared = candidate.path === preparedPath || candidate.physicalPath === preparedPath;
      if (
        captureSessionStoreReadCandidate(candidate.path, candidate.scope).physicalPath !==
          candidate.physicalPath ||
        (!(isCreating && candidate.identity.key.startsWith("path:")) &&
          !isDeepStrictEqual(
            readDatabasePathIdentitySync(candidate.path),
            isPrepared ? preparedIdentity : candidate.identity,
          ))
      ) {
        throw new Error("Session creation database changed during preparation");
      }
    }
    if (
      preparedPath &&
      !isDeepStrictEqual(readDatabasePathIdentitySync(preparedPath), preparedIdentity)
    ) {
      throw new Error("Session creation database changed after preparation");
    }
  };
  const assertHeld = () => {
    assertCurrent();
    assertSourceCurrent();
  };
  const unregister = () => {
    for (const release of releases.splice(0).toReversed()) {
      release();
    }
  };
  const release = async () => {
    active = false;
    try {
      await execution?.release();
    } finally {
      unregister();
    }
  };
  try {
    for (const candidate of candidates) {
      for (const path of new Set([candidate.path, candidate.physicalPath])) {
        releases.push(
          registerOpenClawAgentDatabaseReadCandidateResource({
            path,
            scope: candidate.scope,
            revoke: () => {
              active = false;
            },
            close: release,
          }),
        );
      }
    }
  } catch (error) {
    active = false;
    unregister();
    throw error;
  }
  return {
    assertCurrent: assertSourceCurrent,
    env: target.env,
    get execution() {
      return execution;
    },
    assertHeld,
    release,
    async resolve() {
      assertHeld();
      const resolved = captureLifecycleDatabaseScope(
        isMainThread ? await prepareSqliteScope(target) : resolveSqliteScope(target),
      );
      assertHeld();
      const options = { ...toDatabaseOptions(resolved), path: resolved.path };
      if (
        !isMainThread ||
        !supportsOpenClawAgentDatabaseExecution(options) ||
        hasPreparedNativeSessionDeletion()
      ) {
        return undefined;
      }
      const original = candidates.find(
        (candidate) => candidate.path === resolved.path || candidate.physicalPath === resolved.path,
      );
      if (!original) {
        throw new Error("Session creation lost its originally captured database target");
      }
      return {
        options,
        identity: original.identity,
        key: JSON.stringify([
          shared.admission.databasePath,
          shared.admission.identity.key,
          options.agentId,
          original.identity.key,
          original.identity.birthtime,
        ]),
      };
    },
    begin(path: string, retained: OpenClawAgentDatabaseExecution) {
      execution = retained;
      creatingPath = path;
    },
    finish(path: string, original: ReturnType<typeof readDatabasePathIdentitySync>) {
      const accepted = execution?.fileIdentity;
      if (!accepted || typeof accepted.birthtime !== "string") {
        throw new Error("Session creation has no accepted native file identity");
      }
      preparedPath = path;
      preparedIdentity = {
        key: `file:${accepted.physicalIdentity}`,
        canonicalPath: original.canonicalPath,
        birthtime: accepted.birthtime,
      };
      creatingPath = undefined;
    },
  };
}

/** Settle every selected writer before any facts snapshot, retaining borrowers without FIFO permits. */
export function prepareSessionEntryMutationDatabases(
  targets: readonly {
    scope: SessionAccessScope;
    assertCurrent: () => void;
    relatedScopes?: readonly SessionAccessScope[];
  }[],
  ready: Promise<void>,
) {
  void ready.catch(() => {});
  type Capture = ReturnType<typeof captureSessionEntryDatabasePreparation>;
  type Resolved = NonNullable<Awaited<ReturnType<Capture["resolve"]>>>;
  type Prepared = Pick<Capture, "assertCurrent" | "execution" | "env">;
  type Group = {
    target: Resolved;
    members: Array<{ index: number; capture: Capture; target: Resolved }>;
  };
  const captured = targets.map((target): PromiseSettledResult<Capture> => {
    try {
      return {
        status: "fulfilled",
        value: captureSessionEntryDatabasePreparation(
          target.scope,
          target.assertCurrent,
          target.relatedScopes,
        ),
      };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  });
  const promotion = (async () => {
    await ready;
    // Registry discovery must finish everywhere before any writer changes its generation.
    const resolved = await Promise.allSettled(
      captured.map(async (capture) => {
        if (capture.status === "rejected") {
          throw capture.reason;
        }
        return await capture.value.resolve();
      }),
    );
    const outcomes: PromiseSettledResult<Prepared>[] = [];
    const groups = new Map<string, Group>();
    for (const [index, result] of resolved.entries()) {
      if (result.status === "rejected") {
        outcomes[index] = result;
        continue;
      }
      const capture = captured[index]!;
      if (capture.status !== "fulfilled") {
        throw new Error("Session database resolution lost its captured source");
      }
      const source = capture.value;
      outcomes[index] = {
        status: "fulfilled",
        value: {
          assertCurrent: source.assertCurrent,
          env: source.env,
          get execution() {
            return source.execution;
          },
        },
      };
      if (result.value) {
        const group: Group = groups.get(result.value.key) ?? { target: result.value, members: [] };
        group.members.push({ index, capture: source, target: result.value });
        groups.set(result.value.key, group);
      }
    }
    await Promise.all(
      [...groups.values()].map(async ({ target, members }) => {
        try {
          const assertCurrent = () => {
            for (const { capture } of members) {
              capture.assertHeld();
            }
          };
          assertCurrent();
          const identity = target.identity;
          const execution = captureOpenClawAgentDatabaseExecution(
            target.options,
            identity.key.startsWith("file:")
              ? {
                  expectedIdentity: {
                    kind: "file",
                    physicalIdentity: identity.key.slice("file:".length),
                    nativeLocation: identity.canonicalPath,
                    birthtime: identity.birthtime,
                  },
                }
              : { expectedCreationIdentity: identity },
          );
          // The physical cohort keeps one native lease; each caller retains its original alias.
          for (const member of members) {
            member.capture.begin(member.target.options.path, execution);
          }
          await prepareSessionEntryReplacementDatabase(target.options, assertCurrent, execution);
          for (const member of members) {
            member.capture.finish(member.target.options.path, member.target.identity);
          }
          assertCurrent();
        } catch (reason) {
          for (const { index } of members) {
            outcomes[index] = { status: "rejected", reason };
          }
        }
      }),
    );
    return outcomes;
  })();
  const preparations = targets.map((_, index) =>
    promotion.then((outcomes) => {
      const result = outcomes[index]!;
      if (result.status === "rejected") {
        throw result.reason;
      }
      result.value.assertCurrent();
      return result.value;
    }),
  );
  for (const preparation of preparations) {
    void preparation.catch(() => {});
  }
  return {
    preparations,
    async [Symbol.asyncDispose]() {
      await promotion.catch(() => {});
      const released = await Promise.allSettled(
        captured.flatMap((capture) =>
          capture.status === "fulfilled" ? [capture.value.release()] : [],
        ),
      );
      const errors = released.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) {
        throw createSqliteLifecycleAggregateError(
          errors,
          "Session database preparation cleanup failed",
          errors[0],
        );
      }
    },
  };
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
  const agentId = captured.agentId ?? resolveAgentIdFromSessionKey(captured.sessionKey);
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
  const { normalizedKey, legacyKeys, ...context } = readSessionCreationSnapshotInDatabase(
    creationDatabase,
    captured.sessionKey,
    options.label,
  );
  return await withSessionEntryCreationPublication<SessionEntryCreateWithTranscriptResult<TError>>(
    { database: creationDatabase, agentId, sessionKey: normalizedKey, bind: options.bindCreation },
    async (operation) => {
      options.onPhase?.("entry");
      const created = await createEntry(context);
      if (!created.ok) {
        return { ok: false, error: created.error, phase: "entry" };
      }
      const ownerAssignment = options.resolveOwnerAssignment?.();
      const { cwd, commitGuard, withCommit: withSourceCommit, onLifecycleCommitted } = options;
      const withCommit: typeof options.withCommit = withSourceCommit
        ? (run) =>
            withSourceCommit((assertCurrent) =>
              runWithSessionEntryCreationPublication(operation, () => run(assertCurrent)),
            )
        : undefined;

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
      options.onPhase?.("transcript");
      const transcriptError = created.transcriptEvents
        ? undefined
        : withCommit
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
      options.onPhase?.("commit");
      await applySessionEntryLifecycleMutation({
        ...storeScope,
        removals: legacyKeys.map((sessionKey) => ({ sessionKey })),
        upserts: [{ sessionKey: normalizedKey, entry }],
        skipMaintenance: true,
        beforeCommitInTransaction: () => {
          commitGuard?.();
          assertSessionCreationLabelAvailable(creationDatabase, normalizedKey, options.label);
        },
        ...(withCommit ? { withCommit } : {}),
        afterFreshUpsertsInTransaction: (database) => {
          if (created.transcriptEvents) {
            appendTranscriptEventsInTransaction(
              database,
              { ...resolved, sessionKey: normalizedKey, sessionId: entry.sessionId },
              created.transcriptEvents,
            );
          }
          if (
            ownerAssignment &&
            !replaceSessionOwnerInTransaction(database, normalizedKey, ownerAssignment)
          ) {
            throw new Error(`Session owner assignment lost its target: ${normalizedKey}`);
          }
        },
        ...(onLifecycleCommitted
          ? { onLifecycleCommitted: () => onLifecycleCommitted(entry) }
          : {}),
        ...(options.afterCommitted
          ? { afterCommitted: (source) => options.afterCommitted!(entry, source) }
          : {}),
      });
      return { ok: true, entry, sessionFile: normalizedKey };
    },
  );
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
