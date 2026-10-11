import { createMemo } from "solid-js";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { normalizeAgentTargetLabel } from "../../lib/agents/display.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { liveValue } from "../../lib/reactive/live-value.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import * as catalog from "./catalog-target.ts";
import { resolveCheckoutChip } from "./checkout-chip.ts";
import { CheckoutChip } from "./checkout-chip.tsx";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import {
  environmentPlacementRuntime,
  environmentDeviceDisabledReason,
  environmentCloudDisabledReason,
} from "./hosted-environments.ts";
import "../../components/agent-select-registration.ts";
import { resolveProjectChip } from "./project-chip.ts";
import { ProjectChip } from "./project-chip.tsx";
import type { AgentSelectOptions, NewSessionPlaceControlsOptions } from "./target-controls.ts";
import { NewSessionTerminalHost } from "./terminal-start-view.tsx";
import { resolveWhereChip } from "./where-chip.ts";
import { WhereChip } from "./where-chip.tsx";

registerNewSessionSetupEnglish();

export function AgentSelect(props: { params: AgentSelectOptions }) {
  return (
    <span class="new-session-page__select new-session-page__select--agent">
      <openclaw-agent-select
        prop:variant={props.params.variant ?? "compact"}
        prop:options={props.params.agents.map((agent) => ({
          value: normalizeAgentId(agent.id),
          label: normalizeAgentTargetLabel(agent, props.params.agentIdentity?.get(agent.id)),
          agent,
        }))}
        prop:identityById={Object.fromEntries(
          props.params.agents.flatMap((agent) => {
            const identity = props.params.agentIdentity?.get(agent.id);
            return identity ? [[agent.id, identity]] : [];
          }),
        )}
        prop:value={normalizeAgentId(props.params.agentId)}
        prop:accessibleLabel={t("newSession.agent")}
        prop:menuLabel={t("newSession.agents")}
        prop:disabled={props.params.disabled}
        prop:onSelect={props.params.onSelect}
        onWa-show={() => props.params.onOpenChange(true)}
        onWa-hide={() => props.params.onOpenChange(false)}
      />
    </span>
  );
}

export function RequiredSessionPlacement(props: { gateway: DraftGatewayState }) {
  const profile = () =>
    props.gateway.cloudProfiles.find((candidate) => candidate.id === props.gateway.requiredProfile);
  return (
    <span class="new-session-page__select" role="status" data-required-placement>
      {!props.gateway.placementPolicyReady
        ? t("newSession.placementNotReady")
        : !profile()
          ? t("newSession.requiredWorkerUnavailable")
          : t(
              profile()?.inference === "worker"
                ? "newSession.openClawWorker"
                : "newSession.requiredWorker",
            )}
      {!props.gateway.cloudProfilesPending &&
      (!props.gateway.placementPolicyReady || !profile()) ? (
        <button
          type="button"
          class="btn btn--sm"
          onClick={() => void props.gateway.refreshCloudProfiles()}
        >
          {t("common.retry")}
        </button>
      ) : undefined}
    </span>
  );
}

export function NewSessionPlaceControls(props: { params: NewSessionPlaceControlsOptions }) {
  const folderValue = liveValue(() => props.params.place.folder);
  const view = createMemo(() => {
    const { context, data, gateway, place, submitting, pendingPlacement, requestUpdate } =
      props.params;
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
      hostedEnvironment: place.hostedEnvironment
        ? { ...place.hostedEnvironment, id: place.modelControl.resolveAgentRuntime()!.id }
        : undefined,
      environments: place.canWrite() ? gateway.environments : [],
      cloudProfiles,
      cloudProfileId: place.cloudProfileId,
      machineClass,
      os,
      deviceId: place.deviceId,
      autoDevice: place.autoDevice,
      devicePlacement: environmentPlacementRuntime(place.modelControl)?.devicePlacement,
      deviceDisabledReason:
        environmentDeviceDisabledReason(place.modelControl) ?? gateway.deviceCatalogDisabledReason,
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
      worktreeName: place.worktreeName,
      headBranch: branches?.headBranch,
      baseRef: place.baseRef,
      repository: Boolean(place.remoteRepository),
    });
    const gatewayLabel = gateway.gatewayName
      ? t("newSession.gatewayNamed", { name: gateway.gatewayName })
      : t("newSession.gateway");
    const selectCloudOption = (kind: "os" | "machine", id: string) =>
      place.cloudMachines[kind === "os" ? "selectOs" : "select"](
        place.cloudProfileId,
        id,
        cloudProfiles,
        submitting || pendingPlacement,
        requestUpdate,
      );

    return {
      nativeTerminal,
      browser,
      machineClass,
      os,
      whereState,
      projectState,
      checkoutState,
      projects,
      branches,
      gatewayLabel,
      gatewayName: gateway.gatewayName,
      selectCloudOption,
    };
  });
  return (
    <>
      {!catalog.isTarget(props.params.data) &&
      (!props.params.gateway.placementPolicyReady || props.params.place.requiredPlacement) ? (
        <RequiredSessionPlacement gateway={props.params.gateway} />
      ) : (
        <>
          {view().nativeTerminal ? (
            <NewSessionTerminalHost
              params={{
                hosts: props.params.data?.terminalHosts,
                hostId: props.params.place.terminalHostId,
                submitting: props.params.submitting,
                onSelect: (hostId) => props.params.place.selectTerminalHost(hostId),
              }}
            />
          ) : (
            <WhereChip
              params={{
                hostedEnvironments: props.params.place.modelControl.hostedEnvironments(),
                hostedLoading: props.params.place.modelControl.hostedEnvironmentsLoading(),
                onSelectHostedEnvironment: (id) => props.params.place.selectHostedEnvironment(id),
                hostDisabledReason: props.params.place.modelControl.hostEnvironmentDisabledReason(),
                state: view().whereState,
                environmentQuery: view().browser.environmentQuery,
                onEnvironmentQueryInput: (query) => view().browser.changeEnvironmentQuery(query),
                gatewayName: view().gatewayName,
                cloudProfileId: props.params.place.cloudProfileId,
                machineClass: view().machineClass,
                os: view().os,
                deviceId: props.params.place.deviceId,
                autoDevice: props.params.place.autoDevice,
                autoPlacementMode: props.params.place.modelControl.autoPlacementSelectionMode(
                  environmentPlacementRuntime(props.params.place.modelControl),
                ),
                cloudDisabledReason: environmentCloudDisabledReason(
                  props.params.place.modelControl,
                ),
                cloudProfileDisabledReason: (profile) =>
                  environmentCloudDisabledReason(props.params.place.modelControl, profile),
                submitting: props.params.submitting,
                pendingPlacement: props.params.pendingPlacement,
                catalogLoading:
                  props.params.place.canWrite() && props.params.gateway.cloudProfilesPending,
                isAdmin: props.params.place.isAdmin(),
                ...view().browser.popoverCallbacks("where"),
                onSelectDevice: (deviceId) => props.params.place.selectDevice(deviceId),
                onSelectAutoDevice: () => props.params.place.selectDevice("", true),
                onSelectCloudProfile: (profileId, useDefaults) => {
                  if (useDefaults) {
                    props.params.place.cloudMachines.applyPending(profileId);
                  }
                  props.params.place.selectCloudProfile(profileId);
                },
                onSelectCloudOs: (osId) => view().selectCloudOption("os", osId),
                onSelectCloudMachine: (machineId) => view().selectCloudOption("machine", machineId),
                onConnectMachine: props.params.onConnectMachine,
                onManageCloudWorkers: () => {
                  view().browser.close();
                  props.params.onNavigate("cloud-workers");
                },
              }}
            />
          )}
          {props.params.place.hostedEnvironment ? (
            <span
              class="new-session-page__select new-session-page__hosted-workspace"
              title={t("newSession.hostedHint")}
            >
              {t("newSession.hostedWorkspace")}
            </span>
          ) : view().nativeTerminal && props.params.place.terminalOnNode ? (
            <label class="new-session-page__select new-session-page__menu-field">
              <span>{t("newSession.terminalNodeFolder")}</span>
              <input
                aria-label={t("newSession.terminalNodeFolder")}
                ref={folderValue}
                disabled={props.params.submitting}
                onInput={(event) => props.params.place.applyFolder(event.currentTarget.value)}
              />
            </label>
          ) : (
            <ProjectChip
              params={{
                state: view().projectState,
                browseAvailable: props.params.place.browseAvailable(),
                isAdmin: props.params.place.isAdmin(),
                canWrite: props.params.place.canWrite(),
                folder: props.params.place.folder,
                workspace: props.params.place.workspacePath(),
                projects: view().projects,
                projectQuery: view().browser.projectQuery,
                projectSearchAvailable:
                  !view().nativeTerminal &&
                  canCallGatewayMethod(
                    props.params.context?.gateway.snapshot,
                    "projects.searchRemote",
                    "operator.read",
                  ),
                projectAddAvailable:
                  !view().nativeTerminal &&
                  canCallGatewayMethod(
                    props.params.context?.gateway.snapshot,
                    props.params.place.remotePlacement ? "sessions.create" : "projects.add",
                    "operator.write",
                  ),
                remoteProjects: view().browser.projectSearchResult?.projects ?? [],
                selectedRemoteProject: view().browser.remoteProject,
                projectSearchCredentialMissing:
                  view().browser.projectSearchResult?.credential === "missing",
                projectSearchLoading: view().browser.projectSearchLoading,
                projectSearchError: view().browser.projectSearchError,
                projectId: view().browser.projectId,
                freshWorkspace: props.params.place.freshWorkspace,
                onNewWorkspace: props.params.place.remotePlacement
                  ? () => props.params.place.selectNewWorkspace()
                  : undefined,
                gatewayLabel: view().gatewayLabel,
                submitting: props.params.submitting,
                pendingPlacement: props.params.pendingPlacement,
                ...view().browser.popoverCallbacks("project"),
                browserOpen: view().browser.browserOpen,
                browser: view().browser.browser,
                registerProjectPath: view().browser.browserProjectPath,
                registeringProject: view().browser.browserRegistering,
                onSelectProject: (projectId) => props.params.place.selectProjectId(projectId),
                onProjectQueryInput: (query) => view().browser.changeProjectQuery(query),
                onSelectRemoteProject: (project) => props.params.place.selectRemoteProject(project),
                onApplyFolder: (folder) => props.params.place.applyFolder(folder),
                onBrowse: () =>
                  view().browser.selectGatewayBrowser(
                    props.params.place.folder.trim() || props.params.place.workspacePath(),
                  ),
                onBrowserBack: () => view().browser.showRoot(),
                onRegisterProject: (path) => void view().browser.registerBrowserProject(path),
                onClose: () => view().browser.close(),
              }}
            />
          )}
          {props.params.place.checkoutVisible &&
          !(view().nativeTerminal && props.params.place.terminalOnNode) ? (
            <CheckoutChip
              params={{
                state: view().checkoutState,
                remotePlacement: props.params.place.remotePlacement,
                repository: Boolean(props.params.place.remoteRepository),
                folderLabel: view().projectState.label,
                worktree: props.params.place.worktree,
                worktreeAvailable: props.params.place.worktreeAvailable(),
                repositoryUnavailable: props.params.place.repository.kind === "unavailable",
                branches: view().branches,
                branchesLoading: props.params.place.repository.kind === "checking",
                baseRef: props.params.place.baseRef,
                worktreeName: props.params.place.worktreeName,
                submitting: props.params.submitting,
                pendingPlacement: props.params.pendingPlacement,
                ...view().browser.popoverCallbacks("checkout"),
                onSelectWorktree: (value) => props.params.place.selectWorktree(value),
                onBaseRefInput: (baseRef) => props.params.place.setBaseRef(baseRef),
                onWorktreeNameInput: (worktreeName) =>
                  props.params.place.setWorktreeName(worktreeName),
                onConfirm: props.params.onFocusComposer,
              }}
            />
          ) : undefined}
        </>
      )}{" "}
    </>
  );
}
