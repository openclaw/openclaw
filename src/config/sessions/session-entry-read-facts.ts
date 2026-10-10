import { toUSVString } from "node:util";
import { ok } from "@openclaw/normalization-core/result";
import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { captureOpenClawAgentDatabaseReadValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import type { AgentDatabaseGenerationClaim } from "../../state/openclaw-agent-execution-admission-contract.js";
import { runOpenClawAgentWriteAdmissions } from "../../state/openclaw-agent-write-admission.js";
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
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionHistoryWorkerDatabase,
} from "./session-transcript-worker.types.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

type Database = { agentId: string; path: string };
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

/** Read the actor's MAIN projection under the caller's existing physical admission. */
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

/** Standalone reads join the same writer queue as admitted cohorts, then release before use. */
export function readSessionEntriesWithRetainedFacts(
  database: Database & { env: NodeJS.ProcessEnv },
  request: Selection,
  read: () => Promise<SessionExactEntriesWorkerResult>,
): Promise<SessionExactEntriesWorkerResult> {
  if (!eligible(request)) {
    return read();
  }
  return runOpenClawAgentWriteAdmissions(
    [database],
    async () => {
      const cached = readRetainedSessionEntryFacts(database, request);
      if (cached) {
        return cached;
      }
      const before = readSqliteDatabaseWriteTokenForPath(database.path);
      const result = await read();
      retainSessionEntryReadFacts(database, request, result, before);
      return result;
    },
    true,
  );
}

/** Preserve the plain reader's error codec while reusing the complete MAIN entry projection. */
export function readSessionEntryWithRetainedFacts(
  database: Database & { env: NodeJS.ProcessEnv },
  scope: SessionEntryReadScope & { agentId: string },
  read: () => ReturnType<SessionHistoryWorkerDatabase["readEntryResult"]>,
): ReturnType<SessionHistoryWorkerDatabase["readEntryResult"]> {
  return runOpenClawAgentWriteAdmissions(
    [database],
    async () => {
      const request = {
        sessionKeys: [resolveSqliteSessionKey(scope.sessionKey, scope.agentId)],
        projection: "full" as const,
        snapshotFields:
          scope.projection === "list"
            ? []
            : scope.projection === "full"
              ? undefined
              : scope.projection,
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
    },
    true,
  );
}
