import { createMemo, onSettled } from "solid-js";
import type { AgentSelectElement } from "../../components/agent-select.ts";
import type { PopoverHandle } from "../../components/solid/popover.tsx";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { normalizeAgentTargetLabel } from "../../lib/agents/display.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { liveValue } from "../../lib/reactive/live-value.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import * as catalog from "./catalog-target.ts";
import { resolveCheckoutChip } from "./checkout-chip.ts";
import { CheckoutChip } from "./checkout-chip.tsx";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import "../../components/agent-select-registration.ts";
import { resolveProjectChip } from "./project-chip.ts";
import { ProjectChip } from "./project-chip.tsx";
import type { AgentSelectOptions, NewSessionPlaceControlsOptions } from "./target-controls.ts";
import { NewSessionTerminalHost } from "./terminal-start-view.tsx";
import { draftWhereChipParams, resolveWhereChip } from "./where-chip.ts";
import { WhereChip } from "./where-chip.tsx";

registerNewSessionSetupEnglish();

export function AgentSelect(props: {
  params: AgentSelectOptions;
  ref?: (node: HTMLSpanElement) => void;
  focusTargetsRef?: AgentSelectElement["focusTargetsRef"];
}) {
  return (
    <span class="new-session-page__select new-session-page__select--agent" ref={props.ref}>
      <openclaw-agent-select
        ref={(element) => {
          element.focusTargetsRef = props.focusTargetsRef;
        }}
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
        onOverlay-show={() => props.params.onOpenChange(true)}
        onOverlay-hide={() => props.params.onOpenChange(false)}
      />
    </span>
  );
}

export function RequiredSessionPlacement(props: {
  gateway: DraftGatewayState;
  retryRef?: (button: HTMLButtonElement) => void;
  ref?: (element: HTMLSpanElement) => void;
}) {
  const profile = () =>
    props.gateway.cloudProfiles.find((candidate) => candidate.id === props.gateway.requiredProfile);
  return (
    <span
      class="new-session-page__select"
      role="status"
      data-required-placement
      ref={(element) => props.ref?.(element)}
    >
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
          ref={props.retryRef}
          onClick={() => void props.gateway.retryRequiredPlacement()}
        >
          {t("common.retry")}
        </button>
      ) : undefined}
    </span>
  );
}

export function NewSessionPlaceControls(props: {
  params: NewSessionPlaceControlsOptions;
  ref?: (elements: () => readonly HTMLElement[]) => void;
}) {
  let required: HTMLSpanElement | undefined;
  let terminal: HTMLElement | undefined;
  let where: PopoverHandle | undefined;
  let workspace: HTMLDivElement | undefined;
  let deviceFolder: HTMLLabelElement | undefined;
  onSettled(() => {
    props.ref?.(() =>
      [
        required,
        terminal,
        where?.overlay.trigger?.parentElement ?? undefined,
        where?.overlay.surface,
        workspace,
        deviceFolder,
      ].filter((element): element is HTMLElement => element?.isConnected === true),
    );
  });
  const folderValue = liveValue(() => props.params.place.folder);
  const deviceFolderValue = liveValue(() => props.params.place.deviceFolder?.path ?? "");
  const view = createMemo(() => {
    const { context, data, gateway, place } = props.params;
    const browser = place.browser;
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
    const whereState = resolveWhereChip(draftWhereChipParams(place, gateway, cloudProfiles));
    const projectState = resolveProjectChip({
      folder: place.deviceFolder?.path ?? place.folder,
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

    return {
      nativeTerminal,
      browser,
      whereState,
      projectState,
      checkoutState,
    };
  });
  return (
    <>
      {props.params.place.requiredPlacement ? (
        <RequiredSessionPlacement
          gateway={props.params.gateway}
          ref={(element) => {
            required = element;
          }}
        />
      ) : (
        <>
          {view().nativeTerminal ? (
            <NewSessionTerminalHost
              ref={(element) => {
                terminal = element;
              }}
              params={{
                hosts: props.params.data?.terminalHosts,
                hostId: props.params.place.terminalHostId,
                submitting: props.params.submitting,
                onSelect: (hostId) => props.params.place.selectTerminalHost(hostId),
              }}
            />
          ) : (
            <WhereChip
              params={props.params}
              state={view().whereState}
              ref={(handle) => {
                where = handle;
              }}
            />
          )}
          <div
            ref={(element) => {
              workspace = element;
            }}
            class={[
              "new-session-page__workspace",
              {
                "new-session-page__workspace--checkout":
                  props.params.place.checkoutVisible &&
                  !(view().nativeTerminal && props.params.place.terminalOnNode),
              },
            ]}
          >
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
                params={props.params}
                state={view().projectState}
                nativeTerminal={view().nativeTerminal}
                focus={view().browser.projectFocus}
              />
            )}
            {props.params.place.checkoutVisible &&
            !(view().nativeTerminal && props.params.place.terminalOnNode) ? (
              <CheckoutChip
                params={props.params}
                state={view().checkoutState}
                folderLabel={view().projectState.label}
              />
            ) : undefined}
          </div>
          {props.params.place.deviceFolder ? (
            <label
              class="new-session-page__select new-session-page__menu-field new-session-page__device-folder"
              ref={(element) => {
                deviceFolder = element;
              }}
            >
              <span>{t("newSession.deviceFolderPath")}</span>
              <input
                aria-label={t("newSession.deviceFolderPath")}
                placeholder={t("newSession.deviceFolderPathPlaceholder")}
                ref={deviceFolderValue}
                disabled={props.params.submitting || props.params.pendingPlacement}
                onInput={(event) =>
                  props.params.place.setDeviceFolderPath(event.currentTarget.value)
                }
              />
              <span class="muted">
                {props.params.place.deviceFolderRuntimeUnsupportedReason ??
                  t("newSession.deviceFolderDescription")}
              </span>
            </label>
          ) : undefined}
        </>
      )}{" "}
    </>
  );
}
