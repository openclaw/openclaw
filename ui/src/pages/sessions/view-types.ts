import type {
  AgentIdentityResult,
  GatewaySessionRow,
  SessionsListResult,
} from "../../api/types.ts";
import type { SessionArchivedFilter } from "../../lib/sessions/index.ts";
import type { SessionPatch } from "../../lib/sessions/patch.ts";
import type { SessionsAdvancedFiltersProps } from "./sessions-filters.tsx";
import type { TranscriptSearchProps } from "./transcript-search-view.tsx";

export type SessionsProps = {
  loading: boolean;
  refreshing: boolean;
  result: SessionsListResult | null;
  error: string | null;
  basePath: string;
  agentId: string;
  mainKey: string;
  searchQuery: string;
  agentIdentityById: Record<string, AgentIdentityResult>;
  sortColumn: "key" | "kind" | "updated" | "tokens";
  sortDir: "asc" | "desc";
  knownCategories: string[];
  page: number;
  pageSize: number;
  selectedKeys: Set<string>;
  sessionMenu: { key: string } | null;
  expandedSessionKey: string | null;
  labelDisabledReason?: (row: GatewaySessionRow) => string | undefined;
  patchAdminDisabledReason?: string;
  deleteArchivedDisabledReason?: string;
  deleteSelectedDisabledReason?: string;
  onClearFilters: () => void;
  onSearchChange: (query: string) => void;
  onSortChange: (column: "key" | "kind" | "updated" | "tokens", dir: "asc" | "desc") => void;
  onAssignCategory: (key: string, category: string | null) => void;
  onLoadMore: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onRefresh: () => void;
  onStatusFilterChange: (statusFilter: SessionArchivedFilter) => void;
  onDeleteAllArchived: () => void;
  onPatch: (key: string, patch: SessionPatch, options?: { sessionScope?: boolean }) => void;
  onToggleSelect: (key: string) => void;
  onSelectPage: (keys: string[]) => void;
  onDeselectPage: (keys: string[]) => void;
  onDeselectAll: () => void;
  onDeleteSelected: () => void;
  onOpenSessionMenu: (
    row: GatewaySessionRow,
    position: { x: number; y: number },
    trigger: HTMLElement | null,
  ) => void;
  onToggleDetails: (sessionKey: string) => void;
} & TranscriptSearchProps &
  SessionsAdvancedFiltersProps;
