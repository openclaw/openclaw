import { controlUiSessionSlug } from "@openclaw/session-url-contract";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalScopeConfigured,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiGlobalAliasAgentId,
} from "../../lib/sessions/session-key.ts";
import type { SessionRouteContext as ApplicationContext } from "./route-loader-context.ts";
import { sessionKeyUuid } from "./route-loader-short-cache.ts";

const SESSION_REF_SEARCH_LIMIT = 20;
const SESSION_REF_SEARCH_MAX_PAGES = 5;

type SessionReferenceSearch = { agentId: string } & (
  | { kind: "exact"; value: string }
  | { kind: "slug"; value: string }
);

type PendingSessionReference = {
  controller: AbortController;
  promise: Promise<SessionQueryResolution | null>;
  subscribers: Set<AbortSignal>;
};

export type SessionQueryResolution =
  | { kind: "not-found" }
  | { kind: "unique"; session: GatewaySessionRow }
  | { kind: "ambiguous"; sessions: GatewaySessionRow[]; truncated: boolean };

const resolutionCache = new WeakMap<GatewayBrowserClient, Map<string, PendingSessionReference>>();

function exactGlobalAliasAgentId(
  context: ApplicationContext,
  search: SessionReferenceSearch,
): string | null {
  if (search.kind !== "exact") {
    return null;
  }
  const host = {
    agentsList: context.agents.state.agentsList,
    hello: context.gateway.snapshot.hello,
  };
  const aliasAgentId = resolveUiGlobalAliasAgentId(host, search.value);
  const aliasRest = parseAgentSessionKey(search.value)?.rest.toLowerCase();
  return aliasRest === "global" || isUiGlobalScopeConfigured(host) ? aliasAgentId : null;
}

function sessionReferenceSearchText(
  context: ApplicationContext,
  search: SessionReferenceSearch,
): string {
  if (search.kind === "exact") {
    // Gateway search filters literal stored keys before client-side alias matching.
    // A scoped main alias therefore has to request the canonical global key.
    if (exactGlobalAliasAgentId(context, search) === normalizeAgentId(search.agentId)) {
      return "global";
    }
    return search.value;
  }
  // Slugs are built from contiguous alphanumeric runs, so the longest token is
  // the safest selective search term without excluding a valid display name.
  return search.value
    .split("-")
    .reduce((longest, token) => (token.length > longest.length ? token : longest), "");
}

function sessionReferenceMatches(
  context: ApplicationContext,
  result: SessionsListResult,
  search: SessionReferenceSearch,
): GatewaySessionRow[] {
  if (search.kind === "exact") {
    const aliasAgentId = exactGlobalAliasAgentId(context, search);
    return result.sessions.filter(
      (row) =>
        areUiSessionKeysEquivalent(row.key, search.value) ||
        (isUiGlobalSessionKey(row.key) && aliasAgentId === normalizeAgentId(search.agentId)),
    );
  }
  return result.sessions.filter(
    (row) =>
      sessionKeyUuid(row.key) !== null && controlUiSessionSlug(row.displayName) === search.value,
  );
}

function incompleteResolution(
  kind: SessionReferenceSearch["kind"],
  sessions: GatewaySessionRow[],
): SessionQueryResolution {
  if (kind === "slug" && sessions.length === 0) {
    // Preserve incomplete exact routes, but a bounded zero-match slug is a 404.
    return { kind: "not-found" };
  }
  return { kind: "ambiguous", sessions, truncated: true };
}

async function querySessionReferencePages(
  context: ApplicationContext,
  search: SessionReferenceSearch,
  signal: AbortSignal,
): Promise<SessionQueryResolution | null> {
  const matches = new Map<string, GatewaySessionRow>();
  let offset = 0;
  for (let page = 0; ; page += 1) {
    signal.throwIfAborted();
    const result = await context.sessions.list({
      agentId: search.agentId,
      archivedFilter: "all",
      includeDerivedTitles: true,
      limit: SESSION_REF_SEARCH_LIMIT,
      search: sessionReferenceSearchText(context, search),
      ...(offset > 0 ? { offset } : {}),
    });
    signal.throwIfAborted();
    if (!result) {
      return null;
    }
    for (const session of sessionReferenceMatches(context, result, search)) {
      matches.set(session.key, session);
    }
    const sessions = [...matches.values()];
    if (search.kind === "exact" && sessions[0]) {
      return { kind: "unique", session: sessions[0] };
    }
    if (sessions.length > 1) {
      return { kind: "ambiguous", sessions, truncated: result.hasMore === true };
    }
    if (result.hasMore !== true) {
      const session = sessions[0];
      return session ? { kind: "unique", session } : { kind: "not-found" };
    }
    if (page === SESSION_REF_SEARCH_MAX_PAGES - 1) {
      return incompleteResolution(search.kind, sessions);
    }
    const nextOffset = result.nextOffset ?? offset + result.sessions.length;
    if (nextOffset <= offset) {
      return incompleteResolution(search.kind, sessions);
    }
    offset = nextOffset;
  }
}

export async function querySessionReference(
  context: ApplicationContext,
  search: SessionReferenceSearch,
  signal: AbortSignal,
): Promise<SessionQueryResolution | null> {
  const client = await waitForGatewayClient(context.gateway, signal);
  signal.throwIfAborted();
  const cache = resolutionCache.get(client) ?? new Map<string, PendingSessionReference>();
  resolutionCache.set(client, cache);
  const cacheKey = `${normalizeAgentId(search.agentId)}:${search.kind}:${search.value}`;
  let pending = cache.get(cacheKey);
  if (!pending || pending.controller.signal.aborted) {
    const controller = new AbortController();
    pending = {
      controller,
      promise: Promise.resolve().then(() =>
        querySessionReferencePages(context, search, controller.signal),
      ),
      subscribers: new Set(),
    };
    cache.set(cacheKey, pending);
  }
  pending.subscribers.add(signal);
  const shared = pending;
  let rejectAbort: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    shared.subscribers.delete(signal);
    if (shared.subscribers.size === 0) {
      shared.controller.abort(signal.reason);
    }
    rejectAbort(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  try {
    return await Promise.race([shared.promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    shared.subscribers.delete(signal);
    if (shared.subscribers.size === 0 && cache.get(cacheKey) === shared) {
      cache.delete(cacheKey);
    }
  }
}
