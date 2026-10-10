import { parseProjectGitUrl } from "../../../../src/projects/project-git-url.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceBrowser } from "./draft-place-browser.ts";
import type { DraftRepositoryController } from "./draft-repository-state.ts";
import type { NewSessionModelControl } from "./model-control.ts";
import type { NewSessionPreference, NewSessionWhere } from "./preferences.ts";
import type { DraftRemoteProject } from "./project-chip.ts";

export type DraftPlaceRestoreState = {
  deviceId: string;
  autoDevice: boolean;
  cloudProfileId: string;
  freshWorkspace: boolean;
  folderSelectedByUser: boolean;
  preferredWhereRestore: NewSessionWhere | null;
  preferredProjectRestore: string;
  preferredRemoteProjectRestore: DraftRemoteProject | null;
  configuredDefaultRepositoryPending: boolean;
  configuredDefaultRepositoryOptOut: boolean;
  whereSelectedByUser: boolean;
  projectSelectedByUser: boolean;
  requiredModelDefaults: boolean;
};

export function createDraftPlaceRestoreState(): DraftPlaceRestoreState {
  return {
    deviceId: "",
    autoDevice: false,
    cloudProfileId: "",
    freshWorkspace: true,
    folderSelectedByUser: false,
    preferredWhereRestore: null,
    preferredProjectRestore: "",
    preferredRemoteProjectRestore: null,
    configuredDefaultRepositoryPending: false,
    configuredDefaultRepositoryOptOut: false,
    whereSelectedByUser: false,
    projectSelectedByUser: false,
    requiredModelDefaults: false,
  };
}

export function markDraftPlaceProjectChoice(state: DraftPlaceRestoreState, optOut: boolean) {
  state.projectSelectedByUser = true;
  state.preferredProjectRestore = "";
  state.preferredRemoteProjectRestore = null;
  state.configuredDefaultRepositoryPending = false;
  state.configuredDefaultRepositoryOptOut = optOut;
}

export function adoptDraftPlaceRestorePreference(
  state: DraftPlaceRestoreState,
  preference: NewSessionPreference | null | undefined,
  groupTarget: boolean,
  catalogTarget: boolean,
) {
  const localTarget = groupTarget || catalogTarget;
  if (!state.whereSelectedByUser) {
    const where = localTarget ? undefined : preference?.where;
    state.preferredWhereRestore = where?.kind === "local" ? null : (where ?? null);
  }
  state.preferredProjectRestore = localTarget ? "" : (preference?.projectId ?? "");
  state.preferredRemoteProjectRestore = localTarget ? null : (preference?.remoteProject ?? null);
  state.configuredDefaultRepositoryOptOut = preference?.defaultRepositoryOptOut === true;
  state.configuredDefaultRepositoryPending =
    !localTarget &&
    !state.configuredDefaultRepositoryOptOut &&
    !preference?.projectId &&
    !preference?.remoteProject;
  if (state.preferredRemoteProjectRestore) {
    state.preferredProjectRestore = "";
  }
  state.projectSelectedByUser = false;
}

export function draftPlacePreferenceReady(
  state: DraftPlaceRestoreState,
  workspaceReady: boolean,
  projectCatalogActive: boolean,
  requiredPlacement = false,
): boolean {
  return (
    requiredPlacement ||
    (workspaceReady &&
      !(state.configuredDefaultRepositoryPending && projectCatalogActive) &&
      state.preferredWhereRestore === null &&
      !state.preferredProjectRestore &&
      !state.preferredRemoteProjectRestore)
  );
}

export function restoreDraftPlacePreferences(params: {
  state: DraftPlaceRestoreState;
  browser: DraftPlaceBrowser;
  gateway: DraftGatewayState;
  where: NewSessionWhere;
  modelControl: NewSessionModelControl;
  repositoryState: DraftRepositoryController;
  isAdmin: () => boolean;
  persistPreference: (patch: Parameters<DraftGatewayState["persistPreference"]>[2]) => void;
  requestUpdate: () => void;
  requiredPlacement: boolean;
  loadConfiguredDefaults: (configuredDefaults: boolean) => void;
}) {
  const {
    state,
    browser,
    gateway,
    modelControl,
    repositoryState,
    isAdmin,
    persistPreference,
    requestUpdate,
  } = params;
  if (state.requiredModelDefaults !== params.requiredPlacement) {
    state.requiredModelDefaults = params.requiredPlacement;
    params.loadConfiguredDefaults(params.requiredPlacement);
  }
  if (params.requiredPlacement) {
    if (
      browser.browserOpen ||
      (["where", "project", "checkout"] as const).some((kind) => browser.popoverOpen(kind))
    ) {
      browser.close();
    }
    return;
  }
  let changed = false;
  const preferredWhere = state.whereSelectedByUser ? null : state.preferredWhereRestore;
  const preferredProject = state.projectSelectedByUser ? "" : state.preferredProjectRestore;
  const savedRemote = state.preferredRemoteProjectRestore;
  const activeRemote = browser.remoteProject;
  if ((savedRemote || activeRemote) && browser.projectsReady && browser.githubHost) {
    const matchesHost = (project: DraftRemoteProject) =>
      parseProjectGitUrl(project.cloneUrl, browser.githubHost) !== null;
    const staleSaved = savedRemote && !matchesHost(savedRemote);
    const staleActive = activeRemote && !matchesHost(activeRemote);
    if (staleSaved || staleActive) {
      if (staleSaved) {
        state.preferredRemoteProjectRestore = null;
      }
      if (staleActive) {
        browser.clearProjectSelection();
        state.projectSelectedByUser = false;
      }
      if (staleActive || (staleSaved && !activeRemote && !browser.projectId)) {
        repositoryState.clearDetails(true);
      }
      state.configuredDefaultRepositoryPending =
        !state.configuredDefaultRepositoryOptOut && !preferredProject;
      persistPreference({
        remoteProject: state.preferredRemoteProjectRestore ?? browser.remoteProject ?? null,
      });
      changed = true;
    }
  }
  const configuredRemoteProject = browser.defaultRemoteProject;
  const configuredProfileId = browser.defaultRemoteProjectProfileId;
  const configuredProfile = configuredProfileId
    ? gateway.cloudProfiles.find((profile) => profile.id === configuredProfileId)
    : undefined;
  const restoringConfiguredRemoteProject = Boolean(
    configuredRemoteProject &&
    state.preferredRemoteProjectRestore?.cloneUrl === configuredRemoteProject.cloneUrl,
  );
  const configuredDefaultRequested =
    state.configuredDefaultRepositoryPending || restoringConfiguredRemoteProject;
  const configuredDefaultReady =
    configuredDefaultRequested &&
    browser.projectsReady &&
    (!configuredProfileId || gateway.cloudProfilesReady);
  const configuredDefaultAllowed = Boolean(
    configuredDefaultReady &&
    (!configuredProfileId ||
      (isAdmin() &&
        configuredProfile &&
        !modelControl.cloudRuntimeUnsupportedReason(configuredProfile))),
  );
  const preferredRemoteProject =
    state.projectSelectedByUser || !browser.projectsReady
      ? null
      : restoringConfiguredRemoteProject
        ? configuredDefaultAllowed
          ? state.preferredRemoteProjectRestore
          : null
        : (state.preferredRemoteProjectRestore ??
          (configuredDefaultAllowed ? configuredRemoteProject : null));

  if (configuredDefaultReady) {
    state.configuredDefaultRepositoryPending = false;
    if (restoringConfiguredRemoteProject && !configuredDefaultAllowed) {
      state.preferredRemoteProjectRestore = null;
      changed = true;
    }
    requestUpdate();
  }

  if (preferredRemoteProject) {
    const selectingConfiguredRemoteProject =
      configuredDefaultRequested &&
      preferredRemoteProject.cloneUrl === configuredRemoteProject?.cloneUrl;
    if (
      configuredProfileId &&
      selectingConfiguredRemoteProject &&
      configuredDefaultAllowed &&
      !state.whereSelectedByUser &&
      !preferredWhere &&
      params.where.kind === "local"
    ) {
      state.deviceId = "";
      state.autoDevice = false;
      state.cloudProfileId = configuredProfileId;
    }
    browser.selectProject({ kind: "remote", project: preferredRemoteProject });
    state.freshWorkspace = false;
    state.folderSelectedByUser = false;
    if (
      (selectingConfiguredRemoteProject && !restoringConfiguredRemoteProject) ||
      (!repositoryState.baseRef && preferredRemoteProject.defaultBranch)
    ) {
      repositoryState.setDetail("baseRef", preferredRemoteProject.defaultBranch ?? "", false);
    }
    state.preferredRemoteProjectRestore = null;
    changed = true;
  }

  if (preferredProject && !preferredRemoteProject) {
    const project = browser.projects.find((candidate) => candidate.id === preferredProject);
    if (project) {
      browser.selectProject({ kind: "local", id: project.id });
      state.folderSelectedByUser = false;
    }
    if (project || browser.projectsReady) {
      state.preferredProjectRestore = "";
      changed = true;
    }
  }

  if (preferredWhere && preferredWhere.kind !== "local" && gateway.cloudProfilesReady) {
    if (preferredWhere.kind === "cloud") {
      const preferredProfile = gateway.cloudProfiles.find(
        (profile) => profile.id === preferredWhere.id,
      );
      if (
        isAdmin() &&
        preferredProfile &&
        !modelControl.cloudRuntimeUnsupportedReason(preferredProfile)
      ) {
        state.deviceId = "";
        state.autoDevice = false;
        state.cloudProfileId = preferredWhere.id;
      } else {
        state.cloudProfileId = "";
        persistPreference({ where: { kind: "local" } });
      }
    } else {
      state.autoDevice = preferredWhere.kind === "auto-device";
      state.deviceId = preferredWhere.kind === "device" ? preferredWhere.id : "";
      state.cloudProfileId = "";
    }
    state.preferredWhereRestore = null;
    changed = true;
  }

  if (changed) {
    repositoryState.synchronize();
    requestUpdate();
  }
}
