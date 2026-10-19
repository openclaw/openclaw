import {
  createEffect,
  createMemo,
  createSignal,
  merge,
  onCleanup,
  Show,
  untrack,
  type Element,
} from "solid-js";
import { isIncognitoSessionKey } from "../../../../../src/shared/incognito-session-key.js";
import {
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  type ShellNavDrawerToggleDetail,
} from "../../../components/command-palette-contract.ts";
import type { SessionPlacementPresentation } from "../../../components/session-placement-move-dialog.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { closeMenusWithin } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { isSessionTitlePending } from "../../../lib/session-display.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import type { MobileHostDestination } from "../chat-mobile-host.ts";
import { companionClearAction } from "../chat-pane-embedded-view.tsx";
import { ChatHeaderSessionMenu } from "./chat-header-session-menu.tsx";
import { usePanePresentation } from "../chat-pane-presentation.ts";
import { chatPaneLayoutModel, ChatPaneLayoutHeaderActions } from "./chat-header-panel-actions.tsx";
import type { HeaderSessionMenuPage } from "./chat-header-session-menu-mobile.tsx";
import { ChatMachine } from "./chat-machine.tsx";
import { ChatMobilePeopleBody, ChatMobilePeopleGrid } from "./chat-mobile-people.tsx";
import type { ChatPaneHeaderProps } from "./chat-pane-header.tsx";
import { ChatPaneMobileHeader } from "./chat-pane-mobile-header.tsx";
import {
  createChatMachinePresentation,
  type ChatPanePlacementProps,
} from "./chat-pane-placement.tsx";
import type { HeaderMenuSessionAction } from "./chat-quick-action.tsx";
import { createChatSessionSharingMobileAdapter } from "./chat-session-sharing-mobile-adapter.tsx";
import {
  ChatSessionAccessMobile,
  ChatSessionSharingMobile,
  ChatSessionSharingOptions,
} from "./chat-session-sharing-mobile.tsx";
import "./chat-pane-mobile-composition.css";

/** Composition only: destinations and resources remain owned by the pane's native host. */
export function ChatPaneMobileComposition(props: {
  header: ChatPaneHeaderProps;
  project?: Element;
  details: (placement: ChatPanePlacementProps, onOpenMachine: () => void) => Element;
  notice: Element;
  fallback: (
    sessionMenu: Element,
    machineName: () => string | undefined,
    details: Element,
  ) => Element;
}) {
  const host = () => props.header.detailsControl?.mobileHost;
  const mobile = () => Boolean(props.header.mergedChrome && host());
  const panePresented = usePanePresentation(() => props.header.presented);
  const presented = () => mobile() && panePresented();
  let chromeRoot: HTMLDivElement | undefined;
  createEffect(presented, (visible) => {
    if (!visible && chromeRoot) {
      closeMenusWithin(chromeRoot);
    }
  });
  const incognito = () =>
    (props.header.incognito ?? props.header.session?.incognito) ||
    isIncognitoSessionKey(props.header.session?.key);
  const sharing = () => props.header.mobileSharing;
  const emptyPlacement: ChatPanePlacementProps = { session: undefined };
  const [machineName, setMachineName] = createSignal<string>();
  const readMachineName = createMemo(() => props.header.readMachineName);
  createEffect(readMachineName, (read) => {
    let retired = false;
    setMachineName(undefined);
    void read?.().then((name) => {
      if (!retired) {
        setMachineName(name);
      }
    });
    return () => {
      retired = true;
    };
  });
  const placement = merge(
    () => props.header.placementControl ?? emptyPlacement,
    () => ({
      machineName: machineName(),
      onPlacementReclaim: props.header.onMobilePlacementStop
        ? () => {
            void props.header.onMobilePlacementStop?.(machineName());
          }
        : props.header.placementControl?.onPlacementReclaim,
    }),
  );
  // The slot is retained for this mounted pane; its JSX reads live header props.
  const details = untrack(() =>
    props.details(placement, () => untrack(() => host()?.navigate(machinePage))),
  );
  const machine = createChatMachinePresentation(placement);
  let actionsRoot: HTMLSpanElement | undefined;
  const actionSource = () =>
    actionsRoot?.querySelector<HTMLElement>(".chat-header-session-menu__trigger") ?? undefined;
  const peopleId = () => `${props.header.paneId}-mobile-people`;
  const labels = {
    get people() {
      return t("chat.sessionHeader.people");
    },
    get viewingNow() {
      return t("activityFeed.viewingNow");
    },
    get creator() {
      return t("chat.sessionSharing.creator");
    },
    get owner() {
      return t("chat.sessionSharing.owner");
    },
    get participants() {
      return t("chat.sessionHeader.peopleParticipants");
    },
    get mention() {
      return t("chat.sessionHeader.mention");
    },
    mentionPerson: (name: string) => t("chat.sessionHeader.mentionPerson", { name }),
    morePeople: (count: number) => t("chat.sessionHeader.morePeople", { count: String(count) }),
  };
  const adapter = createChatSessionSharingMobileAdapter(sharing, {
    onOpenSharing: () => host()?.navigate(sharingPage, actionSource()),
    onOpenAccess: () => host()?.navigate(accessPage),
    onApplied: () => host()?.navigate(sharingPage),
    accessTarget: () =>
      presented() && host()?.open && !host()?.suspended && host()?.destination === accessPage
        ? accessPage
        : undefined,
  });
  const people: MobileHostDestination = {
    area: "details",
    backTo: { area: "details" },
    page: {
      key: "people",
      get title() {
        return labels.people;
      },
      content: (
        <div id={peopleId()}>
          <Show when={props.header.mobilePeopleMentions?.status === "loading"}>
            <p role="status">{t("common.loading")}</p>
          </Show>
          <Show
            when={
              props.header.mobilePeopleMentions?.status === "error" ||
              props.header.mobilePeopleMentions?.status === "unavailable" ||
              props.header.mobilePeopleMentions?.status === "insert-rejected"
            }
          >
            <p role="alert">
              {props.header.mobilePeopleMentions?.status === "insert-rejected"
                ? t("chat.sessionHeader.mentionRejected")
                : (props.header.mobilePeopleMentions?.error ?? t("chat.mentions.unavailable"))}
              <button
                type="button"
                class="btn btn--ghost"
                onClick={() => void props.header.mobilePeopleMentions?.request()}
              >
                {t("common.retry")}
              </button>
            </p>
          </Show>
          <Show when={props.header.mobilePeopleMentions?.truncated}>
            <p role="status">{t("chat.sessionHeader.mentionsTruncated")}</p>
          </Show>
          <Show when={props.header.mobilePeople}>
            {(data) => (
              <ChatMobilePeopleBody
                people={data()}
                labels={labels}
                onMention={(person) => {
                  if (props.header.mobilePeopleMentions?.insert(person.profileId)) {
                    // Native close restores its source synchronously; the queued
                    // composer focus runs afterwards. Do not add another focus task.
                    host()?.close();
                  }
                }}
                sharingOptions={
                  <Show when={adapter.available}>
                    <ChatSessionSharingOptions {...adapter.options} />
                  </Show>
                }
              />
            )}
          </Show>
        </div>
      ),
    },
  };
  // A viewport round-trip parks this page. Only entering/leaving the native
  // destination starts/releases the explicit People lookup, not rendering it.
  const peopleActive = createMemo<boolean>((previous) => {
    const current = host();
    return current ? current.open && current.destination === people : (previous ?? false);
  });
  createEffect(peopleActive, (active) =>
    active ? untrack(() => props.header.mobilePeopleMentions?.activate()) : undefined,
  );
  const sharingPage: MobileHostDestination = {
    area: "details",
    backTo: people,
    page: {
      key: "sharing",
      get title() {
        return t("chat.sessionSharing.sharingOptions");
      },
      content: <ChatSessionSharingMobile {...adapter.sharing} />,
    },
  };
  const accessPage: MobileHostDestination = {
    area: "details",
    backTo: sharingPage,
    page: {
      key: "sharing-access",
      get title() {
        return t("chat.sessionSharing.sessionAccess");
      },
      content: <ChatSessionAccessMobile {...adapter.access} />,
    },
  };
  const machinePage: MobileHostDestination = {
    area: "details",
    backTo: { area: "details" },
    page: {
      key: "machine",
      get title() {
        return t("sessionsView.placementFactMachine");
      },
      content: (
        <ChatMachine
          {...placement}
          onPlacementMove={
            props.header.onMobilePlacementMove ? openMove : placement.onPlacementMove
          }
        />
      ),
    },
  };
  const [moveRequest, setMoveRequest] = createSignal<Parameters<SessionPlacementPresentation>[0]>();
  let moveSessionKey: string | undefined;
  let moveWasPresented = false;
  const movePage: MobileHostDestination = {
    area: "details",
    backTo: machinePage,
    page: {
      key: "machine-move",
      get title() {
        return moveRequest()?.title ?? t("sessionsView.moveSessionTitle");
      },
      expandable: false,
      content: (
        <Show when={moveRequest()} keyed>
          {(request) => request.render()}
        </Show>
      ),
    },
  };
  function openMove() {
    const sessionKey = props.header.session?.key;
    void props.header.onMobilePlacementMove?.((request) =>
      untrack(() => {
        if (!host() || props.header.session?.key !== sessionKey) {
          request.cancel();
          return () => {};
        }
        moveSessionKey = sessionKey;
        moveWasPresented = false;
        setMoveRequest(request);
        host()?.navigate(movePage);
        return () =>
          untrack(() => {
            setMoveRequest(undefined);
            const current = host();
            if (current?.open && current.destination === movePage) {
              current.navigate(machinePage);
            }
          });
      }),
    );
  }
  createEffect(
    () => [host(), props.header.session?.key, moveRequest()] as const,
    ([current, key, request]) => {
      if (!request) {
        return;
      }
      if (key !== moveSessionKey) {
        request.cancel();
        return;
      }
      // Desktop parking retains navigation. Back/Close on the native host cancels
      // the existing picker request; it is not transfer cancellation.
      if (current?.destination === movePage && current.open) {
        moveWasPresented = true;
      } else if (current && moveWasPresented) {
        request.cancel();
      }
    },
  );
  onCleanup(() => moveRequest()?.cancel());
  const layoutProps = merge(
    () => props.header,
    () => ({ mobile: props.header.mergedChrome }),
  );
  const layoutModel = createMemo(() => chatPaneLayoutModel(layoutProps));
  const layoutActions = () => layoutModel().allActions;
  // Desktop View keeps only session-pane closure; panel controls belong to their frames.
  const desktopViewActions = () =>
    layoutModel().actions.filter((action) => action.id === "close-pane");
  const desktopSessionActions = (): HeaderMenuSessionAction[] => [
    ...(props.header.sessionMenuAction?.sessionActions ?? []),
    ...(!props.header.mergedChrome
      ? layoutModel().actions.flatMap((action) =>
          action.id === "open-split-view" && action.kind !== "status" ? [action] : [],
        )
      : []),
  ];
  const clearSideChat = createMemo(() => {
    const model = layoutModel();
    const source = model.sideHeaderActionView ?? model.mainHeaderActionView;
    return source ? companionClearAction(source) : undefined;
  });
  const nativeActions = createMemo((): HeaderMenuSessionAction[] => [
    ...(clearSideChat() ? [clearSideChat()!] : []),
    ...(props.header.runAction
      ? [
          {
            id: "stop-running-subagent",
            label: t("chat.runControls.stopGenerating"),
            icon: "stop" as const,
            onActivate: () => props.header.runAction?.onAbort(),
          },
        ]
      : []),
    ...(props.header.sessionMenuAction?.sessionActions ?? []),
    ...(machine()?.showPlacementMenu
      ? [
          {
            id: "header-machine",
            label: t("sessionsView.placementFactMachine"),
            icon: "monitor" as const,
            onActivate: () => host()?.navigate(machinePage, actionSource()),
          },
        ]
      : []),
    ...(props.header.agent
      ? [
          {
            id: "header-agent-settings",
            label: t("agentChip.namedSettings", { name: props.header.agent.name }),
            icon: "settings" as const,
            onActivate: () => {
              if (props.header.agent) {
                props.header.onOpenAgentSettings?.(props.header.agent.id);
              }
            },
          },
        ]
      : []),
    ...(adapter.available && (!props.header.mobilePeople?.header.length || incognito())
      ? [
          {
            id: "header-sharing",
            label: t("chat.sessionSharing.sharingOptions"),
            icon: "users" as const,
            onActivate: () => {
              adapter.options.onOpen();
            },
          },
        ]
      : []),
  ]);
  const adaptMenuPage = (page: HeaderSessionMenuPage): MobileHostDestination => ({
    area: "details",
    transient: true,
    page,
    backTo: page.backTo
      ? adaptMenuPage(page.backTo)
      : page.key === "session-advanced"
        ? { area: "details" }
        : undefined,
  });
  const menuHost = {
    open: (page: HeaderSessionMenuPage, source: HTMLElement) =>
      host()?.navigate(adaptMenuPage(page), source),
    close: () => host()?.close(),
  };
  const actionsPageOpen = createMemo(() =>
    Boolean(presented() && host()?.open && host()?.destination.page?.key.startsWith("session-")),
  );
  // One native menu also serves desktop/native-command callers. Its page roots
  // outlive the placement of the trigger in either header.
  const sessionMenu = (
    <Show
      when={
        (mobile()
          ? !props.header.gatewayStatus?.kind || props.header.gatewayStatus.kind === "connected"
          : props.header.gatewayStatus?.kind !== "offline" &&
            props.header.gatewayStatus?.kind !== "reconnecting") &&
        (props.header.sessionMenuAction ||
          (!mobile() &&
            !props.header.actionsDisabled &&
            (desktopSessionActions().length > 0 || desktopViewActions().length > 0)))
      }
    >
      <span
        ref={(element) => {
          actionsRoot = element;
        }}
      >
        <Show
          when={props.header.sessionMenuAction}
          fallback={
            <openclaw-chat-header-session-menu
              prop:paneTitle={props.header.title}
              prop:mobile={false}
              prop:sessionActions={desktopSessionActions()}
              prop:viewActions={desktopViewActions()}
            />
          }
        >
          {(menu) => (
            <ChatHeaderSessionMenu
              {...menu()}
              sessionActions={mobile() ? nativeActions() : desktopSessionActions()}
              viewActions={mobile() ? layoutActions() : desktopViewActions()}
              viewContent={
                mobile() ? (
                  <ChatPaneLayoutHeaderActions
                    model={layoutModel()}
                    omitMain={props.header.panelActionDestinations?.main}
                    omitSide={props.header.panelActionDestinations?.side}
                  />
                ) : undefined
              }
              onAction={(action) => {
                // Session keys can repeat across panes; retain the originating pane identity.
                if (mobile() && action.kind === "move-session") {
                  openMove();
                } else if (
                  !mobile() &&
                  action.kind === "split-right" &&
                  props.header.onSplitRight
                ) {
                  props.header.onSplitRight(props.header.paneId);
                } else if (!mobile() && action.kind === "split-below" && props.header.onSplitDown) {
                  props.header.onSplitDown(props.header.paneId);
                } else {
                  menu().onAction(action);
                }
              }}
              mobile={mobile() || menu().mobile}
              mobileHost={mobile() ? menuHost : undefined}
              mobilePageOpen={actionsPageOpen()}
            />
          )}
        </Show>
      </span>
    </Show>
  );
  // The host retains page JSX across viewport changes. Keep its owner (including
  // the native session menu's page roots) mounted while its chrome is parked.
  const chrome = (
    <ContentPresentation value={presented}>
      <div
        ref={(element) => {
          chromeRoot = element;
        }}
        hidden={!mobile()}
        inert={!presented()}
        aria-hidden={mobile() ? undefined : "true"}
        style={{ display: mobile() ? "contents" : "none" }}
      >
        <ChatPaneMobileHeader
          active={mobile()}
          onHeaderRef={props.header.onHeaderRef}
          title={props.header.title}
          titlePending={
            props.header.titlePending ??
            (!props.header.catalog &&
              isSessionTitlePending(props.header.session?.key ?? "", props.header.session))
          }
          project={props.project}
          publicAccess={props.header.publicAccessIndicator}
          incognito={incognito()}
          navDrawerOpen={props.header.navDrawerOpen ?? false}
          onToggleNavigation={(source) =>
            window.dispatchEvent(
              new CustomEvent<ShellNavDrawerToggleDetail>(SHELL_NAV_DRAWER_TOGGLE_EVENT, {
                detail: { trigger: source },
              }),
            )
          }
          onOpenDetails={(source) => props.header.onOpenDetails?.(source)}
          onOpenPanels={(source) => host()?.reveal(source)}
          panelsOpen={Boolean(host()?.open && !host()?.suspended)}
          navigationIcon={<Icon name="sessionMenu" />}
          panelsIcon={<Icon name="sessionPanels" />}
          onOpenDashboard={props.header.onOpenDashboard}
          notice={
            props.header.gatewayStatus?.kind && props.header.gatewayStatus.kind !== "connected"
              ? {
                  kind: "gateway",
                  status: props.header.gatewayStatus.kind,
                  onRetry: props.header.gatewayStatus.onRetry,
                }
              : machine()?.deviceOffline && machineName()
                ? {
                    kind: "device-offline",
                    deviceName: machineName()!,
                    onOpenMachine: (source) => host()?.navigate(machinePage, source),
                  }
                : undefined
          }
          people={
            <Show when={!incognito() && props.header.mobilePeople?.header.length}>
              <ChatMobilePeopleGrid
                people={props.header.mobilePeople!}
                label={labels.people}
                morePeople={labels.morePeople}
                controls={peopleId()}
                expanded={Boolean(
                  host()?.open && !host()?.suspended && host()?.destination === people,
                )}
                onOpen={(source) => {
                  const current = host();
                  if (!current) {
                    return;
                  }
                  // Set native expansion before revealing the destination, in the same synchronous intent.
                  // A closed host has no visible dock to reserve behind the expanded page.
                  if (current.mode !== "expanded") {
                    const shell = current.detailsMount?.closest<HTMLElement>(".chat-mobile-host");
                    current.toggleExpanded(
                      current.open && !current.suspended
                        ? (shell?.getBoundingClientRect().height ?? 0)
                        : 0,
                    );
                  }
                  current.navigate(people, source);
                }}
              />
            </Show>
          }
          actions={<Show when={mobile()}>{sessionMenu}</Show>}
        />
        <Show when={mobile()}>{details}</Show>
        <Show when={mobile()}>{props.notice}</Show>
      </div>
    </ContentPresentation>
  );
  return (
    <>
      {chrome}
      <Show when={!mobile()}>{props.fallback(sessionMenu, machineName, details)}</Show>
    </>
  );
}
