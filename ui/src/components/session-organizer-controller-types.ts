import type { ReactiveControllerHost } from "lit";
import type {
  FsListDirResult,
  WorktreeRepositoryStatus,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import type {
  SidebarRecentSession,
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";

export type SessionOrganizerOperations = typeof import("./session-organizer-operations.runtime.ts");
export type InputDialogOpener = (typeof import("./input-dialog.ts"))["showInputDialog"];
export type SessionGroupDefaultsDialogOpener =
  (typeof import("./session-group-defaults-dialog.ts"))["showSessionGroupDefaultsDialog"];

export type SidebarZoneDropTarget = {
  entry: string;
  position: "before" | "after";
};

export interface SessionOrganizerControllerHost extends ReactiveControllerHost {
  readonly sessionData: Pick<
    SessionDataController,
    | "beginSessionMutation"
    | "isSessionMutationScopeCurrent"
    | "publishSessionMutationError"
    | "refreshSidebarSessions"
    | "resetSessionList"
    | "sessionMutationError"
  >;
  readonly onUpdateSidebarEntries?: (entries: string[]) => void;
  sessionsGrouping: SidebarSessionsGrouping;
  sessionsShowCron: boolean;
  sessionsShowPreview: boolean;
  sessionsShowSystem: boolean;
  expandedAgentId(): string;
  sessionsStatusFilter: SidebarSessionStatusFilter;
  clearSessionSelection(): void;
  findSidebarSessionByKey(sessionKey: string): SidebarRecentSession | undefined;
  knownSessionGroups(): string[];
  listSessionGroupFolders(path?: string): Promise<FsListDirResult>;
  inspectSessionGroupRepository(path?: string): Promise<WorktreeRepositoryStatus>;
  sessionGroupAgentGeneration(): number;
  sessionGroupDefaults(name: string): { cwd: string; worktree: boolean } | null;
  knownSessionCatalogIds(): string[];
  knownSectionOrder(): string[];
  pruneSidebarSessionEntry(key: string): void;
  reconciledSidebarZone(): { sidebarEntries: readonly string[] };
  selectSession(sessionKey: string): void;
  sidebarSessionStatusFilter(): SidebarSessionStatusFilter;
}
