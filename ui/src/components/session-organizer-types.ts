import type {
  FsListDirResult,
  WorktreeRepositoryStatus,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import type {
  SidebarRecentSession,
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionDataOwner } from "./session-data.ts";

export interface SessionOrganizerDependencies {
  readonly sessionData: Pick<
    SessionDataOwner,
    | "beginSessionMutation"
    | "isSessionMutationScopeCurrent"
    | "publishSessionMutationError"
    | "refreshSidebarSessions"
    | "resetSessionList"
    | "sessionMutationError"
    | "sessionDraftSignal"
  >;
  readonly sidebarEntries: readonly string[];
  readonly onUpdateSidebarEntries?: (entries: string[]) => void;
  sessionsGrouping: SidebarSessionsGrouping;
  sessionsShowCron: boolean;
  sessionsShowPreview: boolean;
  sessionsShowSystem: boolean;
  sessionsStatusFilter: SidebarSessionStatusFilter;
  clearSessionSelection(): void;
  findSidebarMenuSessionByKey(sessionKey: string): SidebarRecentSession | undefined;
  knownSessionGroups(): string[];
  listSessionGroupFolders(path?: string): Promise<FsListDirResult>;
  inspectSessionGroupRepository(path?: string): Promise<WorktreeRepositoryStatus>;
  sessionGroupDefaults(name: string): { cwd: string; worktree: boolean } | null;
  knownSessionCatalogIds(): string[];
  knownSectionOrder(): string[];
  pruneSidebarSessionEntry(key: string): void;
  reconciledSidebarZone(): {
    sidebarEntries: readonly string[];
  };
  selectSession(sessionKey: string): void;
  sidebarSessionStatusFilter(): SidebarSessionStatusFilter;
}
