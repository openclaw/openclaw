import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { SidebarSessionSection, SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import type {
  SidebarEmptyGroupsMode,
  SidebarRecentSession,
  SidebarSessionSortMode,
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";

export type SidebarProjectionInput = {
  rows: SidebarRecentSession[];
  selectedSessionKey: string | null;
  /** Personal placements participate in disclosure lifetime, not canonical grouping. */
  referencedRows?: readonly SidebarRecentSession[];
  sections?: SidebarSessionSection<SidebarRecentSession>[];
  /** Personal pins render in the Pinned section above these sections, never twice. */
  pinnedKeys?: ReadonlySet<string>;
  grouping: SidebarSessionsGrouping;
  knownGroups: string[] | undefined;
  selfOwnerId?: string | null;
  catalogIds?: readonly string[];
  sectionOrder?: readonly string[];
  collapsedSections: ReadonlySet<string>;
  emptyGroupsMode: SidebarEmptyGroupsMode;
  /** "owner" selects exactly one owner; "involvingMe" can span several. */
  ownerFilter: "owner" | "involvingMe" | null;
  visibleSessionLimits: ReadonlyMap<string, number>;
  sortMode: SidebarSessionSortMode;
  statusFilter: SidebarSessionStatusFilter;
  agentId: string;
  connectionIdentity: object | null;
  listSource: object | null;
  /** False while rows are only route placeholders, before the session list arrives. */
  listLoaded: boolean;
  subtitle: {
    sidebarLiveActivity: boolean;
    showPreview: boolean;
    narrationLines: ReadonlyMap<string, string>;
    observerDigests: ReadonlyMap<string, SessionObserverDigest>;
  };
};
