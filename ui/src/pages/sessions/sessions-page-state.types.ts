import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionsGroupBy } from "../../lib/sessions/grouping.ts";
import type { SessionArchivedFilter } from "../../lib/sessions/index.ts";
import type { buildSessionsListQuery } from "./list-query.ts";
import type { SessionDeleteRow } from "./selection.ts";
import type { SessionsPageMenuProps } from "./session-menu.tsx";
import type { TranscriptSearchProps } from "./transcript-search-view.tsx";

export type SessionsPageListBinding = {
  sessions: ApplicationContext["sessions"];
  query: ReturnType<typeof buildSessionsListQuery>;
  key: string;
  transcriptKey: string;
};

export type SessionsPageState = {
  sortColumn: "key" | "updated";
  sortDir: "asc" | "desc";
  groupBy: SessionsGroupBy;
  page: number;
  pageSize: number;
  result: SessionsListResult | null;
  roster: Promise<null> | null;
  loading: boolean;
  refreshing: boolean;
  error: unknown;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  statusFilter: SessionArchivedFilter;
  searchQuery: string;
  transcriptSearchQuery: string;
  expandedSessionKey: string | null;
  transcriptSearch: TranscriptSearchProps["transcriptSearch"];
  selectedSessions: Map<string, SessionDeleteRow>;
  sessionMenu: SessionsPageMenuProps["menu"] | null;
  sessionMenuWork: SessionsPageMenuProps["work"];
};
