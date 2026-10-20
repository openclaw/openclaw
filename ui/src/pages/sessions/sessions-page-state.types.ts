import type { SessionsListResult } from "../../api/types.ts";
import type { SessionArchivedFilter } from "../../lib/sessions/index.ts";
import type { SessionsTableState } from "./page-state.ts";
import type { SessionDeleteRow } from "./selection.ts";
import type { SessionsPageMenuProps } from "./session-menu.tsx";
import type { TranscriptSearchProps } from "./transcript-search-view.tsx";

export type SessionsFilters = {
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
};

export type SessionsPageState = SessionsFilters &
  SessionsTableState &
  Pick<TranscriptSearchProps, "transcriptSearchQuery" | "transcriptSearch"> & {
    result: SessionsListResult | null;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
    statusFilter: SessionArchivedFilter;
    searchQuery: string;
    expandedSessionKey: string | null;
    selectedSessions: Map<string, SessionDeleteRow>;
    sessionMenu: SessionsPageMenuProps["menu"] | null;
    sessionMenuWork: SessionsPageMenuProps["work"];
  };
