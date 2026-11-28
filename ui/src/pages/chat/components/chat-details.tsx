import { Portal } from "@solidjs/web";
import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onSettled,
  type Element,
} from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuHandle } from "../../../components/solid/menu.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { createResizeObserver } from "../../../lib/reactive/observers.ts";
import { createDocumentVisibility } from "../../../lib/reactive/platform.ts";
import type { MobileDetailsBindings } from "../chat-details-mobile-host-content.tsx";
import type { ChatMobileHost } from "../chat-mobile-host.ts";
import { usePanePresentation } from "../chat-pane-presentation.ts";
import { DesktopDetailsContent } from "./chat-details-content-presence.ts";
import { ChatDetailsDesktopContent } from "./chat-details-desktop-body.tsx";
import { loadChatDetailsObservers } from "./chat-details-desktop-loader.ts";
import {
  DETAILS_DESKTOP_INLINE_INSET,
  DETAILS_DOCK_MIN_WIDTH,
  DETAILS_WIDTH,
  measureChatDetailsDockingWidth,
  positionChatDetails,
  type ChatDetailsElements,
} from "./chat-details-geometry.ts";
import { ChatDetailsLoading } from "./chat-details-loading.tsx";
import type { DesktopDetailsObservers } from "./chat-details-observers.tsx";
import "../../../styles/chat/details.css";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

const ChatDetailsObservers = lazy(loadChatDetailsObservers, {
  export: "ChatDetailsObservers",
});

const ChatDetailsProgress = lazy(() => import("./chat-details-progress.tsx"), {
  export: "ChatDetailsProgress",
});

const ChatDetailsSession = lazy(() => import("./chat-details-session.tsx"), {
  export: "ChatDetailsSession",
});
const ChatDetailsMobileHostContent = lazy(() => import("../chat-details-mobile-host-content.tsx"), {
  export: "ChatDetailsMobileHostContent",
});

export type ChatDetailsViewProps = {
  chat?: ChatDetailsProps;
  elements?: ChatDetailsElements;
  presentation: PresentationValue;
  dockingLayout?: string;
  setRef: (details: ChatDetails | undefined) => void;
  mobile: boolean;
  nativePresentation?: "desktop" | "mobile";
  mobileHost?: ChatMobileHost;
  mobileBindings?: MobileDetailsBindings;
  contentPending?: boolean;
  conversationVisible?: boolean;
  conversationMain?: boolean;
  externalTrigger?: boolean;
  triggerContent?: Element;
};
export type ChatDetails = { open(source: HTMLElement): void; close(): void };
let nextId = 0;

/** Pane-local adaptive presentation. Data and mutations remain with the pane. */
export function ChatDetails(props: ChatDetailsViewProps) {
  let host!: HTMLElement;
  const isPresented = usePanePresentation(() => props.presentation);
  // Stable layout facts keep chat updates from reopening the inspector's child menu.
  const isMobile = createMemo(() => props.mobile);
  // Details follows main, even when the conversation remains visible in a side panel.
  const isConversationAnchor = createMemo(
    () =>
      props.conversationVisible !== false &&
      (props.nativePresentation !== "desktop" || props.conversationMain !== false),
  );
  const hasExternalTrigger = createMemo(() => props.externalTrigger ?? false);
  const layoutElements = createMemo(() => props.elements);
  const presentation = createMemo(
    () =>
      [
        props.chat?.sessionKey,
        props.chat?.currentAgentId,
        props.chat?.selectedSession?.sessionId,
        props.chat?.gatewayScope,
      ] as const,
    { equals: (before, after) => before.every((value, index) => value === after[index]) },
  );
  const scope = createMemo(() => ({ value: props.chat?.gatewayScope }), {
    equals: (before, after) => before.value === after.value,
  });
  // Session replacement resets intent; parking forgets only an explicitly open inspector.
  const [choice, setChoice] = createSignal<{
    presentation: ReturnType<typeof presentation>;
    intent: "auto" | "open" | "closed";
  }>((previous) => {
    const current = presentation();
    const presented = isPresented();
    return {
      presentation: current,
      intent:
        previous?.presentation === current && (presented || previous.intent !== "open")
          ? previous.intent
          : "auto",
    };
  });
  const intent = () => choice().intent;
  const desktop = () => props.nativePresentation === "desktop" && !isMobile() && !props.mobileHost;
  let manualChange = false;
  let entrancePending = true;
  const setIntent = (nextIntent: "auto" | "open" | "closed", manual = false) => {
    manualChange = manual && (nextIntent === "open") !== opened();
    setChoice((previous) => ({ ...previous, intent: nextIntent }));
  };
  // Seed once; data publications must not replace subsequently measured geometry.
  const [wideEnough, setWideEnough] = createSignal<boolean>(
    (previous) =>
      previous ??
      (props.chat?.cachedDetails?.docking?.layout === props.dockingLayout &&
        props.chat?.cachedDetails?.docking?.wide === true),
  );
  const canDock = (wide = wideEnough()) => !isMobile() && isConversationAnchor() && wide;
  const wantsPanel = () => intent() === "open" || (intent() === "auto" && canDock());
  const [observers, setObservers] = createSignal<DesktopDetailsObservers>();
  const [sections, setSections] = createSignal(0);
  const retainSection = () => {
    setSections((count) => count + 1);
    return () => setSections((count) => count - 1);
  };
  const knownContent = () => {
    const chat = props.chat;
    const environment = !chat?.sessionFactsReady && chat?.cachedDetails?.environment;
    return Boolean(
      chat?.progressCard ||
      chat?.progressCardError === "access-denied" ||
      (chat?.displayPullRequests ?? chat?.pullRequests)?.length ||
      chat?.githubPublication?.result?.status === "published" ||
      (observers()?.hasKnownContent() ??
        (environment
          ? environment.worktree || environment.branch
          : chat?.selectedSession?.worktree || chat?.detailsWorkspace?.branch)),
    );
  };
  const available = () =>
    !desktop() || knownContent() || observers()?.hasContent() || sections() > 0;
  // Discovery stays active when it alone found the current rows.
  const observeDesktop = () => desktop() && isPresented() && (wantsPanel() || !knownContent());
  const visible = createDocumentVisibility();
  const opened = () =>
    available() &&
    isPresented() &&
    (props.mobileHost
      ? (props.mobileHost.open || props.mobileHost.exiting) &&
        !props.mobileHost.suspended &&
        props.mobileHost.destination.area === "details" &&
        (!props.mobileHost.destination.page || Boolean(props.mobileHost.destination.page.details))
      : wantsPanel());
  // Mount cached chrome with the transcript; retain disclosure state while closed.
  const cachedReady = () =>
    props.chat?.cachedDetails?.subagents !== undefined &&
    props.chat.cachedDetails.automations !== undefined;
  const [sessionOpened] = createSignal<boolean>(
    (previous) =>
      previous ||
      (opened() && (!props.contentPending || cachedReady() || intent() === "open" || !desktop())),
  );
  const [discoveryAdmitted, setDiscoveryAdmitted] = createSignal<boolean>(
    (previous) =>
      previous ||
      (desktop() &&
        (sessionOpened() ||
          (isPresented() && wantsPanel() && props.chat?.cachedDetails !== undefined))),
  );
  const docked = () => opened() && canDock();
  const surface = document.createElement("div");
  surface.style.display = "contents";
  const panelId = `chat-details-${++nextId}`;
  let panel!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  let opener: { presentation: ReturnType<typeof presentation>; element: HTMLElement } | undefined;
  const focusSource = (
    mobile: boolean,
    externalTrigger: boolean,
    currentPresentation = presentation(),
  ) =>
    mobile || externalTrigger
      ? opener?.presentation === currentPresentation
        ? opener.element
        : undefined
      : trigger;
  let progressMenu: MenuHandle | undefined;
  // Native placement and the presentation effect use the same snapshot.
  const isDesktopWaitingForDetails = () =>
    desktop() && isPresented() && !props.contentPending && wantsPanel() && !available();
  const readLayout = () =>
    [
      presentation(),
      opened(),
      docked(),
      isMobile(),
      isConversationAnchor(),
      hasExternalTrigger(),
      Boolean(props.mobileHost),
      props.mobileHost?.detailsMount,
      desktop(),
      isPresented(),
      layoutElements(),
      props.chat?.connected,
      sessionOpened(),
      // A settled, empty column can gain or lose content while this same pane is on screen.
      isDesktopWaitingForDetails(),
      available(),
    ] as const;
  const mountSurface = (layout: ReturnType<typeof readLayout>) => {
    const mobile = layout[3];
    const conversationVisible = layout[4];
    const detailsMount = layout[7];
    const elements = layout[10];
    // Fullscreen panels hide the conversation frame, but not the pane or mobile header.
    const parent =
      detailsMount ??
      (mobile ? host : conversationVisible ? (elements?.frame ?? host) : (elements?.pane ?? host));
    if (surface.parentElement !== parent) {
      if (surface.parentElement) {
        hide();
      }
      parent.append(surface);
    }
  };
  const position = (layout: ReturnType<typeof readLayout>) => {
    const [
      currentPresentation,
      open,
      ,
      mobile,
      conversationVisible,
      externalTrigger,
      mobileHost,
      ,
      isDesktop,
      presented,
      elements,
    ] = layout;
    if (mobileHost) {
      return;
    }
    const { pane, frame } = elements ?? {};
    const bounds = (
      mobile ? (pane ?? frame) : conversationVisible ? frame : (pane ?? host)
    )?.getBoundingClientRect();
    if (!panel || !bounds) {
      return;
    }
    const dockingWidth = measureChatDetailsDockingWidth(bounds, isDesktop, pane, frame);
    if (isDesktop) {
      frame?.style.setProperty("--chat-details-frame-width", `${dockingWidth}px`);
    }
    const wide = dockingWidth >= DETAILS_DOCK_MIN_WIDTH;
    // A visible narrow pane has already settled; a later resize is not its entrance.
    if (presented && dockingWidth > 0 && !wide) {
      entrancePending = false;
    }
    setWideEnough(wide);
    if (isDesktop && props.dockingLayout) {
      // Hidden conversation widths must not prewarm a closed destination.
      props.chat?.onDetailsSnapshot?.({
        docking: { layout: props.dockingLayout, wide: canDock(wide) },
      });
    }
    if (!open) {
      return;
    }
    const footerBounds = conversationVisible
      ? elements?.footer?.getBoundingClientRect()
      : undefined;
    positionChatDetails(
      panel,
      bounds,
      isDesktop,
      mobile,
      conversationVisible,
      elements,
      footerBounds,
      docked,
      () => focusSource(mobile, externalTrigger, currentPresentation),
    );
  };
  const hide = () => {
    progressMenu?.overlay.request(false);
    if (panel?.matches(":popover-open")) {
      panel.hidePopover?.();
    }
  };
  const close = (restoreFocus = false, manual = false) => {
    if (props.mobileHost) {
      props.mobileHost.close();
      return;
    }
    hide();
    setIntent("closed", manual);
    if (restoreFocus && host.isConnected) {
      focusSource(props.mobile, props.externalTrigger ?? false)?.focus({ preventScroll: true });
    }
  };
  const toggle = (event: MouseEvent) => {
    panel.toggleAttribute("data-instant", event.detail === 0);
    if (opened()) {
      close(false, true);
      return;
    }
    if (!isPresented()) {
      return;
    }
    setIntent("open", true);
  };
  const openFrom = (source: HTMLElement) => {
    if (!isPresented()) {
      return;
    }
    opener = { presentation: presentation(), element: source };
    panel.toggleAttribute("data-instant", source.matches(":focus-visible"));
    if (props.mobileHost) {
      props.mobileHost.navigate({ area: "details" }, source);
      return;
    }
    setIntent("open", true);
  };
  let detailsFocus: ReturnType<typeof presentation> | undefined;
  const ownsEvent = (event: Event) => {
    const path = event.composedPath();
    return path.includes(host) || path.includes(panel);
  };
  const outside = (event: Event) => {
    if (!ownsEvent(event)) {
      detailsFocus = undefined;
      if (opened() && !props.mobileHost && !docked()) {
        panel.removeAttribute("data-instant");
        close();
      }
    }
  };
  const escape = (event: KeyboardEvent) => {
    if (
      event.key === "Escape" &&
      opened() &&
      (!docked() || panel.contains(document.activeElement)) &&
      !event.defaultPrevented &&
      !progressMenu?.overlay.open
    ) {
      event.preventDefault();
      panel.setAttribute("data-instant", "");
      close(true, true);
    }
  };
  // Synchronize the native popover and pane geometry with presentation intent.
  const surfacePresentation = createMemo(readLayout, {
    equals: (before, after) => before.every((value, index) => value === after[index]),
  });
  createEffect(surfacePresentation, (layout, previous) => {
    const [
      identity,
      open,
      dock,
      mobile,
      conversationVisible,
      externalTrigger,
      mobileHost,
      ,
      isDesktop,
      presented,
      elements,
      ,
      contentOpened,
    ] = layout;
    const frame = elements?.frame;
    // A cached panel restores its geometry even while its content is loading.
    const manual =
      manualChange &&
      previous &&
      identity === previous[0] &&
      presented === previous[9] &&
      open !== previous[1];
    manualChange = false;
    const samePane = previous && identity === previous[0] && presented && previous[9];
    const liveArrival = samePane && open && previous[13];
    const liveRemoval = samePane && previous[1] && layout[13];
    const arriving = open && (liveArrival || (entrancePending && !props.chat?.cachedDetails));
    if (open && contentOpened) {
      entrancePending = false;
    }
    panel.toggleAttribute("data-restoring", isDesktop && !manual && !arriving);
    if (
      !open ||
      (previous &&
        (identity !== previous[0] ||
          dock !== previous[2] ||
          mobile !== previous[3] ||
          mobileHost !== previous[6]))
    ) {
      hide();
    }
    // Let Portal register delegated events before onSettled first mounts the surface.
    // It can later move outside the header’s render root into the pane or frame.
    if (surface.parentElement) {
      mountSurface(layout);
    }
    panel.hidden = !open;
    if (!layout[14] && previous?.[14] && presented && detailsFocus === identity) {
      detailsFocus = undefined;
      elements?.focusComposer?.();
    }
    // Preserve the last placement through the discrete exit transition.
    // Removing the dock class/geometry here would teleport a closing column.
    if (open || !isDesktop) {
      // Only the conversation-frame path slides behind side panels. Without
      // that frame, preserve the pane-level popover above the visible tools.
      panel.popover = (isDesktop && conversationVisible) || dock || mobileHost ? null : "manual";
      panel.style.cssText = "";
      panel.classList.toggle("chat-details--docked", dock);
    }
    panel.toggleAttribute("data-open", open);
    frame?.toggleAttribute("data-details-instant", panel.hasAttribute("data-instant"));
    // The last row is already gone: animate the gutter, not an empty panel shell.
    frame?.toggleAttribute(
      "data-details-restoring",
      panel.hasAttribute("data-restoring") && !liveRemoval,
    );
    frame?.style.setProperty(
      "--chat-details-space",
      dock ? `${DETAILS_WIDTH + (isDesktop ? DETAILS_DESKTOP_INLINE_INSET : 0)}px` : "0px",
    );
    if (open && (isDesktop || (!dock && !mobileHost))) {
      position(layout);
    }
    if (open && (!isDesktop || !conversationVisible) && !dock && !mobileHost) {
      // Keep native Tab entry beside its header trigger after portaling the content.
      if (!panel.matches(":popover-open")) {
        panel.showPopover({
          source: focusSource(mobile, externalTrigger, identity),
        });
      }
    }
  });
  const reposition = () => {
    const layout = readLayout();
    mountSurface(layout);
    position(layout);
  };
  // Parent snapshots may change while these native observation targets stay the same.
  const resizeTargets = createMemo(
    () =>
      [
        props.elements?.pane,
        props.elements?.header,
        props.elements?.frame,
        props.elements?.footer,
        props.elements?.getComposerInput?.(),
      ].filter((element): element is HTMLElement => Boolean(element)),
    {
      lazy: true,
      equals: (before, after) =>
        before.length === after.length &&
        before.every((element, index) => element === after[index]),
    },
  );
  createResizeObserver(resizeTargets, reposition);
  onSettled(() => {
    props.setRef({ open: openFrom, close: () => close(true) });
    const pane = layoutElements()?.pane;
    // The pane publishes target geometry in its class/style before CSS starts
    // interpolating. ResizeObserver remains responsible for actual placement.
    const layout = new MutationObserver(reposition);
    if (pane && desktop()) {
      layout.observe(pane, { attributes: true, attributeFilter: ["class", "style"] });
    }
    const initialLayout = readLayout();
    mountSurface(initialLayout);
    // Open surfaces already measured in the presentation effect. Closed ones
    // still need their destination width before the first resize delivery.
    if (!initialLayout[1]) {
      position(initialLayout);
    }
    const stop = [
      listen(window, "resize", reposition),
      listen(document, "pointerdown", outside),
      listen(document, "focusin", (event) => {
        detailsFocus = ownsEvent(event) ? presentation() : undefined;
      }),
      // Child overlays consume Escape before the inspector.
      listen(window, "keydown", (event) => {
        if (event instanceof KeyboardEvent) {
          escape(event);
        }
      }),
      ...(window.visualViewport
        ? [
            listen(window.visualViewport, "resize", reposition),
            listen(window.visualViewport, "scroll", reposition),
          ]
        : []),
    ];
    return () => {
      props.setRef(undefined);
      layout.disconnect();
      stop.forEach((dispose) => dispose());
      hide();
      const frame = props.elements?.frame;
      frame?.style.removeProperty("--chat-details-space");
      frame?.style.removeProperty("--chat-details-frame-width");
      frame?.removeAttribute("data-details-instant");
      frame?.removeAttribute("data-details-restoring");
      surface.remove();
    };
  });
  const hideProgress = () => {
    // The top-layer inspector must not cover the Undo toast.
    if (!docked()) {
      close(true);
    }
  };
  function SessionContent(content: { children: Element }) {
    return (
      <Show when={sessionOpened()}>
        <ChatLazyBoundary fallback={!cachedReady() && <ChatDetailsLoading />}>
          {content.children}
        </ChatLazyBoundary>
      </Show>
    );
  }
  return (
    <openclaw-chat-details
      ref={(element) => (host = element)}
      mobile={props.mobile ? "" : undefined}
      hidden={!available()}
    >
      {/* An open panel can use its cache immediately; unknown closed sessions discover off the chat boot path. */}
      <Show
        when={visible() && observeDesktop() && !props.contentPending && !discoveryAdmitted()}
        keyed
      >
        {(_admitted) => {
          onSettled(() => {
            const start = () => {
              if (observeDesktop()) {
                setDiscoveryAdmitted(true);
              }
            };
            if (typeof requestIdleCallback === "function") {
              const id = requestIdleCallback(start);
              return () => cancelIdleCallback(id);
            }
            const timer = setTimeout(start, 1500);
            return () => clearTimeout(timer);
          });
          return null;
        }}
      </Show>
      <Show when={discoveryAdmitted()}>
        <ChatLazyBoundary>
          <ChatDetailsObservers
            chat={props.chat}
            observing={observeDesktop()}
            visible={visible()}
            host={() => host}
            onReady={setObservers}
          />
        </ChatLazyBoundary>
      </Show>
      <button
        ref={(element) => (trigger = element)}
        class="chat-details-toggle"
        hidden={props.mobile || props.externalTrigger || !available()}
        type="button"
        aria-label={t("chat.sessionDetails.title")}
        title={props.triggerContent ? t("chat.sessionDetails.title") : undefined}
        aria-controls={panelId}
        aria-expanded={opened() ? "true" : "false"}
        aria-haspopup={docked() ? undefined : "dialog"}
        onClick={toggle}
      >
        <Show
          when={props.triggerContent}
          fallback={
            <>
              <Icon name="listChecks" />
              <span>{t("chat.sessionDetails.title")}</span>
            </>
          }
        >
          {props.triggerContent}
        </Show>
      </button>
      <Portal mount={surface}>
        <div
          ref={[(element) => (panel = element), elementRef(props.chat?.onScrollPortRef)]}
          class="chat-details"
          tabindex={-1}
          data-desktop={desktop() ? "" : undefined}
          data-awaiting-content={desktop() && !sessionOpened() ? "" : undefined}
          inert={desktop() && !opened()}
          id={panelId}
          popover="manual"
          role={docked() ? "complementary" : "dialog"}
          aria-label={t("chat.sessionDetails.title")}
        >
          <Show when={!props.mobileHost && (props.mobile || props.externalTrigger)}>
            <div class="chat-details__toolbar">
              <span>{t("chat.sessionDetails.title")}</span>
              <button
                type="button"
                aria-label={t("chat.sessionDetails.close")}
                onClick={() => close(true, true)}
              >
                <Icon name="x" />
              </button>
            </div>
          </Show>
          <Show when={scope()} keyed>
            {(_scope) => (
              <Show
                when={props.nativePresentation === "desktop"}
                fallback={
                  <Show
                    when={props.mobileHost && props.chat}
                    fallback={
                      <>
                        <SessionContent>
                          <ChatDetailsSession
                            props={props.chat}
                            presented={isPresented() && opened()}
                            dismissed={
                              props.mobileHost ? !props.mobileHost.open : intent() === "closed"
                            }
                          />
                        </SessionContent>
                        <Show
                          when={props.chat?.progressCard || props.chat?.progressCardInitialLoading}
                        >
                          <ChatLazyBoundary>
                            <ChatDetailsProgress
                              onHideProgress={hideProgress}
                              menuRef={(menu) => {
                                progressMenu = menu;
                              }}
                              props={props.chat}
                              presented={isPresented() && opened()}
                            />
                          </ChatLazyBoundary>
                        </Show>
                      </>
                    }
                  >
                    <Show when={presentation()} keyed>
                      {(_identity) => (
                        <SessionContent>
                          <ChatDetailsMobileHostContent
                            details={props.chat!}
                            host={props.mobileHost!}
                            bindings={props.mobileBindings}
                            presented={isPresented() && opened()}
                          />
                        </SessionContent>
                      )}
                    </Show>
                  </Show>
                }
              >
                <Show when={sessionOpened()}>
                  <DesktopDetailsContent value={retainSection}>
                    <ChatDetailsDesktopContent
                      observers={observers}
                      observing={observeDesktop()}
                      chat={props.chat}
                      presented={isPresented() && opened()}
                      dismissed={intent() === "closed"}
                      cachedReady={cachedReady()}
                      progressMenuRef={(menu) => {
                        progressMenu = menu;
                      }}
                      onHideProgress={hideProgress}
                    />
                  </DesktopDetailsContent>
                </Show>
              </Show>
            )}
          </Show>
        </div>
      </Portal>
    </openclaw-chat-details>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-details": HTMLAttributes<HTMLElement> & { mobile?: string };
    }
  }
}
