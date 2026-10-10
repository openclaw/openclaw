import type { DatabaseSync } from "node:sqlite";
import type { SessionRowFacts } from "../../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { publishTrackedCacheUpdate } from "./session-accessor.sqlite-entry-cache-state.js";
import {
  projectSessionSharingEntry,
  type SessionEntryCacheDatabase,
} from "./session-accessor.sqlite-entry-cache.types.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import {
  updateSessionSharingField,
  type CommittedSessionSharingFacts,
} from "./session-accessor.sqlite-sharing-acquisition.js";
import { projectSessionEntryCapabilityFacts } from "./session-entry-capability-facts.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import type { SessionEntry } from "./types.js";

type IncognitoSessionSharingFacts = CommittedSessionSharingFacts & {
  capability?: ReturnType<typeof projectSessionEntryCapabilityFacts>;
  steering?: Pick<
    SessionEntry,
    | "sessionId"
    | "updatedAt"
    | "status"
    | "restartRecoveryDeliveryRunId"
    | "restartRecoveryDeliverySourceRunId"
    | "restartRecoveryDeliveryReceiptState"
    | "restartRecoveryDeliveryToolCallId"
    | "restartRecoveryTerminalRunIds"
  >;
};

// Process-held stores cannot be reopened in a worker. Their existing writer publishes
// content-free metadata, bounded by live entries and the native database's lifetime.
const incognitoSharingEntries = resolveGlobalSingleton(
  Symbol.for("openclaw.incognitoSessionSharingEntries"),
  () =>
    new WeakMap<
      DatabaseSync,
      {
        entries: Map<string, IncognitoSessionSharingFacts | null>;
        pending: Map<string, Map<object, IncognitoSessionSharingFacts | null | undefined>>;
      }
    >(),
);

function incognitoSharingState(database: DatabaseSync) {
  let state = incognitoSharingEntries.get(database);
  if (!state) {
    state = { entries: new Map(), pending: new Map() };
    incognitoSharingEntries.set(database, state);
  }
  return state;
}

export function stageIncognitoSharingPublication(
  database: DatabaseSync,
  sessionKey: string,
  current?: { facts: IncognitoSessionSharingFacts | null | undefined },
) {
  const state = incognitoSharingState(database);
  const token = {};
  const pending =
    state.pending.get(sessionKey) ??
    new Map<object, IncognitoSessionSharingFacts | null | undefined>();
  state.pending.set(sessionKey, pending);
  let facts = current ? current.facts : state.entries.get(sessionKey);
  if (!current) {
    for (const staged of pending.values()) {
      facts = staged;
    }
  }
  pending.set(token, facts);
  return () => {
    pending.delete(token);
    if (pending.size === 0) {
      state.pending.delete(sessionKey);
    }
  };
}

export function commitIncognitoSessionSharingFacts(
  database: DatabaseSync,
  sessionKey: string,
  facts: IncognitoSessionSharingFacts | null | undefined,
): void {
  const entries = incognitoSharingState(database).entries;
  if (facts !== undefined) {
    entries.set(sessionKey, facts);
  } else {
    entries.delete(sessionKey);
  }
}

export function commitIncognitoSessionSharingField(
  database: DatabaseSync,
  sessionKey: string,
  change: Extract<SessionRowFacts, { kind: "member" | "owner" | "category" }>,
): void {
  const entries = incognitoSharingEntries.get(database)?.entries;
  const current = entries?.get(sessionKey);
  if (current) {
    entries?.set(sessionKey, updateSessionSharingField(current, change));
  }
}

export function readCommittedIncognitoSessionSharing(database: DatabaseSync, sessionKey: string) {
  const state = incognitoSharingEntries.get(database);
  if (state?.pending.has(sessionKey)) {
    throw new Error("Incognito session sharing publication is pending");
  }
  const current = state?.entries.get(sessionKey);
  if (current === null) {
    throw new Error("Incognito session sharing projection is unavailable");
  }
  return current;
}

function readIncognitoSessionFactsCurrent(database: DatabaseSync, sessionKey: string) {
  const pending = database.isTransaction
    ? incognitoSharingEntries.get(database)?.pending.get(sessionKey)
    : undefined;
  if (!pending?.size) {
    return readCommittedIncognitoSessionSharing(database, sessionKey);
  }
  let current: IncognitoSessionSharingFacts | null | undefined;
  for (const facts of pending.values()) {
    current = facts;
  }
  if (current === null) {
    throw new Error("Incognito session currency projection is unavailable");
  }
  return current;
}

/** A native commit guard sees its transaction's producer-supplied postimage without SQL. */
export function readIncognitoSessionEntryCurrent(database: DatabaseSync, sessionKey: string) {
  return readIncognitoSessionFactsCurrent(database, sessionKey)?.entry;
}

/** Receipt checks share the original native writer's pending and committed publications. */
export function readIncognitoSessionSteeringEntry(database: DatabaseSync, sessionKey: string) {
  const current = readIncognitoSessionFactsCurrent(database, sessionKey);
  if (current?.entry && !current.steering) {
    throw new Error("Incognito session steering projection is unavailable");
  }
  return current?.steering;
}

export function publishIncognitoSessionEntryChange(
  database: SessionEntryCacheDatabase & { path: string },
  update: { sessionKey: string; entry?: SessionEntry },
): void {
  let current: IncognitoSessionSharingFacts | null | undefined;
  try {
    const entry =
      update.entry ?? readExactSessionEntryRow(database, update.sessionKey, "list")?.entry;
    current = entry
      ? {
          entry: projectSessionSharingEntry(entry),
          capability: projectSessionEntryCapabilityFacts(entry),
          steering: {
            sessionId: entry.sessionId,
            updatedAt: entry.updatedAt,
            status: entry.status,
            restartRecoveryDeliveryRunId: entry.restartRecoveryDeliveryRunId,
            restartRecoveryDeliverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
            restartRecoveryDeliveryReceiptState: entry.restartRecoveryDeliveryReceiptState,
            restartRecoveryDeliveryToolCallId: entry.restartRecoveryDeliveryToolCallId,
            restartRecoveryTerminalRunIds: structuredClone(entry.restartRecoveryTerminalRunIds),
          },
          membership: new Set(
            listSessionMembersInDatabase(database, update.sessionKey).map(
              (member) => member.identityId,
            ),
          ),
        }
      : undefined;
  } catch {
    // Failed projection cannot establish absence for a later creation attempt.
    current = null;
  }
  publishTrackedCacheUpdate(
    database,
    () => commitIncognitoSessionSharingFacts(database.db, update.sessionKey, current),
    () => stageIncognitoSharingPublication(database.db, update.sessionKey, { facts: current }),
    () => commitIncognitoSessionSharingFacts(database.db, update.sessionKey, null),
  );
}
