import type { GatewayProtocolRequestOptions } from "@openclaw/gateway-client/browser";
import type {
  SessionsSetInvolvementParams,
  SessionsListParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  expandSessionRowFacts,
  SESSION_ROWS_DELTA_PREFIX,
} from "../../../../packages/gateway-protocol/src/session-row-fields.js";
import { SESSION_ARCHIVE_REQUEST_OPTIONS } from "../../../../src/shared/session-archive-timeout.ts";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import type { SessionsListResult, SessionsPatchResult } from "../../api/types.ts";
import type { SessionPatch } from "./patch.ts";
import { appendSessionResults } from "./reconcile.ts";
import type {
  SessionListOptions,
  SessionRequestClient,
  SessionResetOptions,
} from "./session-types.ts";

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
    rowMode: "dashboard",
    source: "dashboard",
    excludeDock: true,
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
    excludeDock: false,
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
    rowMode: options.rowMode ?? "compact",
    source: options.source ?? "chat-pane",
    includeGlobal: true,
    includeUnknown: true,
    configuredAgentsOnly: true,
    excludeDock: options.excludeDock ?? true,
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
      : options.activeMinutes !== undefined && options.activeMinutes > 0
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
  if (options.offset !== undefined && options.offset > 0) {
    params.offset = Math.floor(options.offset);
  }
  return params;
}

export function normalizeManagedSessionListQuery(
  options: SessionListOptions,
): Readonly<SessionsListParams & { limit: number; pageSize?: number }> {
  const { offset: _offset, append: _append, ...queryOptions } = options;
  const limit =
    options.limit !== undefined && options.limit > 0
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

// Keep raw wire rows separate from locally reconciled/optimistic presentation.
// Gateway publication identities retire them; eviction or a new client simply reads full rows.
const sessionWireRows = new WeakMap<
  SessionRequestClient,
  Map<string, { revision: string; sessions: SessionsListResult["sessions"] }>
>();

export async function requestSessionListParams(
  client: SessionRequestClient,
  query: Readonly<SessionsListParams & { pageSize?: number }>,
  isCurrent: () => boolean,
  options?: GatewayProtocolRequestOptions,
): Promise<SessionsListResult | null> {
  const { pageSize, ...params } = query;
  const read = async (request: SessionsListParams) => {
    const { source: _source, ...membership } = request;
    const key = JSON.stringify(membership);
    const cache = sessionWireRows.get(client);
    const conditional = request.rowMode !== undefined;
    const previous = conditional ? cache?.get(key) : undefined;
    const result = await client.request<SessionsListResult | undefined>(
      "sessions.list",
      {
        ...request,
        ...(previous ? { ifRowsRevision: `${SESSION_ROWS_DELTA_PREFIX}${previous.revision}` } : {}),
        ...(!previous && conditional && request.rowMode !== "sidebar"
          ? { ifRowsRevision: "" }
          : {}),
      },
      ...(options ? ([options] as const) : []),
    );
    if (!result || !isCurrent()) {
      return null;
    }
    const { sharedFacts, rowsUnchanged, rowsDelta, ...list } = result;
    if (rowsUnchanged && (!previous || result.rowsRevision !== previous.revision)) {
      throw new Error("The session query returned an unknown row revision. Try again.");
    }
    let sessions = rowsUnchanged
      ? previous!.sessions
      : sharedFacts
        ? expandSessionRowFacts(list.sessions, sharedFacts)
        : list.sessions;
    if (rowsDelta) {
      if (!previous || rowsDelta.baseRevision !== previous.revision) {
        throw new Error("The session query returned an unknown row revision. Try again.");
      }
      const rows = [...previous.sessions, ...sessions];
      sessions = rowsDelta.order.map((index) => {
        if (!Number.isInteger(index) || index < 0 || index >= rows.length) {
          throw new Error("The session query returned an incomplete row delta. Try again.");
        }
        return rows[index]!;
      });
    }
    if (conditional && result.rowsRevision) {
      const retained = cache ?? new Map();
      retained.delete(key);
      retained.set(key, { revision: result.rowsRevision, sessions });
      if (retained.size > 16) {
        retained.delete(retained.keys().next().value!);
      }
      sessionWireRows.set(client, retained);
    }
    return { ...list, sessions };
  };
  if (!pageSize || !params.limit || params.limit <= pageSize) {
    return read(params);
  }
  // The Gateway enriches only a bounded prefix per response. Page the requested
  // window here so initial loads and retained-window refreshes keep the same fields.
  let result: SessionsListResult | null = null;
  let offset = params.offset ?? 0;
  for (let remaining = params.limit; remaining > 0; remaining -= pageSize) {
    if (!isCurrent()) {
      return null;
    }
    const page = await read({
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

export function requestSessionReset(
  client: SessionRequestClient,
  key: string,
  options: SessionResetOptions = {},
): Promise<void> {
  return client
    .request("sessions.reset", buildSessionRequestParams(key, options.agentId))
    .then(() => undefined);
}
