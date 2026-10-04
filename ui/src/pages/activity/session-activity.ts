import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { RouteLocation } from "@openclaw/uirouter";
import { buildControlUiResourcePath } from "../../../../src/gateway/control-ui-resource-routes.js";
import { sessionActivityTimestamp } from "../../../../src/shared/session-activity-timestamp.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  ACTIVITY_PERSON_PARAM,
  activityPersonFromPath,
  activityPersonLocation,
  pathForRoute,
} from "../../app-route-paths.ts";
import { readAvatarGatewayContext } from "../../lib/identity-avatar-context.ts";
import type { PresenceViewer } from "../../lib/presence-users.ts";
import { reconcileSessionChanged } from "../../lib/sessions/reconcile.ts";
import { canApplySessionListSnapshot } from "../../lib/sessions/session-list-query.ts";
import {
  createSessionWriteObservation,
  type createSessionRowProvenance,
} from "../../lib/sessions/session-row-provenance.ts";
import { matchesExistingSession } from "../../lib/sessions/session-row-reconcile.ts";
import type { CurrentWorkChange } from "./current-work.ts";

export const ACTIVITY_TIME_FILTERS = ["24h", "7d", "30d", "all"] as const;
export type ActivityTimeFilter = (typeof ACTIVITY_TIME_FILTERS)[number];

export const TIME_LABELS: Record<ActivityTimeFilter, string> = {
  "24h": "activityFeed.time24h",
  "7d": "activityFeed.time7d",
  "30d": "activityFeed.time30d",
  all: "activityFeed.timeAll",
};

export type SessionActivityFilters = {
  personId: string | null;
  query: string;
  time: ActivityTimeFilter;
};

type ActivityPerson = PresenceViewer & { count: number };

type SessionActivityDay = {
  key: string;
  timestamp: number | null;
  sessions: readonly GatewaySessionRow[];
};

type SessionActivityProjection = {
  days: readonly SessionActivityDay[];
  matchedCount: number;
  people: readonly ActivityPerson[];
  sessions: readonly GatewaySessionRow[];
  timeCount: number;
};

const DEFAULT_ACTIVITY_TIME_FILTER: ActivityTimeFilter = "7d";

export function parseSessionActivityFilters(
  search: string,
  pathPersonId?: string | null,
): SessionActivityFilters {
  const params = new URLSearchParams(search);
  const rawTime = params.get("time");
  return {
    personId: pathPersonId ?? normalizeOptionalString(params.get(ACTIVITY_PERSON_PARAM)) ?? null,
    query: params.get("q")?.trim() ?? "",
    time: ACTIVITY_TIME_FILTERS.find((time) => time === rawTime) ?? DEFAULT_ACTIVITY_TIME_FILTER,
  };
}

export function sessionActivityLocation(
  filters: SessionActivityFilters,
  basePath = "",
  personLabel?: string,
): { pathname: string; search: string } {
  const params = new URLSearchParams();
  if (filters.time !== DEFAULT_ACTIVITY_TIME_FILTER) {
    params.set("time", filters.time);
  }
  if (filters.query) {
    params.set("q", filters.query);
  }
  const serialized = params.toString();
  const search = serialized ? `?${serialized}` : "";
  const pathname = filters.personId
    ? activityPersonLocation(filters.personId, basePath, personLabel).pathname
    : pathForRoute("activity", basePath);
  return { pathname, search };
}

export function canonicalSessionActivityLocation(
  location: RouteLocation,
  personId: string,
  label: string | undefined,
  basePath: string,
): RouteLocation | null {
  const params = new URLSearchParams(location.search);
  const pathReference = activityPersonFromPath(location.pathname, basePath);
  const compactReference = (pathReference ?? params.get(ACTIVITY_PERSON_PARAM))?.replaceAll(
    "-",
    "",
  );
  const prefixLength =
    compactReference &&
    /^[0-9a-f]{8,32}$/.test(compactReference) &&
    personId.replaceAll("-", "").startsWith(compactReference)
      ? compactReference.length
      : 32;
  // Empty filtered pages carry no profile metadata; retain the readable incoming link.
  const pathname =
    pathReference && !label
      ? location.pathname
      : activityPersonLocation(personId, basePath, label, prefixLength).pathname;
  params.delete(ACTIVITY_PERSON_PARAM);
  const query = params.toString();
  const search = query ? `?${query}` : "";
  return pathname === location.pathname && search === location.search
    ? null
    : { pathname, search, hash: location.hash };
}

function compareSessionActivity(a: GatewaySessionRow, b: GatewaySessionRow): number {
  const recency = sessionActivityTimestamp(b) - sessionActivityTimestamp(a);
  return recency || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

type ActivityRowProvenance = ReturnType<typeof createSessionRowProvenance>;

/** Reads own membership; field receipts preserve observations made while the read was pending. */
export function reconcileSessionActivityRead(
  incoming: SessionsListResult,
  previous: SessionsListResult | undefined,
  provenance: ActivityRowProvenance,
  revision: number,
): { result: SessionsListResult; requiresRefresh: boolean } {
  const held = new Map(
    (previous?.sessions ?? []).flatMap((row) => {
      const identity = provenance.identity(row);
      return identity ? [[identity, row] as const] : [];
    }),
  );
  let orderChanged = false;
  const sessions = incoming.sessions.map((row) => {
    const identity = provenance.identity(row);
    const existing = identity ? held.get(identity) : undefined;
    provenance.observeReadRow(row, revision, row.agentId, existing ? [existing] : []);
    if (identity) {
      held.delete(identity);
    }
    const merged = existing ? provenance.mergeRow(existing, row, row.agentId) : row;
    orderChanged ||= sessionActivityTimestamp(merged) !== sessionActivityTimestamp(row);
    return merged;
  });
  return {
    result: {
      ...incoming,
      sessions: orderChanged ? sessions.toSorted(compareSessionActivity) : sessions,
    },
    requiresRefresh: [...held.values()].some((row) => {
      const sample = provenance.fieldObservation(row, "updatedAt").source.snapshotAt;
      return (
        (sample === undefined ? provenance.hasNewerFacts(row, revision) : sample > incoming.ts) &&
        !incoming.sessions.some((replacement) =>
          matchesExistingSession(replacement, row.key, provenance.owner(row)),
        )
      );
    }),
  };
}

/** Unfiltered Activity holds its admitted window; aggregate facets refresh separately. */
export function reconcileSessionActivity(
  result: SessionsListResult,
  changes: Iterable<CurrentWorkChange>,
  provenance: ActivityRowProvenance,
  revision: number,
): { result: SessionsListResult; requiresRefresh: boolean } {
  let nextResult = result;
  let requiresRefresh = false;
  for (const change of changes) {
    if (
      !change.snapshot ||
      !canApplySessionListSnapshot(
        nextResult,
        change.snapshot,
        { archivedFilter: "all", limit: 100, excludeSubagents: true },
        "activity",
      )
    ) {
      requiresRefresh = true;
      continue;
    }
    const next = reconcileSessionChanged(
      nextResult,
      change.snapshot,
      { archivedFilter: "all" },
      (row, existing, fields, info) => {
        provenance.inheritRow(row, existing);
        provenance.observeFields(
          row,
          (info.isAncestorReference ? provenance.fieldNames(existing) : fields).filter(
            (field) => field !== "activitySummary" || info.hasActivitySummary,
          ),
          createSessionWriteObservation(revision, info.updatedAt, undefined, info.snapshotAt),
          info.agentId,
        );
        return provenance.mergeRow(existing, row, info.agentId);
      },
    ).result;
    if (next) {
      nextResult = { ...next, sessions: next.sessions.toSorted(compareSessionActivity) };
    }
  }
  return { result: nextResult, requiresRefresh };
}

export function sessionActivityOwner(row: GatewaySessionRow): PresenceViewer {
  const actor = row.owner?.actor ?? row.createdActor;
  const agentId = normalizeOptionalString(row.agentId);
  const { resourceBasePath } = readAvatarGatewayContext();
  return {
    id: normalizeOptionalString(actor?.id) ?? agentId ?? "system",
    name: normalizeOptionalString(actor?.label) ?? agentId,
    avatarUrl: actor
      ? normalizeOptionalString(actor.avatarUrl)
      : agentId
        ? buildControlUiResourcePath("agentAvatar", resourceBasePath, agentId)
        : undefined,
    watchedSessions: [],
  };
}

function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayStart(timestamp: number): number {
  return new Date(timestamp).setHours(0, 0, 0, 0);
}

export function projectSessionActivity(
  result: SessionsListResult | undefined,
): SessionActivityProjection {
  const visible = result?.sessions ?? [];
  const people = (result?.people ?? []).map((person) => ({
    id: person.identity.id,
    name: person.label,
    avatarUrl: person.avatarUrl,
    watchedSessions: [],
    count: person.sessionCount,
  }));
  const grouped = new Map<string, GatewaySessionRow[]>();
  for (const row of visible) {
    const timestamp = sessionActivityTimestamp(row);
    const key = timestamp > 0 ? dayKey(timestamp) : "unknown";
    const existing = grouped.get(key);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }
  const days = [...grouped.entries()].map(([key, sessions]) => ({
    key,
    timestamp: key === "unknown" ? null : dayStart(sessionActivityTimestamp(sessions[0]!)),
    sessions,
  }));
  return {
    days,
    matchedCount: result?.totalCount ?? visible.length,
    people,
    sessions: visible,
    timeCount: result?.peopleSessionCount ?? visible.length,
  };
}

export function resolveViewingNow(
  identity: PresenceViewer,
  rows: readonly GatewaySessionRow[],
): readonly GatewaySessionRow[] {
  const watched = new Set(identity.watchedSessions);
  return rows.filter((row) => watched.has(row.key)).toSorted(compareSessionActivity);
}
