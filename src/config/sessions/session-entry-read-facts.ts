import { AsyncLocalStorage } from "node:async_hooks";
import { toUSVString } from "node:util";
import { ok } from "@openclaw/normalization-core/result";
import {
  getSqliteDatabaseAdmissionIdentityForPath,
  readSqliteDatabaseWriteTokenForPath,
} from "../../infra/sqlite-database-admission.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { AgentDatabaseGenerationClaim } from "../../state/openclaw-agent-execution-admission-contract.js";
import { resolveTimestamp } from "./lifecycle-timestamps.js";
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
import { runLockedSessionTranscriptRead } from "./session-transcript-execution-read.js";
import { withTranscriptLockSettlement } from "./session-transcript-lock-settlement.js";
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionHistoryWorkerDatabase,
} from "./session-transcript-worker.types.js";
import { collectSessionEntryLookupKeys, normalizeStoreSessionKey } from "./store-entry.js";

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
    request.sessionKeys.length + (request.replyInitializationSessionKey ? 1 : 0) <=
      MAX_SESSION_ROW_FACTS_KEYS &&
    request.sessionKeys.every((key) => {
      const candidates = collectSessionEntryLookupKeys(key);
      return candidates.length === 1 && candidates[0] === key;
    }) &&
    (request.projection === undefined ||
      request.projection === "full" ||
      request.projection === "sharing" ||
      request.projection === "exact") &&
    !request.manualCompact &&
    !request.transcript &&
    !request.includeAuthProfileSource &&
    (request.projection !== "sharing" || (!request.lifecycleSessionKey && !request.runtimeTarget))
  );
}

function captureTarget(database: Database, sessionKey: string): FileTarget | undefined {
  const identity = getSqliteDatabaseAdmissionIdentityForPath(database.path);
  if (!identity?.key.startsWith("file:")) {
    return undefined;
  }
  return {
    sessionKey: toUSVString(sessionKey),
    database: {
      kind: "file",
      physicalIdentity: identity.key.slice("file:".length),
      nativeLocation: database.path,
      birthtime: identity.birthtime,
    },
  };
}

/** Borrow immutable committed facts; callers own edits and live-authority assertions. */
export function readRetainedSessionEntryFacts(
  database: Database,
  request: Selection,
  nativeOwner?: AgentDatabaseGenerationClaim,
): SessionEntryCohortResult | undefined {
  if (!eligible(request)) {
    return undefined;
  }
  nativeOwner?.assertCurrent();
  const projection = request.projection === "sharing" ? [] : (request.snapshotFields ?? "full");
  const entries: SessionEntryCohortResult["entries"] = [];
  const members: NonNullable<SessionEntryCohortResult["members"]> = {};
  const sharingMembers: NonNullable<SessionEntryCohortResult["sharing"]>["members"] = [];
  const participantRecords: NonNullable<SessionEntryCohortResult["participantRecords"]> = {};
  let source: SessionEntryCohortResult["source"] | undefined;
  let databaseIdentity: SessionEntryCohortResult["databaseIdentity"] | undefined;
  const sessionKeys = [...request.sessionKeys];
  for (const key of sessionKeys) {
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
    const facts = readSessionActorEntryFacts(target, projection);
    if (
      !facts ||
      (request.projection === "sharing" && (!facts.entry || facts.members === undefined)) ||
      (facts.snapshots !== "full" &&
        (projection === "full" || projection.some((field) => !facts.snapshots.includes(field)))) ||
      (request.includeMembers && facts.members === undefined) ||
      (request.includeParticipantRecords && facts.participants === undefined) ||
      (request.includeColdMetadata && facts.entry && !facts.coldArchiveAbsent)
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
      if (key === request.replyInitializationSessionKey && facts.entry.parentSessionKey) {
        const parentKey = normalizeStoreSessionKey(facts.entry.parentSessionKey);
        if (parentKey && !sessionKeys.includes(parentKey)) {
          const candidates = collectSessionEntryLookupKeys(parentKey);
          if (candidates.length !== 1 || candidates[0] !== parentKey) {
            return undefined;
          }
          sessionKeys.push(parentKey);
        }
      }
      entries.push({
        sessionKey: key,
        entry: facts.entry,
      });
      if (facts.members) {
        members[key] = facts.members;
        if (request.projection === "sharing") {
          sharingMembers.push({
            sessionKey: key,
            identityIds: facts.members.map(({ identityId }) => identityId),
          });
        }
      }
      if (facts.participants?.length) {
        participantRecords[key] = facts.participants;
      }
    }
  }
  let lifecycleTimestamps: SessionEntryCohortResult["lifecycleTimestamps"] = {};
  if (request.lifecycleSessionKey) {
    const entry = entries.find(
      ({ sessionKey }) => sessionKey === request.lifecycleSessionKey,
    )?.entry;
    const sessionStartedAt = resolveTimestamp(entry?.sessionStartedAt);
    if (sessionStartedAt === undefined) {
      return undefined;
    }
    lifecycleTimestamps = {
      sessionStartedAt,
      lastInteractionAt: resolveTimestamp(entry?.lastInteractionAt),
    };
  }
  const runtimeTarget = request.runtimeTarget;
  if (
    runtimeTarget &&
    !entries.some(
      ({ sessionKey, entry }) =>
        sessionKey === runtimeTarget.sessionKey && entry.sessionId === runtimeTarget.sessionId,
    )
  ) {
    return undefined;
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
  if (!source || !databaseIdentity) {
    return undefined;
  }
  return {
    kind: "session-exact-entries",
    entries,
    members,
    participantRecords,
    lifecycleTimestamps,
    ...(request.includeColdMetadata ? { coldArchives: [] } : {}),
    ...(runtimeTarget ? { runtimeTarget: { ...runtimeTarget, storePath: database.path } } : {}),
    source,
    databaseIdentity,
    ...(request.projection === "sharing"
      ? {
          sharing: {
            source: { agentId: database.agentId, path: database.path },
            databaseIdentity: `file:${databaseIdentity.identity}`,
            members: sharingMembers,
            placeholders: [],
          },
        }
      : {}),
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
  const sessionKeys = [...request.sessionKeys];
  const parent = request.replyInitializationSessionKey
    ? byKey.get(request.replyInitializationSessionKey)?.parentSessionKey
    : undefined;
  const parentKey = parent ? normalizeStoreSessionKey(parent) : undefined;
  if (parentKey && !sessionKeys.includes(parentKey)) {
    const candidates = collectSessionEntryLookupKeys(parentKey);
    if (candidates.length === 1 && candidates[0] === parentKey) {
      sessionKeys.push(parentKey);
    }
  }
  if (sessionKeys.length === 0) {
    return;
  }
  const target = captureTarget(database, sessionKeys[0]!);
  if (
    !target ||
    target.database.physicalIdentity !== result.source.databaseIdentity ||
    target.database.birthtime !== result.source.databaseBirthtime
  ) {
    return;
  }
  const entries = sessionKeys.map((key) => {
    const previous = readSessionActorEntryFacts({ ...target, sessionKey: toUSVString(key) });
    const entry = byKey.get(toUSVString(key));
    const fields = request.projection === "sharing" ? [] : (request.snapshotFields ?? "full");
    return {
      sessionKey: toUSVString(key),
      facts: {
        entry: previous?.entry && entry ? { ...previous.entry, ...entry } : entry,
        snapshots:
          previous?.snapshots === "full" || fields === "full"
            ? "full"
            : [...new Set([...(previous?.snapshots ?? []), ...fields])],
        members: result.members ? (result.members[key] ?? []) : previous?.members,
        participants: result.participantRecords
          ? (result.participantRecords[key] ?? [])
          : previous?.participants,
        projection: previous?.projection,
      } satisfies Parameters<typeof retainSessionActorEntryFacts>[1][number]["facts"],
    };
  });
  retainSessionActorEntryFacts(target.database, entries, result.databaseIdentity.incarnation);
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
