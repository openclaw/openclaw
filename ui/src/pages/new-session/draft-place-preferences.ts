import type { GatewayAgentRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import * as catalog from "./catalog-target.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceBrowser } from "./draft-place-browser.ts";
import type { DraftRepositoryController } from "./draft-repository-state.ts";
import type { NewSessionRouteData } from "./location.ts";
import type { NewSessionModelControl } from "./model-control.ts";
import type { NewSessionWhere } from "./preferences.ts";

/** One draft owns both explicit destination intent and deferred preference restoration. */
export function createDraftPlaceSelection() {
  return {
    deviceId: "",
    autoDevice: false,
    profileId: "",
    folderSelected: false,
    preferredWhere: null as NewSessionWhere | null,
    preferredProject: "",
    whereSelected: false,
    requiredModelDefaults: false,
    projectSelected: false,
  };
}

type RestorationHost = {
  read: () => { context: ApplicationContext | undefined; data: NewSessionRouteData | undefined };
  agentId: () => string;
  selectedAgent: () => GatewayAgentRow | undefined;
  requiredWorkerInference: () => boolean;
  requiredPlacement: () => boolean;
  remotePlacement: () => boolean;
  isAdmin: () => boolean;
  modelControl: NewSessionModelControl;
  browser: DraftPlaceBrowser;
  gateway: DraftGatewayState;
  repository: DraftRepositoryController;
  persistPreference: (patch: Parameters<DraftGatewayState["persistPreference"]>[2]) => void;
  requestUpdate: () => void;
};

/** Keep reads live and preserve project-before-destination restoration and callback ordering. */
export function restoreDraftPlaceSelections(
  state: ReturnType<typeof createDraftPlaceSelection>,
  host: RestorationHost,
): void {
  if (state.requiredModelDefaults !== host.requiredWorkerInference()) {
    state.requiredModelDefaults = host.requiredWorkerInference();
    host.modelControl.load(
      host.read().context,
      host.agentId(),
      !catalog.isTarget(host.read().data),
      {
        agent: host.selectedAgent(),
        preference: host.gateway.readPreference(host.agentId()),
        configuredDefaults: state.requiredModelDefaults,
      },
    );
  }
  if (host.requiredPlacement()) {
    if (
      host.browser.browserOpen ||
      (["where", "project", "checkout"] as const).some((kind) => host.browser.popoverOpen(kind))
    ) {
      host.browser.close();
    }
    return;
  }
  let changed = false;
  const preferredWhere = state.whereSelected ? null : state.preferredWhere;
  const preferredProject = state.projectSelected ? "" : state.preferredProject;

  if (preferredProject) {
    const project = host.browser.projects.find((candidate) => candidate.id === preferredProject);
    if (project) {
      host.browser.selectProject({ kind: "local", id: project.id });
      state.folderSelected = false;
      state.preferredProject = "";
      changed = true;
    } else if (host.browser.projectsReady) {
      state.preferredProject = "";
      changed = true;
    }
  }

  if (
    (preferredWhere?.kind === "device" || preferredWhere?.kind === "auto-device") &&
    host.gateway.cloudProfilesReady
  ) {
    state.autoDevice = preferredWhere.kind === "auto-device";
    state.deviceId = preferredWhere.kind === "device" ? preferredWhere.id : "";
    state.profileId = "";
    host.repository.forceWorktree(host.remotePlacement());
    state.preferredWhere = null;
    changed = true;
  } else if (preferredWhere?.kind === "cloud" && host.gateway.cloudProfilesReady) {
    const preferredProfile = host.gateway.cloudProfiles.find(
      (profile) => profile.id === preferredWhere.id,
    );
    if (
      host.isAdmin() &&
      preferredProfile &&
      !host.modelControl.cloudRuntimeUnsupportedReason(preferredProfile)
    ) {
      state.deviceId = "";
      state.autoDevice = false;
      state.profileId = preferredWhere.id;
      host.repository.forceWorktree(true);
    } else {
      state.profileId = "";
      host.persistPreference({ where: { kind: "local" } });
    }
    state.preferredWhere = null;
    changed = true;
  }

  if (changed) {
    host.repository.synchronize();
    host.requestUpdate();
  }
}
