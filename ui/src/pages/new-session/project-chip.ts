import type {
  ProjectRecord,
  ProjectRecent,
  RemoteProject,
} from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { pathDisplayName } from "../../lib/path-display.ts";
import type { PlaceBrowserState } from "./place-browser-state.ts";

registerNewSessionSetupEnglish();

/** Detects pasted clone URLs; the Gateway remains authoritative for host validation. */
export function projectCloneInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-") || /\s/u.test(trimmed)) {
    return null;
  }
  return /^(?:https:\/\/|ssh:\/\/git@|git@[^:]+:)/iu.test(trimmed) ? trimmed : null;
}

export type DraftRemoteProject = Readonly<{
  identity: string;
  cloneUrl: string;
  defaultBranch?: string;
  projectId?: string;
}>;

type ProjectChipState = Readonly<{
  label: string;
  localProjects: readonly ProjectRecord[];
  recents: readonly Exclude<ProjectRecent, { kind: "project" }>[];
  showWorkspace: boolean;
}>;

export function resolveProjectChip(params: {
  folder: string;
  workspace: string;
  projectId: string;
  selectedRemoteProject: DraftRemoteProject | null;
  projects: readonly ProjectRecord[];
  recents: readonly ProjectRecent[];
  projectQuery: string;
  freshWorkspace?: boolean;
}): ProjectChipState {
  const folder = params.folder.trim();
  const selectedProject = params.projects.find((project) => project.id === params.projectId);
  const normalizedQuery = params.projectQuery.trim().toLowerCase();
  const localProjects = normalizedQuery
    ? params.projects.filter((project) =>
        [project.displayName, project.originUrl ?? "", project.repoRoot ?? ""]
          .join("\n")
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : params.projects;
  return {
    label: params.freshWorkspace
      ? t("newSession.newWorkspace")
      : selectedProject
        ? selectedProject.displayName
        : params.selectedRemoteProject?.identity
          ? params.selectedRemoteProject.identity
          : folder
            ? pathDisplayName(folder)
            : pathDisplayName(params.workspace) || t("newSession.folderPlaceholder"),
    localProjects,
    recents: normalizedQuery ? [] : params.recents.filter((recent) => recent.kind !== "project"),
    showWorkspace:
      !normalizedQuery ||
      [pathDisplayName(params.workspace), params.workspace]
        .join("\n")
        .toLowerCase()
        .includes(normalizedQuery),
  };
}

export type ProjectChipOptions = {
  state: ProjectChipState;
  browseAvailable: boolean;
  isAdmin: boolean;
  canWrite: boolean;
  folder: string;
  workspace: string;
  projects: readonly ProjectRecord[];
  projectQuery: string;
  projectSearchAvailable: boolean;
  projectAddAvailable: boolean;
  remoteProjects: readonly RemoteProject[];
  selectedRemoteProject: DraftRemoteProject | null;
  projectSearchCredentialMissing: boolean;
  projectSearchLoading: boolean;
  projectSearchError: string | null;
  projectId: string;
  freshWorkspace?: boolean;
  onNewWorkspace?: () => void;
  gatewayLabel: string;
  submitting: boolean;
  pendingPlacement: boolean;
  popoverOpen: boolean;
  popoverHiding: boolean;
  browserOpen: boolean;
  browser: PlaceBrowserState;
  registerProjectPath: string | null;
  registeringProject: boolean;
  onGuardTransition: (event: MouseEvent) => void;
  onPopoverShow: () => void;
  onPopoverHide: () => void;
  onPopoverAfterHide: () => void;
  onSelectProject: (projectId: string) => void;
  onProjectQueryInput: (query: string) => void;
  onSelectRemoteProject: (project: DraftRemoteProject) => void;
  onApplyFolder: (folder: string) => void;
  onBrowse: () => void;
  onBrowserBack: () => void;
  onRegisterProject: (path: string) => void;
  onClose: () => void;
};
