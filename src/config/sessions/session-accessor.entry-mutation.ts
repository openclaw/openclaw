import { resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import {
  assertDatabasePathIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { patchSessionEntryCore } from "./session-accessor.entry.js";
import { captureMemoryExactSessionReader } from "./session-accessor.memory-exact-read.js";
import { createSessionEntryWithTranscriptInScope } from "./session-accessor.sqlite-creation.js";
import { hasPreparedNativeSessionDeletion } from "./session-accessor.sqlite-deletion.js";
import { prepareSessionEntryReplacementDatabase } from "./session-accessor.sqlite-replacement-worker.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteScope,
  prepareSqliteScope,
  resolveSqliteWriteAdmissionScope,
  runExclusiveSqliteSessionWrite,
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
import { createSessionActorEntryWithTranscriptInScope } from "./session-actor-entry-adapter.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import {
  captureExternalSessionCommitGuard,
  sessionEntryCommitGuardOptions,
  type SessionSourceCheck,
  type AsyncSessionSourceCheck,
} from "./session-source-authority.js";
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

type SessionEntryDatabasePreparationSource = {
  database: { agentId: string; path: string };
  identity: DatabasePathIdentity;
  selectedStore: { path: string; physicalPath: string };
};

/** Capture discovery inputs; the selected execution owns physical identity after resolution. */
function captureSessionEntryDatabasePreparation(
  scope: SessionAccessScope,
  assertCurrent: () => void,
  relatedScopes: readonly SessionAccessScope[] = [],
  expectedSource?: SessionEntryDatabasePreparationSource,
) {
  const captureScope = (source: SessionAccessScope) => ({
    ...source,
    env: Object.freeze(captureSessionTranscriptStorageEnvironment(source.env ?? process.env)),
  });
  const memory = captureMemoryExactSessionReader(scope, assertCurrent);
  const captured = captureScope(
    memory
      ? {
          ...scope,
          env: { ...scope.env, OPENCLAW_STATE_DIR: resolvePath(memory.path, "../../../..") },
        }
      : scope,
  );
  const target = {
    ...captured,
    agentId: captured.agentId ?? resolveAgentIdFromSessionKey(captured.sessionKey),
    storePath: resolveSessionStorePathForScope(captured),
  };
  const candidates = (memory ? [] : [target, ...relatedScopes.map(captureScope)]).flatMap(
    (related) =>
      captureSessionStoreReadCandidates(resolveSessionStorePathForScope(related)).map((candidate) =>
        Object.assign(candidate, {
          identity: readDatabasePathIdentitySync(candidate.path),
        }),
      ),
  );
  const expected = expectedSource && {
    database: { ...expectedSource.database },
    identity: { ...expectedSource.identity },
    selectedStore: { ...expectedSource.selectedStore },
  };
  if (expected) {
    assertCurrent();
    const selected = captureSessionStoreReadCandidate(expected.selectedStore.path);
    if (
      selected.path !== expected.selectedStore.path ||
      !isSessionStoreReadCandidateCurrent(expected.selectedStore)
    ) {
      throw new Error("Session creation lost its originally captured database source");
    }
    assertSessionStoreReadCandidate(expected.database.path, [
      { ...expected.selectedStore, path: expected.selectedStore.physicalPath },
    ]);
    assertDatabasePathIdentity(selected.path, expected.identity);
    assertSessionStoreReadCandidate(selected.path, candidates);
    if (!candidates.some((candidate) => candidate.path === selected.path && !candidate.scope)) {
      candidates.push({ ...selected, identity: expected.identity });
    }
  }
  let execution: OpenClawAgentDatabaseExecution | undefined;
  const assertSourceCurrent = () => {
    memory?.assertCurrent();
    execution?.assertCurrent();
    if (expected && !isSessionStoreReadCandidateCurrent(expected.selectedStore)) {
      throw new Error("Session creation database alias changed during preparation");
    }
  };
  const assertHeld = () => {
    assertCurrent();
    assertSourceCurrent();
  };
  return {
    assertCurrent: assertSourceCurrent,
    env: target.env,
    get execution() {
      return execution;
    },
    assertHeld,
    release: async () => {
      await execution?.release();
    },
    async resolve() {
      assertHeld();
      if (memory) {
        return undefined;
      }
      const resolved = captureLifecycleDatabaseScope(
        isMainThread ? await prepareSqliteScope(target) : resolveSqliteScope(target),
      );
      assertHeld();
      const options = { ...toDatabaseOptions(resolved), path: resolved.path };
      if (
        expected &&
        (options.agentId !== expected.database.agentId ||
          options.path !== expected.selectedStore.path)
      ) {
        throw new Error("Session creation resolved a different database source");
      }
      if (expected) {
        assertSessionStoreReadCandidate(options.path, [expected.selectedStore]);
      }
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
        original = {
          ...captureSessionStoreReadCandidate(resolved.path),
          identity,
        };
        candidates.push(original);
      }
      return {
        options,
        identity: original.identity,
        key: JSON.stringify([
          options.agentId,
          target.env.OPENCLAW_STATE_DIR,
          original.identity.key,
          original.identity.birthtime,
        ]),
      };
    },
    begin(retained: OpenClawAgentDatabaseExecution) {
      execution = retained;
    },
  };
}

/** Settle every selected writer before any facts snapshot, retaining borrowers without FIFO permits. */
export function prepareSessionEntryMutationDatabases(
  targets: readonly {
    scope: SessionAccessScope;
    assertCurrent: () => void;
    relatedScopes?: readonly SessionAccessScope[];
    expectedSource?: SessionEntryDatabasePreparationSource;
    followRegistration?: SessionEntryCreateWithTranscriptOptions["followRegistration"];
  }[],
  ready: Promise<void>,
) {
  void ready.catch(() => {});
  type Capture = ReturnType<typeof captureSessionEntryDatabasePreparation>;
  type Resolved = NonNullable<Awaited<ReturnType<Capture["resolve"]>>>;
  type Prepared = Pick<Capture, "assertCurrent" | "execution" | "env">;
  type Group = {
    target: Resolved;
    members: Array<{ index: number; capture: Capture }>;
  };
  const captured = targets.map((target): PromiseSettledResult<Capture> => {
    try {
      return {
        status: "fulfilled",
        value: captureSessionEntryDatabasePreparation(
          target.scope,
          target.assertCurrent,
          target.relatedScopes,
          target.expectedSource,
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
        return { source: capture.value, target: await capture.value.resolve() };
      }),
    );
    const outcomes: PromiseSettledResult<Prepared>[] = [];
    const groups = new Map<string, Group>();
    for (const [index, result] of resolved.entries()) {
      if (result.status === "rejected") {
        outcomes[index] = result;
        continue;
      }
      const { source, target } = result.value;
      outcomes[index] = {
        status: "fulfilled",
        value: source,
      };
      if (target) {
        const group: Group = groups.get(target.key) ?? { target, members: [] };
        group.members.push({ index, capture: source });
        groups.set(target.key, group);
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
          // One physical execution serves the cohort; caller guards still authorize preparation.
          for (const member of members) {
            member.capture.begin(execution);
          }
          await prepareSessionEntryReplacementDatabase(
            target.options,
            assertCurrent,
            execution,
            (change) => {
              for (const { index } of members) {
                targets[index]!.followRegistration?.(change);
              }
            },
          );
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
  const memory = await createSessionActorEntryWithTranscriptInScope(scope, createEntry, options);
  if (memory) {
    return memory;
  }
  const captured = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const storePath = resolveSessionStorePathForScope(captured);
  const agentId = captured.agentId ?? resolveAgentIdFromSessionKey(captured.sessionKey);
  const target = { ...captured, agentId, storePath };
  // Preserve earlier queued writes for existing-key adoption and protect shared-store
  // discovery from sibling cold registration. Commit custody is acquired separately.
  const admission = isMainThread ? resolveSqliteWriteAdmissionScope(target) : undefined;
  const prepare = () => prepareSqliteScope(target);
  const resolved = captureLifecycleDatabaseScope(
    isMainThread
      ? admission
        ? await runExclusiveSqliteSessionWrite(
            admission,
            prepare,
            "session.entry.create-with-transcript",
          )
        : await prepare()
      : resolveSqliteScope(target),
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
export async function resolveSessionAbortTarget(
  scope: SessionAccessScope,
): Promise<SessionAbortTargetIdentity | null> {
  const entry = await readSessionEntryReadOnlyInWorker(scope);
  if (!entry) {
    return null;
  }
  return {
    entry: { ...entry },
    sessionId: entry.sessionId,
    sessionKey: normalizeStoreSessionKey(scope.sessionKey),
  };
}

export function matchesSessionAbortTargetOwner(
  entry: SessionEntry,
  expected: Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "activeWriterRunId">,
): boolean {
  return (
    entry.sessionId === expected.sessionId &&
    entry.lifecycleRevision === expected.lifecycleRevision &&
    entry.activeWriterRunId === expected.activeWriterRunId
  );
}

/**
 * Resolves, marks, touches, and canonicalizes one abort target entry as a
 * storage-sized operation. Runtime abort side effects remain with callers.
 */
export async function markSessionAbortTarget(params: {
  isCurrent?: SessionSourceCheck | AsyncSessionSourceCheck;
  expectedTarget?: Pick<
    SessionEntry,
    "sessionId" | "lifecycleRevision" | "activeWriterRunId"
  > | null;
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
        if (
          (!params.isCurrent?.sessionSource && params.isCurrent?.() === false) ||
          params.expectedTarget === null ||
          (params.expectedTarget &&
            !matchesSessionAbortTargetOwner(currentEntry, params.expectedTarget))
        ) {
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
        ...sessionEntryCommitGuardOptions(
          params.isCurrent?.sessionSource ??
            (params.isCurrent &&
              captureExternalSessionCommitGuard(() => {
                if (resolution.target && params.isCurrent?.() === false) {
                  throw new Error("The selected session changed before it could be stopped.");
                }
              })),
        ),
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
