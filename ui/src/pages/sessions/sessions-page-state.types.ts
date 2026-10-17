import type { SessionDeleteRow } from "./selection.ts";
import type { SessionsPageMenuProps } from "./session-menu.tsx";
import type { SessionsProps } from "./view-types.ts";

export type SessionsPageState = Pick<
  SessionsProps,
  | "result"
  | "loading"
  | "refreshing"
  | "error"
  | "activeMinutes"
  | "limit"
  | "includeGlobal"
  | "includeUnknown"
  | "statusFilter"
  | "searchQuery"
  | "transcriptSearchQuery"
  | "expandedSessionKey"
  | "transcriptSearch"
> & {
  selectedSessions: Map<string, SessionDeleteRow>;
  sessionMenu: SessionsPageMenuProps["menu"] | null;
  sessionMenuWork: SessionsPageMenuProps["work"];
};
