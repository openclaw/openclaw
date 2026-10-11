import { createSignal } from "solid-js";
import type { SessionsListResult } from "../../api/types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { SessionsProps } from "./view-types.ts";
import { SessionsView } from "./view.tsx";

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
    onNavigateToChat: () => undefined,
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

const sessionViews = new Map<
  HTMLElement,
  { update: (props: SessionsProps) => void; dispose: () => void }
>();

export function renderSessionsView(initial: SessionsProps, container: HTMLElement) {
  const existing = sessionViews.get(container);
  if (existing) {
    existing.update(initial);
  } else {
    const [props, setProps] = createSignal(initial);
    const { unmount: dispose } = mountSolid(() => <SessionsView {...props()} />, { container });
    sessionViews.set(container, { update: (next) => setProps(next), dispose });
  }
  flush();
}

export function disposeSessionView(container: HTMLElement) {
  sessionViews.get(container)?.dispose();
  sessionViews.delete(container);
}

export function disposeSessionViews() {
  for (const view of sessionViews.values()) {
    view.dispose();
  }
  sessionViews.clear();
}
