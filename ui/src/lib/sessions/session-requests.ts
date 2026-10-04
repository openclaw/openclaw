import type {
  SessionsDeleteResult,
  SessionsSetInvolvementParams,
  SessionsListParams,
  SessionsPatchManyParams,
  SessionsPatchManyResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { SESSION_ARCHIVE_REQUEST_OPTIONS } from "../../../../src/shared/session-archive-timeout.ts";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import type { SessionsListResult, SessionsPatchResult } from "../../api/types.ts";
import type { SessionPatch } from "./patch.ts";
import { appendSessionResults } from "./reconcile.ts";
import type {
  SessionDeleteOptions,
  SessionListOptions,
  SessionRequestClient,
  SessionResetOptions,
} from "./session-capability.ts";

/** Personal list choices share one RPC contract across all session menus. */
export async function requestSessionInvolvement(
  client: SessionRequestClient,
  params: SessionsSetInvolvementParams,
): Promise<void> {
  await client.request("sessions.setInvolvement", params);
}

/** Gateway rosters omit recency so Chat and Settings agree, and carry the shared
 *  sidebar page size: a roster smaller than the store empties whole categories
 *  whose newest session falls outside the page, so the remainder is reachable
 *  through the list's Load more control rather than lost. */
export const DEFAULT_SESSION_LIST_QUERY = {
  limit: SIDEBAR_SESSION_ROSTER_LIMIT,
} as const satisfies SessionListOptions;

export function dashboardSessionListQuery(agentId?: string | null): SessionListOptions {
  const normalizedAgentId = agentId?.trim();
  return {
    ...DEFAULT_SESSION_LIST_QUERY,
    rowMode: "compact",
    source: "dashboard",
    hasBoard: true,
    archivedFilter: "all",
    ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
  };
}

/** Progress cards resolve an explicit cross-session target independently of
 *  dashboard gallery membership: the Gateway filters hasBoard against each
 *  session's own board inventory, so a running target without its own board
 *  would disappear from a gallery-filtered roster and render as paused. */
export function sessionProgressTargetQuery(agentId?: string | null): SessionListOptions {
  const normalizedAgentId = agentId?.trim();
  return {
    ...DEFAULT_SESSION_LIST_QUERY,
    source: "dashboard",
    archivedFilter: "all",
    ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
  };
}

/** Starting page size for the Sessions page's explicit, user-editable limit
 *  field, kept separate from the roster page so tuning one never moves the other. */
export const SESSIONS_PAGE_DEFAULT_LIMIT = 50;

export function buildSessionRequestParams(
  key: string,
  agentId?: string | null,
): { key: string; agentId?: string } {
  const normalizedKey = key.trim();
  const normalizedAgentId = agentId?.trim();
  return {
    key: normalizedKey,
    ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
  };
}

export function buildSessionListParams(options: SessionListOptions = {}): SessionsListParams {
  const params: SessionsListParams = {
    rowMode: "compact",
    source: options.source ?? "chat-pane",
    includeGlobal: true,
    includeUnknown: true,
    configuredAgentsOnly: true,
  };
  if (options.limit === undefined) {
    params.limit = DEFAULT_SESSION_LIST_QUERY.limit;
  } else if (options.limit > 0) {
    params.limit = Math.floor(options.limit);
  }
  for (const key of [
    "includeGlobal",
    "includeUnknown",
    "configuredAgentsOnly",
    "excludeSubagents",
    "excludeCron",
    "excludeSystem",
    "hasBoard",
  ] as const) {
    if (options[key] !== undefined) {
      params[key] = options[key];
    }
  }
  for (const key of [
    "includeDerivedTitles",
    "includeLastMessage",
    "includeOwnerSessionCounts",
    "ownerFirst",
    "involvingMe",
  ] as const) {
    if (options[key] === true) {
      params[key] = true;
    }
  }
  if (options.archivedFilter === "archived") {
    params.archived = true;
  } else if (options.archivedFilter === "all") {
    params.archived = "all";
  }
  const activeMinutes =
    options.archivedFilter === "archived" || options.archivedFilter === "all"
      ? 0
      : typeof options.activeMinutes === "number" && options.activeMinutes > 0
        ? Math.floor(options.activeMinutes)
        : 0;
  if (activeMinutes > 0) {
    params.activeMinutes = activeMinutes;
  }
  for (const key of ["agentId", "spawnedBy", "search", "ownerId"] as const) {
    const value = options[key]?.trim();
    if (value) {
      params[key] = value;
    }
  }
  if (options.boardFace) {
    params.boardFace = options.boardFace;
  }
  if (typeof options.offset === "number" && options.offset > 0) {
    params.offset = Math.floor(options.offset);
  }
  return params;
}

export function normalizeManagedSessionListQuery(
  options: SessionListOptions,
): Readonly<SessionsListParams & { limit: number; pageSize?: number }> {
  const { offset: _offset, append: _append, ...queryOptions } = options;
  const limit =
    typeof options.limit === "number" && options.limit > 0
      ? Math.floor(options.limit)
      : DEFAULT_SESSION_LIST_QUERY.limit;
  return Object.freeze({
    ...buildSessionListParams({ ...queryOptions, limit }),
    limit,
    ...(options.pageSize ? { pageSize: options.pageSize } : {}),
  });
}

export function sessionListQueryKey(options: SessionListOptions): string {
  const { source: _source, ...query } = normalizeManagedSessionListQuery(options);
  return JSON.stringify(query);
}

export async function requestSessionList(
  client: SessionRequestClient,
  options: SessionListOptions,
  isCurrent: () => boolean,
): Promise<SessionsListResult | null> {
  return requestSessionListParams(client, buildSessionListParams(options), isCurrent);
}

export async function requestSessionListParams(
  client: SessionRequestClient,
  query: Readonly<SessionsListParams & { pageSize?: number }>,
  isCurrent: () => boolean,
): Promise<SessionsListResult | null> {
  const { pageSize, ...params } = query;
  if (!pageSize || !params.limit || params.limit <= pageSize) {
    return (await client.request<SessionsListResult | undefined>("sessions.list", params)) ?? null;
  }
  // The Gateway enriches only a bounded prefix per response. Page the requested
  // window here so initial loads and retained-window refreshes keep the same fields.
  let result: SessionsListResult | null = null;
  let offset = params.offset ?? 0;
  for (let remaining = params.limit; remaining > 0; remaining -= pageSize) {
    if (!isCurrent()) {
      return null;
    }
    const page = await client.request<SessionsListResult | undefined>("sessions.list", {
      ...params,
      limit: Math.min(remaining, pageSize),
      ...(offset > 0 ? { offset } : {}),
    });
    if (!isCurrent() || !page) {
      return null;
    }
    result = result ? appendSessionResults(result, page) : page;
    if (!page.hasMore || page.sessions.length === 0) {
      break;
    }
    const nextOffset = page.nextOffset ?? offset + page.sessions.length;
    if (nextOffset <= offset) {
      throw new Error("Session list pagination did not advance.");
    }
    offset = nextOffset;
  }
  return result;
}

export function requestSessionPatch(
  client: SessionRequestClient,
  key: string,
  patch: SessionPatch,
  options: {
    agentId?: string | null;
    expectedSessionId?: string | null;
    expectedMarkedUnreadAt?: number | null;
  } = {},
): Promise<SessionsPatchResult> {
  const expectedSessionId = options.expectedSessionId?.trim();
  const params = {
    ...buildSessionRequestParams(key, options.agentId),
    ...(expectedSessionId ? { expectedSessionId } : {}),
    ...(options.expectedMarkedUnreadAt !== undefined
      ? { expectedMarkedUnreadAt: options.expectedMarkedUnreadAt }
      : {}),
    ...patch,
  };
  return patch.archived === true
    ? client.request<SessionsPatchResult>("sessions.patch", params, SESSION_ARCHIVE_REQUEST_OPTIONS)
    : client.request<SessionsPatchResult>("sessions.patch", params);
}

export function requestSessionPatchMany(
  client: SessionRequestClient,
  params: SessionsPatchManyParams,
): Promise<SessionsPatchManyResult> {
  return params.patch.archived === true
    ? client.request<SessionsPatchManyResult>(
        "sessions.patchMany",
        params,
        SESSION_ARCHIVE_REQUEST_OPTIONS,
      )
    : client.request<SessionsPatchManyResult>("sessions.patchMany", params);
}

export function requestSessionDelete(
  client: SessionRequestClient,
  key: string,
  options: SessionDeleteOptions = {},
): Promise<SessionsDeleteResult> {
  return client.request<SessionsDeleteResult>(
    "sessions.delete",
    {
      ...buildSessionRequestParams(key, options.agentId),
      deleteTranscript: options.deleteTranscript ?? true,
      ...(options.expectedSessionId ? { expectedSessionId: options.expectedSessionId } : {}),
      ...(options.archivedOnly === true ? { archivedOnly: true } : {}),
    },
    SESSION_ARCHIVE_REQUEST_OPTIONS,
  );
}

export function requestSessionReset(
  client: SessionRequestClient,
  key: string,
  options: SessionResetOptions = {},
): Promise<void> {
  return client
    .request("sessions.reset", buildSessionRequestParams(key, options.agentId))
    .then(() => undefined);
}
