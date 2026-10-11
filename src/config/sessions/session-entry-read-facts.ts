import { AsyncLocalStorage } from "node:async_hooks";
import { toUSVString } from "node:util";
import { ok } from "@openclaw/normalization-core/result";
import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { sessionChangeAffectsStoredRow } from "../../sessions/session-row-facts.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { captureOpenClawAgentDatabaseReadValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import type { AgentDatabaseGenerationClaim } from "../../state/openclaw-agent-execution-admission-contract.js";
import {
  readPreparedSessionEntryChange,
  readPreparedSessionEntryPublicationSource,
} from "./session-accessor.sqlite-entry-cache-publication-state.js";
import type { SessionParticipantRecord } from "./session-accessor.sqlite-participant-projection.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import type {
  SessionEntryCohortRequest,
  SessionEntryCohortResult,
  SessionExactEntriesWorkerRequest,
  SessionExactEntriesWorkerResult,
} from "./session-entry-read.types.js";
import {
  attachSessionEntrySnapshots,
  type SessionEntrySnapshotField,
} from "./session-entry-snapshots.js";
import type { SessionMember } from "./session-membership-facts.types.js";
import { runLockedSessionTranscriptRead } from "./session-transcript-execution-read.js";
import { withTranscriptLockSettlement } from "./session-transcript-lock-settlement.js";
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionHistoryWorkerDatabase,
} from "./session-transcript-worker.types.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type Database = { agentId: string; path: string };
type WriterReads = {
  entry: (
    scope: SessionEntryReadScope & { agentId: string },
  ) => ReturnType<SessionHistoryWorkerDatabase["readEntryResult"]>;
  entries: (request: SessionEntryCohortRequest) => Promise<SessionExactEntriesWorkerResult>;
};
type WriterReadContext = {
  database: Database;
  reads: WriterReads;
  queue: <T>(read: () => Promise<T>) => Promise<T>;
  active: boolean;
  parent?: WriterReadContext;
};
const writerReads = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionEntryWriterReads"),
  () => new AsyncLocalStorage<WriterReadContext>(),
);

/** The writer lends its execution and settles accepted reads before releasing its FIFO turn. */
export async function withSessionEntryWriterReads<T>(
  database: Database,
  reads: WriterReads,
  run: () => Promise<T>,
): Promise<T> {
  return withTranscriptLockSettlement(async (queue) => {
    const context: WriterReadContext = {
      database,
      reads,
      queue,
      active: true,
      parent: writerReads.getStore(),
    };
    try {
      return await writerReads.run(context, run);
    } finally {
      context.active = false;
    }
  });
}

function readFromSessionWriter<T>(
  database: Database & { env: NodeJS.ProcessEnv },
  read: (reads: WriterReads) => Promise<T>,
): Promise<T> | undefined {
  let context = writerReads.getStore();
  while (context) {
    if (
      context.active &&
      context.database.agentId === database.agentId &&
      context.database.path === database.path
    ) {
      const reads = context.reads;
      // Transcript appends have their own acceptance queue, including a nested preparation
      // queue. Joining it prevents a read from overtaking an accepted, not-yet-dispatched write.
      return (
        runLockedSessionTranscriptRead(database, () => read(reads)) ??
        context.queue(() => read(reads))
      );
    }
    context = context.parent;
  }
  return undefined;
}

type Selection = Omit<SessionExactEntriesWorkerRequest, "env"> &
  Partial<
    Pick<
      SessionEntryCohortRequest,
      | "transcript"
      | "runtimeTarget"
      | "includeColdMetadata"
      | "includeAuthProfileSource"
      | "expected"
    >
  >;
type Facts = {
  token: string;
  entry: SessionEntry | undefined;
  snapshots: "full" | readonly SessionEntrySnapshotField[];
  members?: SessionMember[];
  participantRecords?: SessionParticipantRecord[];
  bytes: number;
};
type Store = {
  source: SessionEntryCohortResult["source"];
  identity: SessionEntryCohortResult["databaseIdentity"];
  rows: Map<string, Facts>;
  bytes: number;
};

// This is the entry reader's retained fact set, shared by standalone and admitted reads.
// Bound saved prompts as well as key count; eviction has no persistence or authority effect.
const MAX_DATABASES = 32;
const MAX_ROWS = 128;
const MAX_BYTES = 8 * 1024 * 1024;
const stores = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionEntryReadFacts"),
  () => new Map<string, Store>(),
);

function keyOf(source: Store["source"]) {
  return `${source.databaseIdentity}:${source.databaseBirthtime ?? ""}`;
}

function remove(store: Store, key: string) {
  const previous = store.rows.get(key);
  if (previous) {
    store.bytes -= previous.bytes;
    store.rows.delete(key);
  }
}

function install(store: Store, key: string, input: Omit<Facts, "bytes">) {
  remove(store, key);
  const bytes = JSON.stringify(input).length * 2;
  if (bytes > MAX_BYTES) {
    return;
  }
  const facts = structuredClone({ ...input, bytes });
  store.rows.set(key, facts);
  store.bytes += bytes;
  while (store.rows.size > MAX_ROWS || store.bytes > MAX_BYTES) {
    const oldest = store.rows.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    remove(store, oldest);
  }
}

function remember(store: Store) {
  const key = keyOf(store.source);
  stores.delete(key);
  stores.set(key, store);
  while (stores.size > MAX_DATABASES) {
    const oldest = stores.keys().next().value;
    if (oldest !== undefined) {
      stores.delete(oldest);
    }
  }
}

function eligible(request: Selection): request is Selection & { sessionKeys: readonly string[] } {
  return (
    !request.selection &&
    request.sessionKeys !== undefined &&
    request.sessionKeys.length <= MAX_SESSION_ROW_FACTS_KEYS &&
    // A single-key postimage cannot certify a case-folded sibling's canonical guard.
    request.sessionKeys.every((key) => {
      const candidates = collectSessionEntryLookupKeys(key);
      return candidates.length === 1 && candidates[0] === key;
    }) &&
    (request.projection === undefined ||
      request.projection === "full" ||
      request.projection === "exact") &&
    !request.lifecycleSessionKey &&
    !request.replyInitializationSessionKey &&
    !request.manualCompact &&
    !request.transcript &&
    !request.runtimeTarget &&
    !request.includeAuthProfileSource &&
    !request.includeColdMetadata
  );
}

function snapshots(request: Selection): Facts["snapshots"] {
  return request.projection === "list" ? [] : (request.snapshotFields ?? "full");
}

function matches(store: Store, database: Database) {
  if (store.source.agentId !== database.agentId || store.source.path !== database.path) {
    return false;
  }
  const current = readDatabasePathIdentitySync(database.path);
  return (
    current.key === `file:${store.source.databaseIdentity}` &&
    current.birthtime === store.source.databaseBirthtime
  );
}

/** Hits require the current committed write token; callers keep their own live assertions. */
export function readRetainedSessionEntryFacts(
  database: Database,
  request: Selection,
  nativeOwner?: AgentDatabaseGenerationClaim,
): SessionEntryCohortResult | undefined {
  if (!eligible(request)) {
    return undefined;
  }
  const token = readSqliteDatabaseWriteTokenForPath(database.path);
  const validation = captureOpenClawAgentDatabaseReadValidation(database);
  if (
    !token ||
    !validation ||
    Atomics.load(new Int32Array(validation.validation.canonicalReady), 0) !== 1
  ) {
    return undefined;
  }
  nativeOwner?.assertCurrent();
  for (const store of stores.values()) {
    if (
      !matches(store, database) ||
      (request.expectedIdentity &&
        (request.expectedIdentity.key !== `file:${store.source.databaseIdentity}` ||
          (request.expectedIdentity.birthtime !== undefined &&
            request.expectedIdentity.birthtime !== store.source.databaseBirthtime))) ||
      (nativeOwner && nativeOwner.identity !== store.source.databaseIdentity) ||
      (request.expected &&
        (nativeOwner?.incarnation ?? store.identity.incarnation) !== request.expected.incarnation)
    ) {
      continue;
    }
    const selected = request.sessionKeys.map((key) => ({
      key,
      facts: store.rows.get(toUSVString(key)),
    }));
    const projection = snapshots(request);
    if (
      selected.some(
        ({ facts }) =>
          !facts ||
          facts.token !== token ||
          (facts.snapshots !== "full" &&
            (projection === "full" ||
              projection.some((field) => !facts.snapshots.includes(field)))) ||
          (request.includeMembers && facts.members === undefined) ||
          (request.includeParticipantRecords && facts.participantRecords === undefined),
      )
    ) {
      return undefined;
    }
    const entries: SessionEntryCohortResult["entries"] = [];
    const members: NonNullable<SessionEntryCohortResult["members"]> = {};
    const participantRecords: NonNullable<SessionEntryCohortResult["participantRecords"]> = {};
    for (const { key, facts } of selected) {
      if (!facts) {
        return undefined;
      }
      store.rows.delete(toUSVString(key));
      store.rows.set(toUSVString(key), facts);
      if (facts.entry) {
        entries.push({
          sessionKey: key,
          entry: attachSessionEntrySnapshots(
            structuredClone(facts.entry),
            {},
            projection === "full" ? "full" : projection,
          ),
        });
      }
      if (facts.entry && facts.members) {
        members[key] = structuredClone(facts.members);
      }
      if (facts.entry && facts.participantRecords?.length) {
        participantRecords[key] = structuredClone(facts.participantRecords);
      }
    }
    for (const expected of request.expected?.sessions ?? []) {
      const entry = entries.find(({ sessionKey }) => sessionKey === expected.sessionKey)?.entry;
      if (
        !entry ||
        entry.sessionId !== expected.sessionId ||
        entry.lifecycleRevision !== expected.lifecycleRevision
      ) {
        return undefined;
      }
    }
    validation.assertCurrent();
    nativeOwner?.assertCurrent();
    if (readSqliteDatabaseWriteTokenForPath(database.path) !== token) {
      return undefined;
    }
    remember(store);
    return {
      kind: "session-exact-entries",
      entries,
      members,
      participantRecords,
      lifecycleTimestamps: {},
      source: { ...store.source },
      databaseIdentity: {
        ...store.identity,
        // Physical facts are shared across handles; a cohort keeps its own live native owner.
        ...(nativeOwner ? { incarnation: nativeOwner.incarnation } : {}),
      },
    };
  }
  return undefined;
}

/** A reply is reusable only when no writer settled between request admission and installation. */
export function retainSessionEntryReadFacts(
  database: Database,
  request: Selection,
  result: SessionExactEntriesWorkerResult,
  before: string | undefined,
): void {
  if (
    !eligible(request) ||
    !before ||
    before !== readSqliteDatabaseWriteTokenForPath(database.path) ||
    !result.source ||
    !result.databaseIdentity
  ) {
    return;
  }
  const store = stores.get(keyOf(result.source)) ?? {
    source: result.source,
    identity: result.databaseIdentity,
    rows: new Map<string, Facts>(),
    bytes: 0,
  };
  if (!matches(store, database)) {
    return;
  }
  store.identity = result.databaseIdentity;
  const byKey = new Map(
    result.entries.map(({ sessionKey, entry }) => [toUSVString(sessionKey), entry]),
  );
  for (const key of request.sessionKeys) {
    const previous = store.rows.get(toUSVString(key));
    const retained = previous?.token === before ? previous : undefined;
    const entry = byKey.get(toUSVString(key));
    const fields = snapshots(request);
    install(store, toUSVString(key), {
      token: before,
      entry: retained?.entry && entry ? { ...retained.entry, ...entry } : entry,
      snapshots:
        retained?.snapshots === "full" || fields === "full"
          ? "full"
          : [...new Set([...(retained?.snapshots ?? []), ...fields])],
      members: result.members ? (result.members[key] ?? []) : retained?.members,
      participantRecords: result.participantRecords
        ? (result.participantRecords[key] ?? [])
        : retained?.participantRecords,
    });
  }
  remember(store);
}

/**
 * Standalone reads stay off the writer FIFO, like the plain reader they replace. Retained facts
 * are keyed by the committed write token, so a hit or an install never outlives a commit.
 */
export async function readSessionEntriesWithRetainedFacts(
  database: Database & { env: NodeJS.ProcessEnv },
  request: Selection,
  read: () => Promise<SessionExactEntriesWorkerResult>,
): Promise<SessionExactEntriesWorkerResult> {
  if (!eligible(request)) {
    return await read();
  }
  const borrowed = readFromSessionWriter(database, (reads) => reads.entries(request));
  if (borrowed) {
    return await borrowed;
  }
  const cached = readRetainedSessionEntryFacts(database, request);
  if (cached) {
    return cached;
  }
  const before = readSqliteDatabaseWriteTokenForPath(database.path);
  const result = await read();
  retainSessionEntryReadFacts(database, request, result, before);
  return result;
}

/** Preserve the plain reader's error codec while retaining its successful fused facts. */
export async function readSessionEntryWithRetainedFacts(
  database: Database & { env: NodeJS.ProcessEnv },
  scope: SessionEntryReadScope & { agentId: string },
  read: () => ReturnType<SessionHistoryWorkerDatabase["readEntryResult"]>,
): ReturnType<SessionHistoryWorkerDatabase["readEntryResult"]> {
  const borrowed = readFromSessionWriter(database, (reads) => reads.entry(scope));
  if (borrowed) {
    return await borrowed;
  }
  const request = {
    sessionKeys: [resolveSqliteSessionKey(scope.sessionKey, scope.agentId)],
    projection: "full" as const,
    snapshotFields:
      scope.projection === "list" ? [] : scope.projection === "full" ? undefined : scope.projection,
  };
  const cached = readRetainedSessionEntryFacts(database, request);
  if (cached) {
    return { ...ok(cached.entries[0]?.entry), source: cached.source };
  }
  const before = readSqliteDatabaseWriteTokenForPath(database.path);
  const result = await read();
  if (result.ok && result.facts) {
    retainSessionEntryReadFacts(database, request, result.facts, before);
  }
  return result;
}

// Private facts install before projection/public observers. Unknown and partial writes evict;
// only a sealed, complete postimage can replace a prior read without another worker request.
sessionChanges.subscribeFacts((change) => {
  const source = readPreparedSessionEntryPublicationSource(change);
  for (const store of stores.values()) {
    if (
      !sessionChangeAffectsStoredRow(change, {
        agentId: store.source.agentId,
        sessionKeys: [...store.rows.keys()],
        storePaths: new Set([store.source.path]),
        databaseIdentities: new Set([store.source.databaseIdentity]),
      })
    ) {
      continue;
    }
    if ("all" in change) {
      stores.delete(keyOf(store.source));
      continue;
    }
    if (!change.factsInvalidated && (!change.facts || change.facts.kind === "unchanged")) {
      continue;
    }
    const retained = store.rows.get(toUSVString(change.sessionKey));
    if (retained) {
      // Keep the bounded slot through pending invalidation so its COMMIT can install a postimage.
      retained.token = "";
    }
    const prepared =
      !change.factsInvalidated && readPreparedSessionEntryChange(change, change.sessionKey);
    if (
      prepared &&
      prepared.fullEntry &&
      prepared.source.writeToken &&
      source.identity === store.source.databaseIdentity &&
      prepared.source.writeToken === readSqliteDatabaseWriteTokenForPath(store.source.path)
    ) {
      install(store, toUSVString(change.sessionKey), {
        token: prepared.source.writeToken,
        entry: prepared.fullEntry,
        snapshots: "full",
      });
    }
  }
});
