import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";
import { readOfflineStorageScope } from "../../app/boot-record.ts";
import type { SessionGateway, SessionListOptions, SessionState } from "./session-capability.ts";
import { isPrimarySessionListQuery } from "./session-list-query.ts";
import { normalizeManagedSessionListQuery } from "./session-requests.ts";
import {
  openSessionRosterDatabase,
  resetSessionRosterDatabase,
  rosterRequestResult,
  rosterTransactionDone,
} from "./session-roster-cache-database.ts";
import {
  SESSION_ROSTER_STORE_NAME,
  SESSION_ROSTER_MAX_AGE_MS,
  SESSION_ROSTER_MAX_BYTES,
  sessionRosterGeneration,
  type RosterExpectation,
  type SessionRosterCache,
  type SessionRosterRecord,
} from "./session-roster-cache.ts";

function isNullableId(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isRosterQuery(value: unknown): value is SessionListOptions {
  return (
    isRecord(value) &&
    Object.entries(value).every(([key, entry]) => {
      if (key === "agentId") {
        return typeof entry === "string";
      }
      if (key === "limit") {
        return typeof entry === "number" && Number.isFinite(entry);
      }
      return (
        [
          "includeGlobal",
          "includeUnknown",
          "configuredAgentsOnly",
          "includeDerivedTitles",
          "includeLastMessage",
          "ownerFirst",
          "excludeDock",
        ].includes(key) && typeof entry === "boolean"
      );
    })
  );
}

function isSessionRosterRecord(value: unknown): value is SessionRosterRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.scope === "string" &&
    value.scope.length > 0 &&
    typeof value.savedAt === "number" &&
    Number.isFinite(value.savedAt) &&
    value.savedAt >= 0 &&
    isNullableId(value.profileId) &&
    isNullableId(value.agentId) &&
    isRosterQuery(value.query) &&
    isRecord(value.result) &&
    Array.isArray(value.result.sessions) &&
    value.result.sessions.length <= 200 &&
    value.result.sessions.every((row: unknown) => isRecord(row) && typeof row.key === "string") &&
    Array.isArray(value.groups) &&
    value.groups.every((group: unknown) => typeof group === "string") &&
    Array.isArray(value.groupSettings) &&
    value.groupSettings.every(
      (group: unknown) =>
        isRecord(group) && typeof group.name === "string" && typeof group.position === "number",
    ) &&
    Array.isArray(value.sectionOrder) &&
    value.sectionOrder.every((section: unknown) => typeof section === "string")
  );
}

// Incognito conversations are memory-only by contract; their titles and previews
// must never reach IndexedDB, and a stored row from an older writer is dropped too.
function isPersistableSessionRow(row: GatewaySessionRow): boolean {
  return row.incognito !== true;
}

function stripVolatileSessionRowFields(row: GatewaySessionRow): GatewaySessionRow {
  const result = { ...row };
  delete result.hasActiveRun;
  delete result.activeRunIds;
  delete result.activeModel;
  delete result.activeModelProvider;
  delete result.status;
  delete result.runtimeMs;
  delete result.runtimeSampledAt;
  delete result.snapshotAt;
  delete result.agentStatus;
  delete result.observerDigest;
  delete result.swarmPhase;
  delete result.swarmPhaseRank;
  delete result.swarmLog;
  delete result.placement;
  delete result.placementMove;
  delete result.subagentRunState;
  delete result.hasActiveSubagentRun;
  delete result.channelAvatarUrl;
  return result;
}

export function parseSessionRosterRecord(value: unknown): SessionRosterRecord | null {
  return isSessionRosterRecord(value) ? value : null;
}

function sessionRosterQuery(options: SessionListOptions): SessionListOptions {
  const {
    source: _source,
    rowMode: _rowMode,
    ...query
  } = normalizeManagedSessionListQuery({
    ...options,
    includeDerivedTitles: options.includeDerivedTitles ?? true,
    includeLastMessage: options.includeLastMessage ?? true,
  });
  // Wire diagnostics and detail projection do not change persisted roster membership.
  return query;
}

function rosterRecordMatches(record: SessionRosterRecord, expected: RosterExpectation): boolean {
  return (
    record.agentId === expected.agentId &&
    (record.query.agentId === undefined || record.query.agentId.trim() === record.agentId) &&
    (expected.query.agentId === undefined || expected.query.agentId.trim() === expected.agentId) &&
    (expected.profileId === undefined || record.profileId === expected.profileId) &&
    isPrimarySessionListQuery(record.query) &&
    isPrimarySessionListQuery(expected.query)
  );
}

export function boundSessionRosterRecord(record: SessionRosterRecord): SessionRosterRecord | null {
  try {
    if (!isPrimarySessionListQuery(record.query)) {
      return null;
    }
    const stripped = {
      ...record,
      query: sessionRosterQuery(record.query),
      result: {
        ...record.result,
        sessions: record.result.sessions
          .filter(isPersistableSessionRow)
          .map(stripVolatileSessionRowFields),
      },
    };
    const json = JSON.stringify(stripped, (key, value: unknown) =>
      key === "avatarUrl" || key === "channelAvatarUrl" ? undefined : value,
    );
    return new TextEncoder().encode(json).byteLength <= SESSION_ROSTER_MAX_BYTES
      ? parseSessionRosterRecord(JSON.parse(json))
      : null;
  } catch {
    return null;
  }
}

export async function readSessionRoster(
  scope: string,
  expected: RosterExpectation,
  generation: number,
): Promise<SessionRosterRecord | null> {
  if (generation !== sessionRosterGeneration(scope)) {
    return null;
  }
  const database = await openSessionRosterDatabase();
  if (!database) {
    return null;
  }
  try {
    const transaction = database.transaction(SESSION_ROSTER_STORE_NAME);
    const completed = rosterTransactionDone(transaction);
    const value: unknown = await rosterRequestResult(
      transaction.objectStore(SESSION_ROSTER_STORE_NAME).get(scope),
    );
    await completed;
    if (value === undefined || generation !== sessionRosterGeneration(scope)) {
      return null;
    }
    const record = parseSessionRosterRecord(value);
    if (
      !record ||
      record.scope !== scope ||
      Date.now() - record.savedAt > SESSION_ROSTER_MAX_AGE_MS ||
      new TextEncoder().encode(JSON.stringify(record)).byteLength > SESSION_ROSTER_MAX_BYTES
    ) {
      database.close();
      await resetSessionRosterDatabase();
      return null;
    }
    if (!rosterRecordMatches(record, expected)) {
      return null;
    }
    return {
      ...record,
      result: {
        ...record.result,
        sessions: record.result.sessions
          .filter(isPersistableSessionRow)
          .map(stripVolatileSessionRowFields),
      },
    };
  } catch {
    database.close();
    await resetSessionRosterDatabase();
    return null;
  } finally {
    database.close();
  }
}

export async function hydrateSessionRoster(
  gateway: SessionGateway,
  agentSelection: { readonly state: { readonly selectedId: string | null } },
  cache: SessionRosterCache,
  host: { readState: () => SessionState; publish: (state: SessionState) => void },
  initial: RosterExpectation & {
    scope: string | undefined;
    connectionRevision: number | undefined;
  },
  signal: AbortSignal,
): Promise<void> {
  if (!initial.scope || signal.aborted || host.readState().result !== null) {
    return;
  }
  const record = await cache.read(initial.scope, initial);
  const account = readOfflineStorageScope({ client: gateway.snapshot.client });
  const gatewayScope = gateway.connection
    ? gatewayCredentialScope(gateway.connection.gatewayUrl)
    : undefined;
  const scope =
    gatewayScope && account ? `account:${JSON.stringify([gatewayScope, account])}` : initial.scope;
  if (
    !record ||
    signal.aborted ||
    host.readState().result !== null ||
    gateway.snapshot.phase === "connected" ||
    agentSelection.state.selectedId !== initial.agentId ||
    scope !== initial.scope ||
    gateway.connectionRevision !== initial.connectionRevision ||
    !rosterRecordMatches(record, initial)
  ) {
    return;
  }
  host.publish({
    ...host.readState(),
    result: record.result,
    agentId: record.agentId,
    groups: record.groups,
    groupSettings: record.groupSettings,
    sectionOrder: record.sectionOrder,
    resultCached: true,
  });
}
