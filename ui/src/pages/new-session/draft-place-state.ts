import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import * as catalog from "./catalog-target.ts";
import { projectDevicePlacements, resolveSelectedDevicePlacement } from "./device-placement.ts";
import { DraftCloudMachineState } from "./draft-cloud-machine-state.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceBrowser } from "./draft-place-browser.ts";
import {
  createDraftPlaceSelection,
  restoreDraftPlaceSelections,
} from "./draft-place-preferences.ts";
import { DraftRepositoryController } from "./draft-repository-state.ts";
import type { PendingPlacementPlace } from "./draft-session-placement.ts";
import { DraftRestoredFolderValidation } from "./folder-validation.ts";
import { newSessionSearch, type NewSessionRouteData } from "./location.ts";
import { NewSessionModelControl } from "./model-control.ts";
import {
  resolveNewSessionFolderPreference,
  resolveNewSessionWhere,
  type NewSessionPreference,
} from "./preferences.ts";
import type { DraftRemoteProject } from "./project-chip.ts";

registerNewSessionSetupEnglish();

type DraftPlaceSnapshot = Readonly<{
  context: ApplicationContext | undefined;
  data: NewSessionRouteData | undefined;
  submitting: boolean;
  pendingPlacementSessionKey: string;
}>;

type DraftPlaceCallbacks = {
  requestUpdate: () => void;
  onError: (error: string | null) => void;
  onClearError: (error: string) => void;
};

export class DraftPlaceState {
  terminalHostId = "gateway:local";
  private terminalHostInitialized = false;

  get terminalOnNode(): boolean {
    return this.terminalHostId.startsWith("node:");
  }

  selectTerminalHost(hostId: string) {
    if (this.read().submitting) {
      return;
    }
    this.terminalHostInitialized = true;
    if (hostId === this.terminalHostId) {
      return;
    }
    this.terminalHostId = hostId;
    this.folderValidation.cancel();
    this.browser.clearProjectSelection();
    this.repositoryState.reset();
    this.folderValue = this.terminalOnNode ? "" : this.workspacePath();
    this.selection.folderSelected = true;
    if (!this.terminalOnNode) {
      this.repositoryState.load();
    }
    this.callbacks.requestUpdate();
  }

  synchronizeTerminalHosts() {
    const hosts = this.read().data?.terminalHosts;
    if (this.terminalHostInitialized || !hosts?.length) {
      return;
    }
    this.selectTerminalHost(
      hosts.find((host) => host.hostId === this.terminalHostId)?.hostId ?? hosts[0]!.hostId,
    );
  }
  private agentIdValue = "";
  private folderValue = "";
  private freshWorkspaceValue = true;
  private readonly selection = createDraftPlaceSelection();
  readonly cloudMachines = new DraftCloudMachineState();
  private agentsHydratedValue = false;
  private agentSelectedByUser = false;
  private routeModelIntentActive = true;

  readonly modelControl: NewSessionModelControl;
  private readonly repositoryState: DraftRepositoryController;
  private readonly folderValidation: DraftRestoredFolderValidation;

  constructor(
    private readonly gateway: DraftGatewayState,
    readonly browser: DraftPlaceBrowser,
    private readonly read: () => DraftPlaceSnapshot,
    private readonly callbacks: DraftPlaceCallbacks,
  ) {
    this.folderValidation = new DraftRestoredFolderValidation(
      () => ({
        gateway: this.read().context?.gateway.snapshot,
        folder: this.folderValue,
        selectedByUser: this.selection.folderSelected,
        isAdmin: this.isAdmin(),
      }),
      {
        onApprovedRootsChange: callbacks.requestUpdate,
        onVerified: () => {
          this.callbacks.onClearError(t("newSession.browserLoadFailed"));
          this.repositoryState.load();
        },
        onMissing: () => this.restoreWorkspaceFolder(),
        onFailed: () => this.callbacks.onError(t("newSession.browserLoadFailed")),
      },
    );
    this.repositoryState = new DraftRepositoryController(
      () => ({
        agentId: this.agentIdValue,
        agents: this.agents(),
        remotePlacement: this.remotePlacement,
        selectedProject: this.browser.selectedProject(),
        remoteProject: this.browser.remoteProject,
        folder: this.folderValue,
        workspace: this.workspacePath(),
        workspaceGit: this.selectedAgent()?.workspaceGit === true,
        gateway: this.read().context?.gateway.snapshot,
      }),
      {
        requestUpdate: callbacks.requestUpdate,
        persistPreference: (patch) => this.persistPreference(patch),
        capturePreferenceConsumption: (owner, expected) =>
          this.gateway.capturePreferenceConsumption(owner.agentId, owner.workspace, expected),
      },
    );
    this.modelControl = new NewSessionModelControl(
      callbacks.requestUpdate,
      (selection) => this.persistPreference(selection),
      (catalogId) =>
        this.read().context?.navigate("new-session", {
          search: newSessionSearch(this.agentIdValue, { catalogId }),
        }),
    );
  }

  get agentId(): string {
    return this.agentIdValue;
  }

  get folder(): string {
    return this.folderValue;
  }

  get worktree(): boolean {
    return (this.freshWorkspace || this.repositoryState.worktree) && !this.remoteRepository;
  }

  get freshWorkspace(): boolean {
    return this.requiredPlacement || (this.remotePlacement && this.freshWorkspaceValue);
  }

  get remoteRepository(): SessionCreateParams["repository"] {
    return this.requiredPlacement ? undefined : this.repositoryState.remoteRepository;
  }

  get worktreeName(): string {
    return this.freshWorkspace ? "" : this.repositoryState.worktreeName;
  }

  get baseRef(): string {
    return this.freshWorkspace ? "" : this.repositoryState.baseRef;
  }

  get repository() {
    return this.repositoryState.repository;
  }

  get deviceId(): string {
    return this.requiredPlacement ? "" : this.selection.deviceId;
  }

  get autoDevice(): boolean {
    return !this.requiredPlacement && this.selection.autoDevice;
  }

  get remotePlacement(): boolean {
    return Boolean(
      this.requiredPlacement ||
      this.selection.deviceId ||
      this.selection.autoDevice ||
      this.selection.profileId,
    );
  }

  get requiredPlacement(): boolean {
    return Boolean(this.gateway.requiredProfile) && !catalog.isTarget(this.read().data);
  }

  get requiredWorkerInference(): boolean {
    return (
      this.requiredPlacement &&
      this.gateway.cloudProfiles.some(
        (profile) => profile.id === this.gateway.requiredProfile && profile.inference === "worker",
      )
    );
  }

  get cloudProfileId(): string {
    return this.requiredPlacement ? this.gateway.requiredProfile! : this.selection.profileId;
  }

  get cloudSelection() {
    return this.requiredPlacement
      ? { os: "", machineClass: "" }
      : this.cloudMachines.selection(this.selection.profileId, this.gateway.cloudProfiles);
  }

  get agentsHydrated(): boolean {
    return this.agentsHydratedValue;
  }

  preferenceSelection(): NewSessionPreference {
    // Remember selection intent, not a temporary projection while discovery is pending.
    const where =
      this.selection.preferredWhere ??
      resolveNewSessionWhere({
        cloudProfileId: this.selection.profileId,
        deviceId: this.selection.deviceId,
        autoDevice: this.selection.autoDevice,
      });
    return {
      workspace: this.workspacePath(),
      folder: this.folderValue,
      projectId: this.selection.preferredProject || this.browser.projectId,
      where,
      worktree:
        ((where.kind !== "local" && this.freshWorkspaceValue) ||
          this.repositoryState.preferenceWorktree) &&
        !this.remoteRepository,
      freshWorkspace: this.freshWorkspaceValue,
      baseRef: this.repositoryState.baseRef,
      worktreeName: this.repositoryState.worktreeName,
    };
  }

  get placementPreferenceReady(): boolean {
    if (this.requiredPlacement) {
      return true;
    }
    return (
      (this.freshWorkspace || this.repositoryState.preferenceReady) &&
      this.selection.preferredWhere === null &&
      !this.selection.preferredProject
    );
  }

  canAdoptGroupDefaults(): boolean {
    return (
      !this.selection.folderSelected &&
      !this.selection.whereSelected &&
      !this.selection.projectSelected &&
      !this.repositoryState.hasUserSelection
    );
  }

  adoptGroupDefaults() {
    if (this.read().data?.groupStatus !== "resolved" || !this.canAdoptGroupDefaults()) {
      return;
    }
    this.adoptAgentDefaults({ preserveSelectedAgent: true });
  }

  setAgentsHydrated(value: boolean) {
    this.agentsHydratedValue = value;
  }

  agents() {
    return listSelectableAgents(this.read().context?.agents.state.agentsList?.agents ?? []);
  }

  selectedAgent() {
    const agentId = normalizeAgentId(this.agentIdValue);
    return this.agents().find((agent) => normalizeAgentId(agent.id) === agentId);
  }

  devicePlacementRuntime() {
    return this.modelControl.resolveAgentRuntime({
      agent: this.selectedAgent(),
      context: this.read().context,
    });
  }

  devices() {
    return projectDevicePlacements(
      this.gateway.environments,
      this.devicePlacementRuntime()?.devicePlacement,
      this.gateway.deviceCatalogDisabledReason,
    );
  }

  private findDevice(deviceId: string) {
    return this.devices().find((device) => device.deviceId === deviceId);
  }

  devicePlacementReady(): boolean {
    return this.devicePlacement().ready;
  }

  devicePlacementDisabledReason(): string | undefined {
    return this.devicePlacement().disabledReason;
  }

  private devicePlacement() {
    return resolveSelectedDevicePlacement(this.devices(), this.gateway.environments, this);
  }

  isAdmin(): boolean {
    return hasOperatorAdminAccess(this.read().context?.gateway.snapshot.hello?.auth ?? null);
  }

  canWrite(): boolean {
    return hasOperatorWriteAccess(this.read().context?.gateway.snapshot.hello?.auth ?? null);
  }

  workspacePath(): string {
    return normalizeOptionalString(this.selectedAgent()?.workspace) ?? "";
  }

  knownWorkspaceRoots(): string[] {
    return this.folderValidation.knownWorkspaceRoots(this.workspacePath());
  }

  recordGatewayApprovedListing(listing: FsListDirResult) {
    this.folderValidation.recordApprovedListing(listing);
  }

  folderSubmissionBlocked(): boolean {
    if (this.freshWorkspace) {
      return false;
    }
    if (this.browser.projectId || this.browser.remoteProject) {
      return !this.browser.remoteProject && !this.browser.selectedProject();
    }
    // Free-typed paths still reach sessions.create so the Gateway can return
    // the authoritative missing-scope error instead of the UI dead-ending.
    return this.folderValidation.blocked;
  }

  adoptAgentDefaults(
    options: { preserveSelectedAgent?: boolean; preserveSelectedFolder?: boolean } = {},
  ) {
    const snapshot = this.read();
    const agents = this.agents();
    const configuredDefault = snapshot.context?.agents.state.agentsList?.defaultId;
    const fallback = agents.some((agent) => agent.id === configuredDefault)
      ? (configuredDefault ?? "")
      : (agents[0]?.id ?? "");
    const keepSelectedAgent =
      options.preserveSelectedAgent && this.agentSelectedByUser && Boolean(this.selectedAgent());
    if (!keepSelectedAgent) {
      this.agentIdValue = catalog.resolveAgentId(snapshot.data, agents, fallback);
      this.agentSelectedByUser = false;
    }
    // Node directories belong to the native host, never Gateway preferences or Git discovery.
    if (catalog.isTarget(snapshot.data) && this.terminalOnNode) {
      this.callbacks.requestUpdate();
      return;
    }
    const preference = this.agentIdValue ? this.gateway.readPreference(this.agentIdValue) : null;
    const keepSelectedFolder = options.preserveSelectedFolder && this.selection.folderSelected;
    if (!keepSelectedFolder && !snapshot.pendingPlacementSessionKey) {
      const workspace = this.workspacePath();
      const savedFolder = resolveNewSessionFolderPreference(preference, workspace);
      const groupTarget = Boolean(snapshot.data?.group);
      const groupFolder = snapshot.data?.groupCwd ?? "";
      const groupWorktree = snapshot.data?.groupWorktree === true;
      this.folderValue = groupTarget ? groupFolder || workspace : savedFolder.folder;
      if (!this.selection.projectSelected) {
        this.freshWorkspaceValue = !groupTarget && savedFolder.freshWorkspace;
      }
      this.selection.folderSelected = false;
      this.repositoryState.adoptPreference(groupTarget ? { worktree: groupWorktree } : preference);
      const preferredWhere =
        groupTarget || catalog.isTarget(snapshot.data)
          ? { kind: "local" as const }
          : (preference?.where ?? { kind: "local" as const });
      if (!this.selection.whereSelected) {
        this.selection.preferredWhere = preferredWhere.kind === "local" ? null : preferredWhere;
      }
      this.selection.preferredProject =
        groupTarget || catalog.isTarget(snapshot.data) ? "" : (preference?.projectId ?? "");
      this.selection.projectSelected = false;
      if (savedFolder.workspaceMoved && !groupTarget) {
        this.persistPreference({ folder: workspace });
      }
    }
    if (keepSelectedFolder && !snapshot.pendingPlacementSessionKey && this.agentIdValue) {
      this.persistPreference({ folder: this.folderValue, worktree: this.worktree });
    }
    if (this.remotePlacement) {
      this.repositoryState.forceWorktree(true);
    }
    this.modelControl.load(snapshot.context, this.agentIdValue, !catalog.isTarget(snapshot.data), {
      agent: this.selectedAgent(),
      preference,
      configuredDefaults: this.requiredWorkerInference,
      initialModel: this.routeModelIntentActive
        ? catalog.requestedModelForAgent(snapshot.data, this.agentIdValue)
        : undefined,
    });
    if (this.selection.preferredProject) {
      this.folderValidation.cancel();
    } else if (
      !this.selection.folderSelected &&
      this.folderValue !== this.workspacePath() &&
      !snapshot.pendingPlacementSessionKey
    ) {
      this.folderValidation.validate(this.folderValue);
    } else {
      this.folderValidation.cancel();
      this.repositoryState.synchronize();
    }
    this.callbacks.requestUpdate();
  }

  private resetPlaceSelection() {
    this.freshWorkspaceValue = true;
    this.selection.folderSelected = false;
    this.folderValidation.reset();
    this.selection.preferredWhere = null;
    this.selection.preferredProject = "";
    this.selection.whereSelected = false;
    this.selection.projectSelected = false;
    this.selection.deviceId = "";
    this.selection.autoDevice = false;
    this.selection.profileId = "";
    this.repositoryState.reset();
  }

  resetDraft() {
    this.routeModelIntentActive = true;
    this.terminalHostId = "gateway:local";
    this.terminalHostInitialized = false;
    this.agentSelectedByUser = false;
    this.folderValue = "";
    this.browser.clearProjectSelection();
    this.resetPlaceSelection();
    this.browser.resetProjectSearch();
    this.modelControl.reset();
    this.cloudMachines.clear();
    this.callbacks.requestUpdate();
  }

  invalidateGatewayDiscovery(resetHostSelection: boolean) {
    this.repositoryState.invalidate();
    this.agentsHydratedValue = false;
    this.modelControl.invalidate(resetHostSelection);
    this.browser.close();
    this.folderValidation.reset();
    this.browser.resetProjectSearch();
    this.browser.resetProjects(resetHostSelection);
    if (!resetHostSelection) {
      this.callbacks.requestUpdate();
      return;
    }
    this.agentIdValue = "";
    this.agentSelectedByUser = false;
    this.folderValue = "";
    this.resetPlaceSelection();
    this.cloudMachines.clear();
    this.callbacks.requestUpdate();
  }

  applyPendingPlacement(params: PendingPlacementPlace) {
    this.agentIdValue = params.agentId;
    this.selection.deviceId = params.deviceId ?? "";
    this.selection.autoDevice = params.autoDevice === true;
    this.selection.profileId = params.profileId;
    this.cloudMachines.applyPending(params.profileId, params.machineClass, params.os);
    this.repositoryState.forceWorktree(true);
    this.folderValue = params.cwd ?? "";
    this.freshWorkspaceValue = params.worktreeSource === "empty";
    if (this.freshWorkspaceValue) {
      this.browser.clearProjectSelection();
    }
    if (params.repository) {
      this.browser.selectProject({
        kind: "remote",
        project: { identity: params.repository.url, cloneUrl: params.repository.url },
      });
      this.repositoryState.setBaseRef(params.repository.ref ?? "", false);
      this.repositoryState.load();
    }
    this.callbacks.requestUpdate();
  }

  clearCloudProfile() {
    this.selection.profileId = "";
    this.browser.close();
    this.callbacks.requestUpdate();
  }

  clearProjectSelection() {
    if (this.browser.projectId || this.browser.remoteProject) {
      this.repositoryState.clearDetails(true);
    }
    this.browser.clearProjectSelection();
    this.repositoryState.load();
    this.callbacks.requestUpdate();
  }

  selectAgentId(agentId: string) {
    const snapshot = this.read();
    if (
      snapshot.submitting ||
      snapshot.pendingPlacementSessionKey ||
      catalog.isTarget(snapshot.data)
    ) {
      return;
    }
    if (normalizeAgentId(agentId) === normalizeAgentId(this.agentIdValue)) {
      return;
    }
    this.agentIdValue = normalizeAgentId(agentId);
    this.routeModelIntentActive = false;
    this.modelControl.reset();
    this.callbacks.onError(null);
    this.agentSelectedByUser = true;
    this.browser.clearProjectSelection();
    this.resetPlaceSelection();
    this.browser.close();
    this.adoptAgentDefaults({ preserveSelectedAgent: true });
  }

  applyFolder(folder: string) {
    const snapshot = this.read();
    if (snapshot.submitting || snapshot.pendingPlacementSessionKey) {
      return;
    }
    this.browser.clearProjectSelection();
    this.folderValidation.cancel();
    this.callbacks.onError(null);
    this.folderValue = folder.trim();
    this.freshWorkspaceValue = false;
    this.selection.folderSelected = true;
    this.selection.projectSelected = true;
    this.selection.preferredProject = "";
    if (catalog.isTarget(snapshot.data) && this.terminalOnNode) {
      this.callbacks.requestUpdate();
      return;
    }
    this.repositoryState.selectWorktree(this.remotePlacement);
    if (this.agentsHydratedValue) {
      this.persistPreference({
        folder: this.folderValue,
        projectId: "",
        worktree: this.worktree,
        freshWorkspace: false,
      });
    }
    this.repositoryState.load();
  }

  selectNewWorkspace() {
    const snapshot = this.read();
    if (snapshot.submitting || snapshot.pendingPlacementSessionKey || !this.remotePlacement) {
      return;
    }
    this.folderValidation.cancel();
    this.browser.clearProjectSelection();
    this.browser.resetProjectSearch();
    this.callbacks.onError(null);
    this.folderValue = this.workspacePath();
    this.selection.folderSelected = true;
    this.selection.projectSelected = true;
    this.selection.preferredProject = "";
    this.freshWorkspaceValue = true;
    this.repositoryState.selectWorktree(true);
    this.persistPreference({
      folder: this.folderValue,
      projectId: "",
      worktree: true,
      freshWorkspace: true,
    });
    this.browser.close();
    this.callbacks.requestUpdate();
  }

  selectProjectId(projectId: string) {
    const project = this.browser.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      return;
    }
    this.selectProject({ kind: "local", id: project.id });
  }

  selectRemoteProject(project: DraftRemoteProject) {
    this.selectProject({ kind: "remote", project });
  }

  private selectProject(selection: Parameters<DraftPlaceBrowser["selectProject"]>[0]) {
    const snapshot = this.read();
    if (snapshot.submitting || snapshot.pendingPlacementSessionKey) {
      return;
    }
    this.browser.selectProject(selection);
    this.freshWorkspaceValue = false;
    this.folderValidation.cancel();
    this.browser.resetProjectSearch();
    this.callbacks.onError(null);
    this.selection.folderSelected = false;
    this.selection.projectSelected = true;
    this.selection.preferredProject = "";
    this.repositoryState.selectWorktree(this.remotePlacement);
    if (selection.kind === "local") {
      this.persistPreference({
        projectId: selection.id,
        where: resolveNewSessionWhere({
          cloudProfileId: this.selection.profileId,
          deviceId: this.selection.deviceId,
          autoDevice: this.selection.autoDevice,
        }),
        worktree: this.worktree,
        worktreeName: "",
        freshWorkspace: false,
      });
    }
    this.repositoryState.load();
    this.browser.close();
  }

  selectDevice(deviceId: string, autoDevice = false) {
    const snapshot = this.read();
    if (this.requiredPlacement || snapshot.submitting || snapshot.pendingPlacementSessionKey) {
      return;
    }
    if (
      (deviceId && this.findDevice(deviceId)?.selectable !== true) ||
      (autoDevice && !this.devices().some((device) => device.selectable))
    ) {
      return;
    }
    if (
      deviceId === this.selection.deviceId &&
      autoDevice === this.selection.autoDevice &&
      !this.selection.profileId
    ) {
      return;
    }
    this.folderValidation.cancel();
    this.selection.deviceId = deviceId;
    this.selection.autoDevice = autoDevice;
    this.selection.profileId = "";
    this.selection.whereSelected = true;
    this.selection.preferredWhere = null;
    this.repositoryState.forceWorktree(Boolean(deviceId || autoDevice));
    this.persistPreference({
      where: resolveNewSessionWhere({ cloudProfileId: "", deviceId, autoDevice }),
      projectId: this.browser.projectId,
      folder: this.folderValue,
      worktree: Boolean(deviceId || autoDevice) || this.worktree,
      freshWorkspace: this.freshWorkspaceValue,
    });
    this.browser.close();
    this.repositoryState.synchronize();
    this.callbacks.requestUpdate();
  }

  selectCloudProfile(profileId: string) {
    const snapshot = this.read();
    const profile = this.gateway.cloudProfiles.find((candidate) => candidate.id === profileId);
    if (
      snapshot.submitting ||
      snapshot.pendingPlacementSessionKey ||
      this.requiredPlacement ||
      !this.isAdmin() ||
      !profile ||
      Boolean(this.modelControl.cloudRuntimeUnsupportedReason(profile))
    ) {
      return;
    }
    this.selection.profileId = profileId;
    this.selection.deviceId = "";
    this.selection.autoDevice = false;
    this.selection.whereSelected = true;
    this.selection.preferredWhere = null;
    this.callbacks.onError(null);
    this.repositoryState.forceWorktree(true);
    this.persistPreference({
      where: { kind: "cloud", id: profileId },
      projectId: this.browser.projectId,
      worktree: true,
      freshWorkspace: this.freshWorkspaceValue,
    });
    this.repositoryState.synchronize();
    this.callbacks.requestUpdate();
  }

  selectWorktree(value: boolean) {
    if (value && this.freshWorkspaceValue && !this.remotePlacement && !this.read().submitting) {
      this.freshWorkspaceValue = false;
      this.persistPreference({ freshWorkspace: false });
    }
    this.repositoryState.select(value);
  }

  setBaseRef(baseRef: string) {
    this.repositoryState.setBaseRef(baseRef, this.read().submitting);
  }

  setWorktreeName(worktreeName: string) {
    this.repositoryState.setWorktreeName(worktreeName, this.read().submitting);
  }

  captureSubmittedWorktreeName(
    params: Parameters<DraftRepositoryController["captureSubmittedName"]>[0],
    agentId: string,
    recovered = false,
  ) {
    return this.repositoryState.captureSubmittedName(params, { agentId, recovered });
  }

  restorePreferenceSelections() {
    restoreDraftPlaceSelections(this.selection, {
      read: () => this.read(),
      agentId: () => this.agentId,
      selectedAgent: () => this.selectedAgent(),
      requiredWorkerInference: () => this.requiredWorkerInference,
      requiredPlacement: () => this.requiredPlacement,
      remotePlacement: () => this.remotePlacement,
      isAdmin: () => this.isAdmin(),
      modelControl: this.modelControl,
      browser: this.browser,
      gateway: this.gateway,
      repository: this.repositoryState,
      persistPreference: (patch) => this.persistPreference(patch),
      requestUpdate: () => this.callbacks.requestUpdate(),
    });
  }

  browseAvailable(): boolean {
    return this.gateway.connected && (this.isAdmin() || Boolean(this.workspacePath()));
  }

  worktreeAvailable(): boolean {
    return this.repositoryState.available();
  }

  private persistPreference(patch: Parameters<DraftGatewayState["persistPreference"]>[2]) {
    void this.gateway.persistPreference(this.agentIdValue, this.workspacePath(), patch);
  }

  private restoreWorkspaceFolder() {
    this.callbacks.onClearError(t("newSession.browserLoadFailed"));
    this.folderValue = this.workspacePath();
    this.repositoryState.rejectPreferredWorktree();
    this.persistPreference({ folder: this.folderValue, worktree: false });
    this.repositoryState.load();
  }
}
