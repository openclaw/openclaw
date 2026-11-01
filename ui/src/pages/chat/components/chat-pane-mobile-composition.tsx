import { dynamic } from "@solidjs/web";
import {
  Errored,
  Loading,
  lazy,
  createMemo,
  createSignal,
  merge,
  onSettled,
  Show,
  type Element,
  type Component,
} from "solid-js";
import { isIncognitoSessionKey } from "../../../../../src/shared/incognito-session-key.js";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../../app/stale-chunk-reload.ts";
import type { SessionPlacementPresentation } from "../../../components/session-placement-move-dialog.tsx";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { closeMenusWithin } from "../../../components/solid/menu.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createMediaQuery } from "../../../lib/reactive/platform.ts";
import type { MobileHostDestination } from "../chat-mobile-host.ts";
import { usePanePresentation } from "../chat-pane-presentation.ts";
import { companionClearAction } from "../chat-panel-header-actions.tsx";
import { chatPaneLayoutModel, ChatPaneLayoutHeaderActions } from "./chat-header-panel-actions.tsx";
import type { HeaderSessionMenuPage } from "./chat-header-session-menu-mobile.tsx";
import { ChatHeaderSessionMenu } from "./chat-header-session-menu.tsx";
import type { ChatPaneHeaderProps } from "./chat-pane-header.types.ts";
import { ChatPaneMobileChrome } from "./chat-pane-mobile-chrome.runtime.tsx";
import {
  createChatMachinePresentation,
  type ChatPanePlacementProps,
} from "./chat-pane-placement.tsx";
import type { HeaderMenuSessionAction } from "./chat-quick-action.tsx";
import { createChatSessionSharingMobileAdapter } from "./chat-session-sharing-mobile-adapter.tsx";
import { ChatSessionSharingOptions } from "./chat-session-sharing-options.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

/** Composition only: destinations and resources remain owned by the pane's native host. */
export function ChatPaneMobileComposition(props: {
  header: ChatPaneHeaderProps;
  project?: Element;
  details: Component<{ placement: ChatPanePlacementProps; onOpenMachine: () => void }>;
  notice: Element;
  fallback: (
    sessionMenu: Element,
    machineName: () => string | undefined,
    details: Element,
  ) => Element;
}) {
  let disposed = false;
  // The destination's first visit mounts its content under this retained header owner.
  const retainPage = (render: () => Element) => {
    const opened = createMemo<boolean>(
      (previous) => previous === true || activePageRender() === page,
    );
    const content = (
      <Show when={opened()}>
        <Errored
          fallback={(error, reset) => (
            <LazyViewError
              error={error()}
              stale={isStaleChunkImportError(error())}
              onRetry={() => {
                if (!isStaleChunkImportError(error())) {
                  reset();
                  return;
                }
                const scopeKey = host()?.scopeKey;
                const destination = host()?.destination;
                void retryStaleChunkReloadWhenReachable({
                  canReload: () => {
                    const current = host();
                    return (
                      !disposed &&
                      current?.open === true &&
                      !current.suspended &&
                      current.scopeKey === scopeKey &&
                      current.destination === destination
                    );
                  },
                });
              }}
              inline
            />
          )}
        >
          <Loading
            fallback={
              <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />
            }
          >
            {render()}
          </Loading>
        </Errored>
      </Show>
    );
    function page() {
      return disposed ? undefined : content;
    }
    return page;
  };
  const ChatMobilePeopleBody = lazy(() => import("./chat-mobile-people.tsx"), {
    export: "ChatMobilePeopleBody",
  });
  const ChatMachine = lazy(() => import("./chat-machine.tsx"), { export: "ChatMachine" });
  const ChatSessionSharingMobile = lazy(() => import("./chat-session-sharing-mobile.tsx"), {
    export: "ChatSessionSharingMobile",
  });
  const ChatSessionAccessMobile = lazy(() => import("./chat-session-sharing-mobile.tsx"), {
    export: "ChatSessionAccessMobile",
  });
  const host = () => props.header.detailsControl?.mobileHost;
  const activePageRender = createMemo(() => host()?.destination.page?.render);
  const mobile = () => Boolean(props.header.mergedChrome && host());
  const compactActions = createMediaQuery("(max-width: 349px)");
  const panePresented = usePanePresentation(() => props.header.presented);
  const presented = () => mobile() && panePresented();
  let chromeRoot: HTMLDivElement | undefined;
  const incognito = () =>
    (props.header.incognito ?? props.header.session?.incognito) ||
    isIncognitoSessionKey(props.header.session?.key);
  const sharing = () => props.header.mobileSharing;
  const emptyPlacement: ChatPanePlacementProps = { session: undefined };
  const readMachineName = createMemo(() => props.header.readMachineName);
  const machineNameRead = createMemo(() => {
    const read = readMachineName();
    // A new request identity starts empty while Solid retires the previous result.
    if (!read) {
      return undefined;
    }
    const name = createMemo(read, { loadingValue: undefined });
    return name;
  });
  const machineName = () => machineNameRead()?.();
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
  const Details = dynamic(() => props.details);
  // The component identity and its DOM stay retained across mobile and desktop placement.
  const details = (
    <Details placement={placement} onOpenMachine={() => host()?.navigate(machinePage)} />
  );
  const machine = createChatMachinePresentation(placement);
  let actionsMenu: HTMLElementTagNameMap["openclaw-chat-header-session-menu"] | undefined;
  const registerActionsMenu = (element: NonNullable<typeof actionsMenu>) => {
    actionsMenu = element;
    return () => {
      if (actionsMenu === element) {
        actionsMenu = undefined;
      }
    };
  };
  const actionSource = () => actionsMenu?.readTrigger();
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
    onOpenSharing: () => {
      const current = host();
      // Sharing opened within People retains the People trigger as its return focus.
      current?.navigate(
        sharingPage,
        current.open && current.destination === people ? undefined : actionSource(),
      );
    },
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
      render: retainPage(() => (
        <div id={peopleId()}>
          <Show when={props.header.mobilePeopleMentions?.status === "loading"}>
            <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />
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
      )),
    },
  };
  // A viewport round-trip parks this page. Only entering/leaving the native
  // destination starts/releases the explicit People lookup, not rendering it.
  const peopleActive = createMemo<boolean>((previous) => {
    const current = host();
    return current ? current.open && current.destination === people : (previous ?? false);
  });
  const sharingPage: MobileHostDestination = {
    area: "details",
    backTo: people,
    page: {
      key: "sharing",
      get title() {
        return t("chat.sessionSharing.sharingOptions");
      },
      render: retainPage(() => <ChatSessionSharingMobile {...adapter.sharing} />),
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
      render: retainPage(() => <ChatSessionAccessMobile {...adapter.access} />),
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
      render: retainPage(() => (
        <ChatMachine
          {...placement}
          onPlacementMove={
            props.header.onMobilePlacementMove ? openMove : placement.onPlacementMove
          }
        />
      )),
    },
  };
  const [moveRequest, setMoveRequest] = createSignal<Parameters<SessionPlacementPresentation>[0]>();
  let moveSessionKey: string | undefined;
  const movePage: MobileHostDestination = {
    area: "details",
    backTo: machinePage,
    page: {
      key: "machine-move",
      get title() {
        return moveRequest()?.title ?? t("sessionsView.moveSessionTitle");
      },
      content: (
        <Show when={moveRequest()} keyed>
          {(request) => request.render()}
        </Show>
      ),
    },
  };
  function openMove() {
    const sessionKey = props.header.session?.key;
    const onPresent: SessionPlacementPresentation = (request) => {
      if (!host() || props.header.session?.key !== sessionKey) {
        request.cancel();
        return () => {};
      }
      moveSessionKey = sessionKey;
      setMoveRequest(request);
      host()?.navigate(movePage);
      return () => {
        setMoveRequest(undefined);
        const current = host();
        if (current?.open && current.destination === movePage) {
          current.navigate(machinePage);
        }
      };
    };
    void props.header.onMobilePlacementMove?.(onPresent);
  }
  const movePresentation = createMemo<{
    request: ReturnType<typeof moveRequest>;
    visited: boolean;
  }>((previous) => {
    const request = moveRequest();
    const current = host();
    return {
      request,
      // Desktop parking retains navigation; only an observed native entry can exit it.
      visited: Boolean(
        request &&
        ((current?.destination === movePage && current.open) ||
          (previous?.request === request && previous.visited)),
      ),
    };
  });
  const cancelledMove = () => {
    const { request, visited } = movePresentation();
    const current = host();
    return request &&
      (props.header.session?.key !== moveSessionKey ||
        (visited && current && (current.destination !== movePage || !current.open)))
      ? request
      : undefined;
  };
  onSettled(() => () => {
    disposed = true;
    moveRequest()?.cancel();
  });
  const layoutProps = merge(
    () => props.header,
    () => ({ mobile: props.header.mergedChrome }),
  );
  const layoutModel = createMemo(() => chatPaneLayoutModel(layoutProps));
  const layoutActions = () => layoutModel().allActions;
  // Desktop View keeps only session-pane closure; panel controls belong to their frames.
  const desktopViewActions = () =>
    layoutModel().actions.filter((action) => action.id === "close-pane");
  const desktopSessionActions = (
    native = props.header.sessionMenuAction?.sessionActions ?? [],
  ): HeaderMenuSessionAction[] => [
    ...native,
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
  const compactHeaderActions = createMemo((): HeaderMenuSessionAction[] =>
    compactActions()
      ? [
          ...(props.header.onOpenDashboard
            ? [
                {
                  id: "header-dashboard",
                  label: t("pluginUi.dashboardTitle"),
                  icon: "layoutDashboard" as const,
                  onActivate: () => {
                    const source = actionSource();
                    if (source) {
                      props.header.onOpenDashboard?.(source);
                    }
                  },
                },
              ]
            : []),
          {
            id: "header-panels",
            label: t("chat.sessionHeader.panels"),
            icon: "sessionPanels" as const,
            onActivate: () => {
              host()?.reveal(actionSource());
            },
          },
        ]
      : [],
  );
  const nativeActions = (native: HeaderMenuSessionAction[]): HeaderMenuSessionAction[] => [
    ...compactHeaderActions(),
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
    ...native,
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
  ];
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
    isCurrent: (page: HeaderSessionMenuPage) => {
      const current = host();
      return Boolean(
        presented() && current?.open && !current.suspended && current.destination.page === page,
      );
    },
  };
  const actionsPageOpen = createMemo(() =>
    Boolean(presented() && host()?.open && host()?.destination.page?.key.startsWith("session-")),
  );
  // One native menu also serves desktop/native-command callers. Its page roots
  // outlive the placement of the trigger in either header.
  const sessionCommandsAvailable = () =>
    !mobile() ||
    !props.header.gatewayStatus?.kind ||
    props.header.gatewayStatus.kind === "connected";
  // Keep the trigger mounted as metadata arrives or the connection changes so keyboard focus survives.
  const sessionMenuAction = () =>
    sessionCommandsAvailable() ? props.header.sessionMenuAction : undefined;
  const sessionMenu = (
    <Show
      when={
        mobile() ||
        props.header.sessionMenuAction ||
        (!props.header.actionsDisabled &&
          (desktopSessionActions().length > 0 || desktopViewActions().length > 0))
      }
    >
      <span>
        <ChatHeaderSessionMenu
          ref={elementRef(registerActionsMenu)}
          {...sessionMenuAction()}
          paneTitle={sessionMenuAction() ? undefined : props.header.title}
          composeSessionActions={(native) =>
            mobile()
              ? sessionCommandsAvailable()
                ? nativeActions(native)
                : compactHeaderActions()
              : desktopSessionActions(native)
          }
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
            } else if (!mobile() && action.kind === "split-right" && props.header.onSplitRight) {
              props.header.onSplitRight(props.header.paneId);
            } else if (!mobile() && action.kind === "split-below" && props.header.onSplitDown) {
              props.header.onSplitDown(props.header.paneId);
            } else {
              const handler = sessionMenuAction()?.onAction;
              return handler ? handler(action) : false;
            }
          }}
          mobile={mobile() || sessionMenuAction()?.mobile}
          mobileHost={mobile() ? menuHost : undefined}
          mobilePageOpen={actionsPageOpen()}
        />
      </span>
    </Show>
  );
  // The first mobile frame needs this header’s height and focus targets.
  // The host retains page JSX across viewport changes. Keep its owner (including
  // the native session menu's page roots) mounted while its chrome is parked.
  const chrome = (
    <ChatPaneMobileChrome
      header={props.header}
      project={props.project}
      details={details}
      notice={props.notice}
      sessionMenu={sessionMenu}
      mobile={mobile()}
      presented={presented()}
      incognito={incognito()}
      compactActions={compactActions()}
      deviceOffline={machine()?.deviceOffline}
      machineName={machineName()}
      peopleControls={peopleId()}
      peopleLabel={labels.people}
      morePeople={labels.morePeople}
      peopleExpanded={Boolean(host()?.open && !host()?.suspended && host()?.destination === people)}
      onChromeRef={(element) => {
        chromeRoot = element;
      }}
      onOpenMachine={(source) => host()?.navigate(machinePage, source)}
      onOpenPeople={(source) => {
        const current = host();
        if (!current) {
          return;
        }
        // Set native expansion before revealing the destination, in the same synchronous intent.
        // A closed host has no visible dock to reserve behind the expanded page.
        if (current.mode !== "expanded") {
          const shell = current.detailsMount?.closest<HTMLElement>(".chat-mobile-host");
          current.toggleExpanded(
            current.open && !current.suspended ? (shell?.getBoundingClientRect().height ?? 0) : 0,
          );
        }
        current.navigate(people, source);
      }}
    />
  );
  return (
    <>
      <Show when={!presented()}>
        {(_parked) => {
          onSettled(() => {
            if (chromeRoot) {
              closeMenusWithin(chromeRoot);
            }
          });
          return undefined;
        }}
      </Show>
      <Show when={peopleActive() ? props.header.mobilePeopleMentions?.activate : undefined} keyed>
        {(activate) => {
          onSettled(activate);
          return undefined;
        }}
      </Show>
      <Show when={cancelledMove()} keyed>
        {(request) => {
          onSettled(() => request.cancel());
          return undefined;
        }}
      </Show>
      {chrome}
      <Show when={!mobile()}>{props.fallback(sessionMenu, machineName, details)}</Show>
    </>
  );
}
