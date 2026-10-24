import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import {
  SESSIONS_PAGE_DEFAULT_LIMIT,
  type SessionArchivedFilter,
  type SessionListOptions,
} from "../../lib/sessions/index.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";

export function buildSessionsListQuery(
  scopeId: string | null,
  filters: {
    activeMinutes?: string;
    limit?: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
    statusFilter: SessionArchivedFilter;
    searchQuery?: string;
  },
  linkedSessionKey?: string | null,
  search = filters.searchQuery,
): SessionListOptions {
  const deepLinkSessionKey = linkedSessionKey?.trim() || null;
  const scopeAgentId = parseAgentSessionKey(deepLinkSessionKey)?.agentId ?? scopeId?.trim();
  const querySearch = deepLinkSessionKey ?? search?.trim();
  const activeMinutes =
    !deepLinkSessionKey && filters.statusFilter === "active"
      ? parseStrictPositiveInteger(filters.activeMinutes)
      : undefined;
  return {
    source: "sessions-page",
    excludeDock: !deepLinkSessionKey,
    rowMode: "compact",
    // Invalid form input uses the page default, not the shared roster's page size.
    limit: deepLinkSessionKey
      ? SESSIONS_PAGE_DEFAULT_LIMIT
      : (parseStrictPositiveInteger(filters.limit) ?? SESSIONS_PAGE_DEFAULT_LIMIT),
    ...(activeMinutes ? { activeMinutes } : {}),
    ...(querySearch ? { search: querySearch } : {}),
    includeGlobal: deepLinkSessionKey ? true : filters.includeGlobal,
    includeUnknown: deepLinkSessionKey ? true : filters.includeUnknown,
    includeDerivedTitles: false,
    includeLastMessage: false,
    archivedFilter: filters.statusFilter,
    ...(scopeAgentId ? { agentId: scopeAgentId } : {}),
  };
}
