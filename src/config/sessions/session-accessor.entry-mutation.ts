import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { registerOpenClawAgentDatabaseReadCandidateResource } from "../../state/openclaw-agent-db-resources.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { loadSessionEntry, patchSessionEntryCore } from "./session-accessor.entry.js";
import { createSessionEntryWithTranscriptInScope } from "./session-accessor.sqlite-creation.js";
import { hasPreparedNativeSessionDeletion } from "./session-accessor.sqlite-deletion.js";
import { prepareSessionEntryReplacementDatabase } from "./session-accessor.sqlite-replacement-worker.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteScope,
  prepareSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type {
  SessionAccessScope,
  SessionEntryUpdateOptions,
  SessionAbortTargetCutoff,
  SessionAbortTargetContext,
  SessionAbortTargetIdentity,
  SessionAbortTargetResult,
  SessionEntryCreateWithTranscriptContext,
  SessionEntryCreateWithTranscriptResult,
  SessionEntryCreateWithTranscriptPrepareResult,
  SessionEntryCreateWithTranscriptOptions,
} from "./session-accessor.types.js";
import { captureIncognitoSessionBinding } from "./session-incognito-binding.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
  isSessionStoreReadCandidateCurrent,
} from "./session-store-read-candidates.js";
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
  forkSessionTranscriptFromParent as forkSessionFromParentTranscript,
  resolveSessionParentForkDecision,
} from "./session-accessor.sqlite-parent-session.js";

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
    storePath: resolveSessionStorePathForScope(captured),
  };
  const shared = captureOpenClawStateWorkerContext({ env: target.env });
  const candidates = [target, ...relatedScopes.map(captureScope)].flatMap((related) =>
    captureSessionStoreReadCandidates(resolveSessionStorePathForScope(related)).map(
      // Each capture returns fresh candidate objects, so attaching the identity in place is safe.
      (candidate) =>
        Object.assign(candidate, { identity: readDatabasePathIdentitySync(candidate.path) }),
    ),
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
        !isSessionStoreReadCandidateCurrent(candidate) ||
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
      let original = candidates.find(
        (candidate) => candidate.path === resolved.path || candidate.physicalPath === resolved.path,
      );
      if (!original) {
        // A held custom-store family may allocate a new suffix. Never adopt an
        // unobserved existing file or a target outside that original family.
        assertSessionStoreReadCandidate(resolved.path, candidates);
        const identity = readDatabasePathIdentitySync(resolved.path);
        if (!identity.key.startsWith("path:")) {
          throw new Error("Session creation lost its originally captured database target");
        }
        original = { ...captureSessionStoreReadCandidate(resolved.path), identity };
        candidates.push(original);
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
  const storePath = resolveSessionStorePathForScope(captured);
  const agentId = captured.agentId ?? resolveAgentIdFromSessionKey(captured.sessionKey);
  const target = { ...captured, agentId, storePath };
  const incognito = captureIncognitoSessionBinding(target);
  const resolved = captureLifecycleDatabaseScope(
    isMainThread && !incognito ? await prepareSqliteScope(target) : resolveSqliteScope(target),
  );
  return createSessionEntryWithTranscriptInScope(resolved, createEntry, options);
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
  // The guard only rejects a true session-identity rebind. Same-session
  // activity/context writes are merged below; comparing them here would reject
  // before the merge can preserve the concurrent metadata.
  return JSON.stringify(entry ? { sessionId: entry.sessionId } : null);
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
        const cutoff = params.resolveAbortCutoff?.({ entry: { ...currentEntry }, sessionKey });
        entry.abortCutoffMessageSid = cutoff?.messageSid;
        entry.abortCutoffTimestamp = cutoff?.timestamp;
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
        ...fallbackTarget,
        persistenceError: formatErrorMessage(error),
      };
    }
    throw error;
  }
}
