import { AsyncLocalStorage } from "node:async_hooks";
import { toUSVString } from "node:util";
import { ok } from "@openclaw/normalization-core/result";
import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { captureOpenClawAgentDatabaseReadValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import type { AgentDatabaseGenerationClaim } from "../../state/openclaw-agent-execution-admission-contract.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import type { SessionActorTarget } from "./session-actor-contract.js";
import {
  readSessionActorEntryFacts,
  retainSessionActorEntryFacts,
} from "./session-actor-replica.js";
import type {
  SessionEntryCohortRequest,
  SessionEntryCohortResult,
  SessionExactEntriesWorkerRequest,
  SessionExactEntriesWorkerResult,
} from "./session-entry-read.types.js";
import { attachSessionEntrySnapshots } from "./session-entry-snapshots.js";
import { runLockedSessionTranscriptRead } from "./session-transcript-execution-read.js";
import { withTranscriptLockSettlement } from "./session-transcript-lock-settlement.js";
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionHistoryWorkerDatabase,
} from "./session-transcript-worker.types.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

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
type FileTarget = SessionActorTarget & {
  database: Extract<SessionActorTarget["database"], { kind: "file" }>;
};

function eligible(request: Selection): request is Selection & { sessionKeys: readonly string[] } {
  return (
    !request.selection &&
    request.sessionKeys !== undefined &&
    request.sessionKeys.length <= MAX_SESSION_ROW_FACTS_KEYS &&
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

function captureTarget(database: Database, sessionKey: string): FileTarget | undefined {
  const identity = readDatabasePathIdentitySync(database.path);
  if (!identity.key.startsWith("file:")) {
    return undefined;
  }
  return {
    sessionKey: toUSVString(sessionKey),
    database: {
      kind: "file",
      physicalIdentity: identity.key.slice("file:".length),
      nativeLocation: identity.canonicalPath,
      birthtime: identity.birthtime,
    },
  };
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
  const before = readSqliteDatabaseWriteTokenForPath(database.path);
  if (!before) {
    return undefined;
  }
  const validation = captureOpenClawAgentDatabaseReadValidation(database);
  if (!validation || Atomics.load(new Int32Array(validation.validation.canonicalReady), 0) !== 1) {
    return undefined;
  }
  nativeOwner?.assertCurrent();
  const projection = request.snapshotFields ?? "full";
  const entries: SessionEntryCohortResult["entries"] = [];
  const members: NonNullable<SessionEntryCohortResult["members"]> = {};
  const participantRecords: NonNullable<SessionEntryCohortResult["participantRecords"]> = {};
  let source: SessionEntryCohortResult["source"] | undefined;
  let databaseIdentity: SessionEntryCohortResult["databaseIdentity"] | undefined;
  for (const key of request.sessionKeys) {
    const target = captureTarget(database, key);
    if (
      !target ||
      (request.expectedIdentity &&
        (request.expectedIdentity.key !== `file:${target.database.physicalIdentity}` ||
          (request.expectedIdentity.birthtime !== undefined &&
            request.expectedIdentity.birthtime !== target.database.birthtime))) ||
      (nativeOwner && nativeOwner.identity !== target.database.physicalIdentity)
    ) {
      return undefined;
    }
    const facts = readSessionActorEntryFacts(target);
    if (
      !facts ||
      (facts.snapshots !== "full" &&
        (projection === "full" || projection.some((field) => !facts.snapshots.includes(field)))) ||
      (request.includeMembers && facts.members === undefined) ||
      (request.includeParticipantRecords && facts.participants === undefined)
    ) {
      return undefined;
    }
    const incarnation = nativeOwner?.incarnation ?? facts.incarnation;
    if (request.expected && incarnation !== request.expected.incarnation) {
      return undefined;
    }
    source = {
      agentId: database.agentId,
      path: database.path,
      databaseIdentity: target.database.physicalIdentity,
      databaseBirthtime: target.database.birthtime,
    };
    databaseIdentity = {
      identity: target.database.physicalIdentity,
      incarnation,
      filename: database.path,
      canonicalPath: target.database.nativeLocation,
      birthtime: target.database.birthtime,
    };
    if (facts.entry) {
      entries.push({
        sessionKey: key,
        entry: attachSessionEntrySnapshots(facts.entry, {}, projection),
      });
      if (facts.members) {
        members[key] = facts.members;
      }
      if (facts.participants?.length) {
        participantRecords[key] = facts.participants;
      }
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
  if (
    !source ||
    !databaseIdentity ||
    readSqliteDatabaseWriteTokenForPath(database.path) !== before
  ) {
    return undefined;
  }
  return {
    kind: "session-exact-entries",
    entries,
    members,
    participantRecords,
    lifecycleTimestamps: {},
    source,
    databaseIdentity,
  };
}

/** A cold batched read seeds the same owner that receives committed actor postimages. */
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
  const byKey = new Map(
    result.entries.map(({ sessionKey, entry }) => [toUSVString(sessionKey), entry]),
  );
  for (const key of request.sessionKeys) {
    const target = captureTarget(database, key);
    if (
      !target ||
      target.database.physicalIdentity !== result.source.databaseIdentity ||
      target.database.birthtime !== result.source.databaseBirthtime
    ) {
      return;
    }
    const previous = readSessionActorEntryFacts(target);
    const entry = byKey.get(toUSVString(key));
    const fields = request.snapshotFields ?? "full";
    retainSessionActorEntryFacts(
      target,
      {
        entry: previous?.entry && entry ? { ...previous.entry, ...entry } : entry,
        snapshots:
          previous?.snapshots === "full" || fields === "full"
            ? "full"
            : [...new Set([...(previous?.snapshots ?? []), ...fields])],
        members: result.members ? (result.members[key] ?? []) : previous?.members,
        participants: result.participantRecords
          ? (result.participantRecords[key] ?? [])
          : previous?.participants,
      },
      result.databaseIdentity.incarnation,
    );
  }
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

/** Preserve the plain reader's error codec while reusing the complete MAIN entry projection. */
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
