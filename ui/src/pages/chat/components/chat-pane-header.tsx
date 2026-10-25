import { Show, createMemo, lazy, merge, onSettled, type Element } from "solid-js";
import { isIncognitoSessionKey } from "../../../../../src/shared/incognito-session-key.js";
import { beginNativeWindowDrag } from "../../../app/native-window-drag.ts";
import { NAV_DRAWER_TOGGLE_REGISTRATION } from "../../../app/navigation-surface.ts";
import { createRouteElementRef } from "../../../app/route-element-ref.ts";
import {
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  type ShellNavDrawerToggleDetail,
} from "../../../components/command-palette-contract.ts";
import { canRetryGatewayStatus } from "../../../components/gateway-status.ts";
import { PersonAvatarLink } from "../../../components/person-activity-link-solid.tsx";
import { personActivityLink } from "../../../components/person-activity-link.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { renderSessionOwnerChip } from "../../../components/solid/session-presentation.tsx";
import { StrokeIcon } from "../../../components/solid/stroke-icon.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import "../../../components/tooltip.ts";
import { redactLoginFailureError } from "../../../lib/connection-hints.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { HoverMarquee } from "../../../lib/solid/hover-marquee.tsx";
import { PaneHeaderPresence, PaneSubagentStop } from "../chat-pane-header-view.tsx";
import { usePanePresentation } from "../chat-pane-presentation.ts";
import { ChatDetails } from "./chat-details.tsx";
import {
  ChatPanelHeaderActions,
  ChatDashboardMenu,
  ChatPaneLayoutMenu,
} from "./chat-header-panel-actions.tsx";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { AgentCrumb, IdentityCrumbs, ProjectCrumb } from "./chat-pane-header-identity.tsx";
import type { ChatPaneHeaderPresentation, ChatPaneHeaderProps } from "./chat-pane-header.types.ts";
import { ChatPaneMobileComposition } from "./chat-pane-mobile-composition.tsx";
import { ChatPanePlacement } from "./chat-pane-placement.tsx";
import { ChatPaneVersionsMenu } from "./chat-pane-versions-menu.tsx";
import { ChatSessionPublicIndicator } from "./chat-session-sharing-shared.tsx";
import { ChatSessionSharing } from "./chat-session-sharing.solid.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

const ContinueInTerminalDialog = lazy(() => import("./continue-in-terminal-dialog.tsx"), {
  export: "ContinueInTerminalDialog",
});

export function PaneHeaderView(props: ChatPaneHeaderPresentation) {
  return (
    <>
      <ChatPaneHeader {...props.header} />
      <Show when={props.continueInTerminal}>
        {(dialog) => (
          <ChatLazyBoundary onClose={() => dialog().onClose()}>
            <ContinueInTerminalDialog {...dialog()} />
          </ChatLazyBoundary>
        )}
      </Show>
    </>
  );
}

function DetailsGlyph() {
  return (
    <StrokeIcon stroke-width="1.6" aria-hidden="true">
      <circle cx="5" cy="7" r="3" />
      <circle cx="5" cy="17" r="3" />
      <path d="M13 7h8M13 17h8" />
    </StrokeIcon>
  );
}

export function ChatPaneHeader(props: ChatPaneHeaderProps) {
  // Pane activation must not replace the pointer target before its click.
  const detailsGlyph = <DetailsGlyph />;
  // One retained picker follows Dashboard between its side and main surfaces.
  // Its facts come directly from this reactive native header projection.
  const dashboardControls = (
    <ChatDashboardMenu
      {...props}
      mobile={props.mergedChrome}
      widgetMenu={props.dashboardWidgetMenu}
    />
  );
  onSettled(() => {
    props.setDashboardControls?.(dashboardControls);
    return () => props.setDashboardControls?.(undefined);
  });
  const incognito = () =>
    (props.incognito ?? props.session?.incognito) || isIncognitoSessionKey(props.session?.key);
  const Details = (detailsProps: {
    placement: Parameters<typeof ChatPanePlacement>[0];
    onOpenMachine: () => void;
  }) => {
    const chat = createMemo(() => {
      const source = props.detailsControl?.chat;
      return source
        ? merge(source, {
            environment: merge(
              () => source.environment ?? {},
              () => ({
                placement: detailsProps.placement,
                onOpenMachine:
                  props.detailsControl?.nativePresentation === "mobile"
                    ? detailsProps.onOpenMachine
                    : undefined,
              }),
            ),
          })
        : undefined;
    });
    return (
      <Show when={props.detailsControl !== undefined}>
        <ChatDetails
          {...props.detailsControl!}
          chat={chat()}
          triggerContent={!props.mergedChrome ? detailsGlyph : undefined}
          mobileBindings={
            props.detailsControl?.mobileBindings
              ? {
                  ...props.detailsControl.mobileBindings,
                  versions: props.mobileVersions,
                }
              : undefined
          }
        />
      </Show>
    );
  };
  const notice = (
    <Show when={incognito()}>
      <aside class="chat-pane__incognito-notice" aria-label={t("sessionsView.incognitoLabel")}>
        <span class="chat-pane__incognito-notice-icon" aria-hidden="true">
          <Icon name="incognito" />
        </span>
        <div>
          <p>{t("sessionsView.incognitoDescription")}</p>
          <p class="chat-pane__incognito-limits">{t("sessionsView.incognitoLimits")}</p>
        </div>
      </aside>
    </Show>
  );
  return (
    <ChatPaneMobileComposition
      header={props}
      details={Details}
      notice={notice}
      fallback={(sessionMenu, machineName, mountedDetails) => (
        <ChatPaneHeaderChrome
          {...props}
          details={mountedDetails}
          notice={notice}
          sessionMenu={sessionMenu}
          machineName={machineName()}
        />
      )}
      project={!props.catalog && props.workspaceLabel ? <ProjectCrumb {...props} /> : undefined}
    />
  );
}

function ChatPaneHeaderChrome(
  props: ChatPaneHeaderProps & {
    details: Element;
    notice: Element;
    sessionMenu: Element;
    machineName?: string;
  },
) {
  let deviceStatus: HTMLSpanElement | undefined;
  const deviceOffline = () =>
    props.session?.placement?.state === "active" &&
    props.session.placement.runner?.kind === "device" &&
    props.session.placement.runner.status === "offline";
  const drawerLabel = () => (props.navDrawerOpen ? t("nav.collapse") : t("nav.expand"));
  const hasSharingControl = () => props.sharingControl !== undefined;
  const presented = usePanePresentation(() => props.presented);
  const incognito = () =>
    (props.incognito ?? props.session?.incognito) || isIncognitoSessionKey(props.session?.key);

  return (
    <>
      <div
        ref={[elementRef(props.onHeaderRef)]}
        class={[
          "chat-pane__header",
          {
            "chat-pane__header--mobile": props.mergedChrome,
            "chat-pane__header--agent": Boolean(props.agent),
            "chat-pane__header--closable": props.onClosePane !== undefined,
            "chat-pane__header--stacked-status":
              props.narrow &&
              (props.mergedChrome || !props.detailsControl) &&
              (props.runningSubagentCount ?? 0) > 0,
          },
        ]}
        role="group"
        aria-label={props.agent?.name ?? props.title}
        tabindex={-1}
        onMouseDown={beginNativeWindowDrag}
      >
        <div class="chat-pane__header-leading">
          <Show when={props.mergedChrome}>
            {(_mergedChrome) => {
              const drawerRef = createRouteElementRef(NAV_DRAWER_TOGGLE_REGISTRATION);
              return (
                <openclaw-tooltip prop:content={drawerLabel()}>
                  <button
                    ref={drawerRef}
                    class="btn btn--ghost btn--icon chat-icon-btn chat-pane__nav-toggle"
                    type="button"
                    aria-label={drawerLabel()}
                    aria-expanded={props.navDrawerOpen ? "true" : "false"}
                    data-connection-status={props.gatewayStatus?.kind ?? undefined}
                    onClick={(event) => {
                      window.dispatchEvent(
                        new CustomEvent<ShellNavDrawerToggleDetail>(SHELL_NAV_DRAWER_TOGGLE_EVENT, {
                          detail: {
                            trigger: event.currentTarget,
                          },
                        }),
                      );
                    }}
                  >
                    <Icon name="menu" />
                    <Show when={props.gatewayStatus?.kind}>
                      <span class="gateway-status-dot" aria-hidden="true" />
                    </Show>
                  </button>
                </openclaw-tooltip>
              );
            }}
          </Show>
          <Show when={incognito()}>
            <openclaw-tooltip
              prop:content={t("sessionsView.incognitoDescription")}
              placement="bottom"
              prop:openOnClick={true}
            >
              <button type="button" class="chat-pane__incognito">
                <span aria-hidden="true">
                  <Icon name="incognito" />
                </span>
                {t("sessionsView.incognitoLabel")}
              </button>
            </openclaw-tooltip>
          </Show>
          {/* Roster mode has no session crumbs beside the agent pill; rename still edits inline. */}
          <Show when={!props.agent || props.editing}>
            <IdentityCrumbs {...props} />
          </Show>
          <Show when={!props.mergedChrome}>
            <div class="chat-pane__identity-actions">
              <Show
                when={
                  props.gatewayStatus?.kind !== "offline" &&
                  props.gatewayStatus?.kind !== "reconnecting"
                }
              >
                {props.sessionMenu}
                <Show when={presented()}>
                  <ChatPaneVersionsMenu
                    menu={{
                      catalog: props.catalog,
                      branches: props.branches,
                      branchSwitchDisabledReason: props.branchSwitchDisabledReason,
                      onBranchSelect: props.onBranchSelect,
                    }}
                  />
                </Show>
              </Show>
              <Show
                when={
                  props.gatewayStatus?.kind ?? (props.savedConversation ? "reconnecting" : null)
                }
              >
                {(kind) => (
                  <openclaw-tooltip
                    prop:content={
                      props.gatewayStatus?.lastError
                        ? redactLoginFailureError(props.gatewayStatus.lastError)
                        : ""
                    }
                  >
                    <div class="chat-pane__connection">
                      <span class="chat-pane__connection-state" role="status" aria-live="polite">
                        <span
                          class={[
                            "chat-pane__connection-icon",
                            {
                              "chat-pane__connection-icon--busy":
                                kind() !== "offline" &&
                                kind() !== "reload-required" &&
                                kind() !== "suspended" &&
                                kind() !== "suspending",
                            },
                          ]}
                          aria-hidden="true"
                        >
                          <Show
                            when={
                              kind() === "offline" ||
                              kind() === "reload-required" ||
                              kind() === "suspended" ||
                              kind() === "suspending"
                            }
                            fallback={
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.8"
                                stroke-linecap="round"
                              >
                                <circle cx="12" cy="12" r="9" opacity="0.25" />
                                <path d="M12 3a9 9 0 0 1 9 9" />
                              </svg>
                            }
                          >
                            <Icon
                              name={
                                kind() === "offline" || kind() === "reload-required"
                                  ? "alertTriangle"
                                  : "pause"
                              }
                            />
                          </Show>
                        </span>
                        {props.savedConversation
                          ? t("chat.savedConversation", { status: t(`connection.${kind()}`) })
                          : t(`connection.${kind()}`)}
                      </span>
                      <Show when={canRetryGatewayStatus(kind()) && props.gatewayStatus?.onRetry}>
                        <span class="chat-pane__connection-divider" aria-hidden="true" />
                        <button
                          type="button"
                          class="chat-pane__connection-retry"
                          onClick={() => props.gatewayStatus?.onRetry?.()}
                        >
                          {t("common.retry")}
                        </button>
                      </Show>
                    </div>
                  </openclaw-tooltip>
                )}
              </Show>
              <Show when={!props.gatewayStatus?.kind && deviceOffline() && props.machineName}>
                <span
                  ref={(element) => {
                    deviceStatus = element;
                  }}
                  class="chat-pane__device-offline"
                  role="status"
                  aria-live="polite"
                >
                  <Icon name="monitor" />
                  <HoverMarquee
                    class="chat-pane__device-name"
                    content={props.machineName}
                    options={{ loop: true, host: () => deviceStatus }}
                  />
                  <span aria-hidden="true">·</span>
                  <span>{t("sessionsView.machineOffline")}</span>
                </span>
              </Show>
            </div>
          </Show>
          <Show when={props.publicAccessIndicator}>
            {(indicator) => <ChatSessionPublicIndicator {...indicator()} />}
          </Show>
          {props.mergedChrome || props.detailsControl || hasSharingControl() ? undefined : (
            <PersonAvatarLink
              standalone
              link={
                props.showOwnerChip
                  ? personActivityLink(
                      props.session?.owner?.actor.identity?.type === "profile"
                        ? props.session.owner.actor.identity.id
                        : undefined,
                      props.personActivity,
                      props.session?.owner?.actor.label,
                    )
                  : null
              }
            >
              {renderSessionOwnerChip(
                props.showOwnerChip ? props.session?.owner?.actor : undefined,
                "header",
                props.session?.owner?.assignedAt !== undefined ? "owned" : "created",
                props.ownerViewing,
              )}
            </PersonAvatarLink>
          )}
          {!props.mergedChrome &&
          !props.detailsControl &&
          props.showOwnerChip &&
          props.session?.participants?.length ? (
            <openclaw-viewer-facepile
              class="chat-pane__participants"
              prop:staticParticipants={props.session.participants}
              prop:totalCount={props.session.participantCount}
              prop:maxVisible={4}
              prop:personActivity={props.personActivity}
            />
          ) : undefined}
          <Show
            when={
              props.detailsControl?.nativePresentation !== "desktop"
                ? props.placementControl
                : undefined
            }
          >
            {(placement) => <ChatPanePlacement {...placement()} />}
          </Show>
        </div>
        <Show when={props.agent}>
          {(agent) => (
            <div class="chat-pane__header-agent">
              <AgentCrumb {...props} agent={agent()} />
            </div>
          )}
        </Show>
        <div class="chat-pane__header-trailing">
          <Show when={props.panelActionDestinations?.main}>
            <ChatPanelHeaderActions
              {...props.panelDefinitions?.find(
                (definition) =>
                  definition.slot ===
                  props.sidebarLayout?.columns[0]?.panels.find(
                    (panel) => panel.id === props.sidebarLayout?.mainPanelId,
                  )?.slot,
              )}
            />
          </Show>
          <Show when={props.onToggleConversation}>
            <button
              type="button"
              class="btn btn--ghost chat-pane__chat-toggle"
              aria-pressed={props.conversationVisible ? "true" : "false"}
              title={t(
                props.conversationVisible ? "chat.sidePanel.hideChat" : "chat.sidePanel.showChat",
              )}
              onClick={() => props.onToggleConversation?.()}
            >
              <Icon name="messageSquare" />
              <span>{t("chat.sidePanel.conversation")}</span>
            </button>
          </Show>
          <Show when={props.mergedChrome && presented()}>
            <ChatPaneVersionsMenu
              menu={{
                catalog: props.catalog,
                branches: props.branches,
                branchSwitchDisabledReason: props.branchSwitchDisabledReason,
                onBranchSelect: props.onBranchSelect,
              }}
            />
          </Show>
          <div class="chat-pane__actions">
            <Show when={!props.narrow && (props.mergedChrome || !props.detailsControl)}>
              <RunningSubagents count={props.runningSubagentCount} />
            </Show>
            <Show when={props.runAction}>{(action) => <PaneSubagentStop {...action()} />}</Show>
            <Show when={!props.mergedChrome}>
              <Show when={props.presence}>
                {(presence) => <PaneHeaderPresence {...presence()} />}
              </Show>
            </Show>
            <Show when={props.sharingControl}>
              {(sharing) => <ChatSessionSharing {...sharing()} />}
            </Show>
            {props.details}
            {/* The observed row (and its menu) retires offline; cached Details stays local. */}
            <Show
              when={
                !props.session &&
                (props.mergedChrome || props.detailsControl?.externalTrigger) &&
                props.onOpenDetails
              }
            >
              <button
                type="button"
                class="chat-details-toggle"
                aria-label={t("chat.sessionDetails.title")}
                onClick={(event) => props.onOpenDetails?.(event.currentTarget)}
              >
                <Show
                  when={!props.mergedChrome}
                  fallback={
                    <>
                      <Icon name="listChecks" />
                      <span>{t("chat.sessionDetails.title")}</span>
                    </>
                  }
                >
                  <DetailsGlyph />
                </Show>
              </button>
            </Show>
            <Show when={props.mergedChrome}>{props.sessionMenu}</Show>
            <Show when={props.mergedChrome}>
              <ChatPaneLayoutMenu {...props} mobile />
            </Show>
            <Show
              when={!props.mergedChrome && !props.externalPanelsToggle && props.onToggleSidePanel}
            >
              <openclaw-tooltip prop:content={t("chat.sessionHeader.panels")}>
                <button
                  type="button"
                  class="btn btn--ghost btn--icon chat-icon-btn chat-pane__panels-toggle"
                  aria-label={t("chat.sessionHeader.panels")}
                  aria-expanded={
                    props.sidebarLayout?.open === true && !props.sidebarLayout.expanded
                      ? "true"
                      : "false"
                  }
                  onClick={() => props.onToggleSidePanel?.()}
                >
                  <Icon
                    name={
                      props.sidebarLayout?.open === true && !props.sidebarLayout.expanded
                        ? "sessionPanelsActive"
                        : "sessionPanels"
                    }
                  />
                </button>
              </openclaw-tooltip>
            </Show>
          </div>
          {/* Inactive panes hide session actions, but must keep their close control. */}
          <Show when={!props.mergedChrome && props.onClosePane}>
            <button
              type="button"
              class="btn btn--ghost btn--icon chat-icon-btn chat-pane__close"
              aria-label={t("chat.splitView.closePane")}
              title={t("chat.splitView.closePane")}
              disabled={props.actionsDisabled}
              onClick={() => props.onClosePane?.(props.paneId)}
            >
              <Icon name="x" />
            </button>
          </Show>
        </div>
        <Show when={props.narrow && (props.mergedChrome || !props.detailsControl)}>
          <RunningSubagents count={props.runningSubagentCount} />
        </Show>
      </div>
      {props.notice}
    </>
  );
}

function RunningSubagents(props: { count?: number }) {
  return (
    <Show when={(props.count ?? 0) > 0}>
      <span class="chat-pane__subagents-running">
        <span aria-hidden="true">
          <Icon name="bot" />
        </span>
        {t("chat.sessionHeader.subagentsRunning", { count: String(props.count) })}
      </span>
    </Show>
  );
}
