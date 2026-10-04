import type { SessionsListResult } from "../../api/types.ts";
import type { BootRecord } from "../../app/boot-record.ts";
import type { SessionGroupSettings } from "./custom-groups.ts";
import type { SessionListOptions } from "./session-capability.ts";

export const SESSION_ROSTER_DB_NAME = "openclaw-session-roster";
export const SESSION_ROSTER_STORE_NAME = "rosters";
export const SESSION_ROSTER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ROSTER_MAX_BYTES = 1.5 * 1024 * 1024;
let sessionRosterCacheGeneration = 0;
let allScopesGeneration = 0;
const scopeGenerations = new Map<string, number>();
let sessionRosterPublication = 0;

export function sessionRosterGeneration(scope: string): number {
  return scopeGenerations.get(scope) ?? allScopesGeneration;
}

export function sessionRosterScope(gatewayScope: string, recoveryScope?: string): string {
  return recoveryScope ? `account:${JSON.stringify([gatewayScope, recoveryScope])}` : gatewayScope;
}

export type SessionRosterRecord = {
  version: 1;
  scope: string;
  savedAt: number;
  profileId: string | null;
  agentId: string | null;
  query: SessionListOptions;
  result: SessionsListResult;
  groups: readonly string[];
  groupSettings: readonly SessionGroupSettings[];
  sectionOrder: readonly string[];
};

export type RosterExpectation = {
  profileId?: string | null;
  agentId: string | null;
  query: SessionListOptions;
};

export type SessionRosterCache = {
  read: (scope: string, expected: RosterExpectation) => Promise<SessionRosterRecord | null>;
  write: (record: SessionRosterRecord) => void;
};

export type SessionRosterCacheOptions = {
  rosterCache?: SessionRosterCache;
  bootRecord?: BootRecord | null;
};

export const sessionRosterCache: SessionRosterCache = {
  read(scope, expected) {
    const generation = sessionRosterGeneration(scope);
    return import("./session-roster-cache.reader.ts").then(({ readSessionRoster }) =>
      readSessionRoster(scope, expected, generation),
    );
  },
  write(record) {
    const generation = sessionRosterGeneration(record.scope);
    // Separate lazy imports can settle out of order, so number publications here
    // and let the runtime keep the newest one.
    sessionRosterPublication += 1;
    const publication = sessionRosterPublication;
    void import("./session-roster-cache.runtime.ts")
      .then((runtime) => {
        if (generation === sessionRosterGeneration(record.scope)) {
          runtime.persistSessionRoster(record, publication);
        }
      })
      .catch(() => undefined);
  },
};

export function invalidateSessionRosterCache(scope?: string): void {
  sessionRosterCacheGeneration += 1;
  if (scope === undefined) {
    allScopesGeneration = sessionRosterCacheGeneration;
    scopeGenerations.clear();
  } else {
    scopeGenerations.set(scope, sessionRosterCacheGeneration);
  }
}
