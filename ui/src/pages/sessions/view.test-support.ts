import type { SessionsListResult } from "../../api/types.ts";
import type { SessionsProps } from "./view.ts";

export function buildResult(
  session: SessionsListResult["sessions"][number],
  defaults?: Partial<SessionsListResult["defaults"]>,
): SessionsListResult {
  return {
    ts: Date.now(),
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null, ...defaults },
    sessions: [session],
  };
}

export function buildMultiResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: Date.now(),
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

export function buildProps(result: SessionsListResult): SessionsProps {
  return {
    loading: false,
    refreshing: false,
    agentId: "main",
    mainKey: "main",
    result,
    error: null,
    activeMinutes: "",
    limit: "120",
    includeGlobal: false,
    includeUnknown: false,
    statusFilter: "active",
    basePath: "",
    searchQuery: "",
    transcriptSearchAvailable: true,
    transcriptSearchQuery: "",
    transcriptSearch: { status: "idle" },
    agentIdentityById: {},
    sortColumn: "updated",
    sortDir: "desc",
    groupBy: "none",
    personGroupingAvailable: true,
    knownCategories: [],
    page: 0,
    pageSize: 10,
    selectedKeys: new Set<string>(),
    sessionMenu: null,
    expandedSessionKey: null,
    onFiltersChange: () => undefined,
    onClearFilters: () => undefined,
    onSearchChange: () => undefined,
    onTranscriptSearchChange: () => undefined,
    onTranscriptSearch: () => undefined,
    onClearTranscriptSearch: () => undefined,
    onSortChange: () => undefined,
    onGroupByChange: () => undefined,
    onAssignCategory: () => undefined,
    onRequestNewCategory: () => undefined,
    onLoadMore: () => undefined,
    onPageChange: () => undefined,
    onPageSizeChange: () => undefined,
    onRefresh: () => undefined,
    onStatusFilterChange: () => undefined,
    onDeleteAllArchived: () => undefined,
    onPatch: () => undefined,
    onToggleSelect: () => undefined,
    onSelectPage: () => undefined,
    onDeselectPage: () => undefined,
    onDeselectAll: () => undefined,
    onDeleteSelected: () => undefined,
    onOpenSessionMenu: () => undefined,
    onToggleDetails: () => undefined,
  };
}
