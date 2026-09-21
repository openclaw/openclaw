import { html, nothing } from "lit";
import type { GatewayAgentRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { normalizeAgentTargetLabel } from "../../lib/agents/display.ts";
import type { AgentIdentityCapability } from "../../lib/agents/identity.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import * as catalog from "./catalog-target.ts";
import { renderCheckoutChip, resolveCheckoutChip } from "./checkout-chip.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { NewSessionRouteData } from "./location.ts";
import "../../components/agent-select-registration.ts";
import { renderProjectChip, resolveProjectChip } from "./project-chip.ts";
import { renderNewSessionTerminalHost } from "./terminal-start.ts";
import { renderWhereChip, resolveWhereChip } from "./where-chip.ts";

registerNewSessionSetupEnglish();

type DraftAgent = GatewayAgentRow;

export function renderAgentSelect(params: {
  agents: DraftAgent[];
  agentId: string;
  agentIdentity?: AgentIdentityCapability;
  disabled: boolean;
  onSelect: (agentId: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const selectedId = normalizeAgentId(params.agentId);
  return html`
    <span class="new-session-page__select new-session-page__select--agent">
      <openclaw-agent-select
        .variant=${"compact"}
        .options=${params.agents.map((agent) => ({
          value: normalizeAgentId(agent.id),
          label: normalizeAgentTargetLabel(agent, params.agentIdentity?.get(agent.id)),
          agent,
        }))}
        .identityById=${Object.fromEntries(
          params.agents.flatMap((agent) => {
            const identity = params.agentIdentity?.get(agent.id);
            return identity ? [[agent.id, identity]] : [];
          }),
        )}
        .value=${selectedId}
        .accessibleLabel=${t("newSession.agent")}
        .menuLabel=${t("newSession.agents")}
        .disabled=${params.disabled}
        .onSelect=${params.onSelect}
        @wa-show=${() => params.onOpenChange(true)}
        @wa-hide=${() => params.onOpenChange(false)}
      ></openclaw-agent-select>
    </span>
  `;
}

export function renderNewSessionPlaceControls({
  idPrefix,
  context,
  data,
  gateway,
  place,
  submitting,
  pendingPlacement,
  onConnectMachine,
  onNavigate,
  onFocusComposer,
  requestUpdate,
}: {
  idPrefix?: string;
  context: ApplicationContext | undefined;
  data: NewSessionRouteData | undefined;
  gateway: DraftGatewayState;
  place: DraftPlaceState;
  submitting: boolean;
  pendingPlacement: boolean;
  onConnectMachine: () => void;
  onNavigate: ApplicationContext["navigate"];
  onFocusComposer: () => void;
  requestUpdate: () => void;
}) {
  const browser = place.browser;
  const { machineClass, os } = place.cloudSelection;
  const nativeTerminal = catalog.isTarget(data);
  const cloudProfiles = nativeTerminal || !place.isAdmin() ? [] : gateway.cloudProfiles;
  const branches = place.repository.kind === "git" ? place.repository : null;
  const projects = nativeTerminal ? [] : browser.projects;
  const recents = nativeTerminal
    ? []
    : browser.resolveProjectRecents({
        sessions: context?.sessions.state.result?.sessions ?? [],
        workspace: place.workspacePath(),
        workspaceRoots: place.knownWorkspaceRoots(),
        isAdmin: place.isAdmin(),
      });
  const whereState = resolveWhereChip({
    environments: place.canWrite() ? gateway.environments : [],
    cloudProfiles,
    cloudProfileId: place.cloudProfileId,
    machineClass,
    os,
    deviceId: place.deviceId,
    autoDevice: place.autoDevice,
    devicePlacement: place.devicePlacementRuntime()?.devicePlacement,
    deviceDisabledReason:
      place.modelControl.devicePlacementUnsupportedReason() ?? gateway.deviceCatalogDisabledReason,
  });
  const projectState = resolveProjectChip({
    folder: place.folder,
    workspace: place.workspacePath(),
    projectId: browser.projectId,
    selectedRemoteProject: browser.remoteProject,
    projects,
    recents,
    projectQuery: browser.projectQuery,
    freshWorkspace: place.freshWorkspace,
  });
  const checkoutState = resolveCheckoutChip({
    destination: place.cloudProfileId ? "cloud" : place.remotePlacement ? "remote" : "local",
    worktree: place.worktree,
    worktreeAvailable: place.worktreeAvailable(),
    headBranch: branches?.headBranch,
    baseRef: place.baseRef,
    repository: Boolean(place.remoteRepository),
  });
  const gatewayLabel = gateway.gatewayName
    ? t("newSession.gatewayNamed", { name: gateway.gatewayName })
    : t("newSession.gateway");
  return html`${
    nativeTerminal
      ? renderNewSessionTerminalHost({
          hosts: data?.terminalHosts,
          hostId: place.terminalHostId,
          submitting,
          onSelect: (hostId) => place.selectTerminalHost(hostId),
        })
      : renderWhereChip({
          idPrefix,
          state: whereState,
          environmentQuery: browser.environmentQuery,
          onEnvironmentQueryInput: (query) => browser.changeEnvironmentQuery(query),
          gatewayName: gateway.gatewayName,
          cloudProfileId: place.cloudProfileId,
          machineClass,
          os,
          deviceId: place.deviceId,
          autoDevice: place.autoDevice,
          autoPlacementMode: place.modelControl.autoPlacementSelectionMode(),
          cloudDisabledReason: place.modelControl.cloudRuntimeUnsupportedReason(),
          cloudProfileDisabledReason: (profile) =>
            place.modelControl.cloudRuntimeUnsupportedReason(profile),
          submitting,
          pendingPlacement,
          catalogLoading: place.canWrite() && gateway.cloudProfilesPending,
          isAdmin: place.isAdmin(),
          ...browser.popoverCallbacks("where"),
          onSelectDevice: (deviceId) => place.selectDevice(deviceId),
          onSelectAutoDevice: () => place.selectDevice("", true),
          onSelectCloudProfile: (profileId, useDefaults) => {
            if (useDefaults) {
              place.cloudMachines.applyPending(profileId);
            }
            place.selectCloudProfile(profileId);
          },
          onSelectCloudOs: (osId) =>
            place.cloudMachines.selectOs(
              place.cloudProfileId,
              osId,
              cloudProfiles,
              submitting || pendingPlacement,
              requestUpdate,
            ),
          onSelectCloudMachine: (machineId) =>
            place.cloudMachines.select(
              place.cloudProfileId,
              machineId,
              cloudProfiles,
              submitting || pendingPlacement,
              requestUpdate,
            ),
          onConnectMachine,
          onManageCloudWorkers: () => {
            browser.close();
            onNavigate("cloud-workers");
          },
        })
  }${
    nativeTerminal && place.terminalOnNode
      ? html`<label class="new-session-page__select new-session-page__menu-field"
          ><span>${t("newSession.terminalNodeFolder")}</span
          ><input
            aria-label=${t("newSession.terminalNodeFolder")}
            .value=${place.folder}
            ?disabled=${submitting}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLInputElement) {
                place.applyFolder(event.currentTarget.value);
              }
            }}
        /></label>`
      : renderProjectChip({
          idPrefix,
          state: projectState,
          browseAvailable: place.browseAvailable(),
          isAdmin: place.isAdmin(),
          canWrite: place.canWrite(),
          folder: place.folder,
          workspace: place.workspacePath(),
          projects,
          projectQuery: browser.projectQuery,
          projectSearchAvailable:
            !nativeTerminal &&
            canCallGatewayMethod(
              context?.gateway.snapshot,
              "projects.searchRemote",
              "operator.read",
            ),
          projectAddAvailable:
            !nativeTerminal &&
            canCallGatewayMethod(
              context?.gateway.snapshot,
              place.remotePlacement ? "sessions.create" : "projects.add",
              "operator.write",
            ),
          remoteProjects: browser.projectSearchResult?.projects ?? [],
          selectedRemoteProject: browser.remoteProject,
          projectSearchCredentialMissing: browser.projectSearchResult?.credential === "missing",
          projectSearchLoading: browser.projectSearchLoading,
          projectSearchError: browser.projectSearchError,
          projectId: browser.projectId,
          freshWorkspace: place.freshWorkspace,
          onNewWorkspace: place.remotePlacement ? () => place.selectNewWorkspace() : undefined,
          gatewayLabel,
          submitting,
          pendingPlacement,
          ...browser.popoverCallbacks("project"),
          browserOpen: browser.browserOpen,
          browser: browser.browser,
          registerProjectPath: browser.browserProjectPath,
          registeringProject: browser.browserRegistering,
          onSelectProject: (projectId) => place.selectProjectId(projectId),
          onProjectQueryInput: (query) => browser.changeProjectQuery(query),
          onSelectRemoteProject: (project) => place.selectRemoteProject(project),
          onApplyFolder: (folder) => place.applyFolder(folder),
          onBrowse: () =>
            browser.selectGatewayBrowser(place.folder.trim() || place.workspacePath()),
          onBrowserBack: () => browser.showRoot(),
          onRegisterProject: (path) => void browser.registerBrowserProject(path),
          onClose: () => browser.close(),
        })
  }${
    checkoutState && !place.freshWorkspace && !(nativeTerminal && place.terminalOnNode)
      ? renderCheckoutChip({
          idPrefix,
          state: checkoutState,
          remotePlacement: place.remotePlacement,
          repository: Boolean(place.remoteRepository),
          folderLabel: projectState.label,
          worktree: place.worktree,
          worktreeAvailable: place.worktreeAvailable(),
          repositoryUnavailable: place.repository.kind === "unavailable",
          branches,
          branchesLoading: place.repository.kind === "checking",
          baseRef: place.baseRef,
          worktreeName: place.worktreeName,
          submitting,
          pendingPlacement,
          ...browser.popoverCallbacks("checkout"),
          onSelectWorktree: (value) => place.selectWorktree(value),
          onBaseRefInput: (baseRef) => place.setBaseRef(baseRef),
          onWorktreeNameInput: (worktreeName) => place.setWorktreeName(worktreeName),
          onConfirm: onFocusComposer,
        })
      : nothing
  }`;
}
