import { Portal } from "@solidjs/web";
import {
  Loading,
  Show,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onSettled,
  type Element,
} from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuHandle } from "../../../components/solid/menu.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { createResizeObserver } from "../../../lib/reactive/observers.ts";
import type { MobileDetailsBindings } from "../chat-details-mobile-host-content.tsx";
import type { ChatMobileHost } from "../chat-mobile-host.ts";
import { usePanePresentation } from "../chat-pane-presentation.ts";
import { ChatDetailsProgress } from "./chat-details-progress.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import "../../../styles/chat/details.css";

const ChatDetailsSession = lazy(() => import("./chat-details-session.tsx"), {
  export: "ChatDetailsSession",
});
const ChatDetailsDesktopComposition = lazy(() => import("./chat-details-session.tsx"), {
  export: "ChatDetailsDesktopComposition",
});
const ChatDetailsMobileHostContent = lazy(() => import("../chat-details-mobile-host-content.tsx"), {
  export: "ChatDetailsMobileHostContent",
});

export type ChatDetailsElements = {
  pane?: HTMLElement;
  header?: HTMLElement;
  frame?: HTMLElement;
  footer?: HTMLElement;
  getComposerInput?: () => HTMLElement | null;
};

export type ChatDetailsViewProps = {
  chat?: ChatDetailsProps;
  elements?: ChatDetailsElements;
  presentation: PresentationValue;
  setRef: (details: ChatDetails | undefined) => void;
  mobile: boolean;
  nativePresentation?: "desktop" | "mobile";
  mobileHost?: ChatMobileHost;
  mobileBindings?: MobileDetailsBindings;
  conversationVisible?: boolean;
  externalTrigger?: boolean;
  triggerContent?: Element;
};
export type ChatDetails = { open(source: HTMLElement): void };
let nextId = 0;

const DETAILS_WIDTH = 300;
const DETAILS_DESKTOP_INLINE_INSET = 13;
// Preserve the 48rem reading column plus its gutters before offering automatic docking.
const DETAILS_DOCK_MIN_WIDTH = 1200;

/** Pane-local adaptive presentation. Data and mutations remain with the pane. */
export function ChatDetails(props: ChatDetailsViewProps) {
  let host!: HTMLElement;
  const isPresented = usePanePresentation(() => props.presentation);
  // Stable layout facts keep chat updates from reopening the inspector's child menu.
  const isMobile = createMemo(() => props.mobile);
  const isConversationVisible = createMemo(() => props.conversationVisible !== false);
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
  const setIntent = (nextIntent: "auto" | "open" | "closed", manual = false) => {
    manualChange = manual && (nextIntent === "open") !== opened();
    setChoice((previous) => ({ ...previous, intent: nextIntent }));
  };
  const [wideEnough, setWideEnough] = createSignal(false);
  const canDock = () => !isMobile() && isConversationVisible() && wideEnough();
  const opened = () =>
    isPresented() &&
    (props.mobileHost
      ? props.mobileHost.open &&
        !props.mobileHost.suspended &&
        props.mobileHost.destination.area === "details" &&
        (!props.mobileHost.destination.page || Boolean(props.mobileHost.destination.page.details))
      : intent() === "open" || (intent() === "auto" && canDock()));
  // Load on first presentation, then retain disclosure state while closed.
  const [sessionOpened] = createSignal<boolean>((previous) => previous === true || opened());
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
  const readLayout = () => ({
    mobile: isMobile(),
    conversationVisible: isConversationVisible(),
    externalTrigger: hasExternalTrigger(),
    elements: layoutElements(),
    presentation: presentation(),
    mobileHost: Boolean(props.mobileHost),
    detailsMount: props.mobileHost?.detailsMount,
    isDesktop: desktop(),
    open: opened(),
  });
  const mountSurface = ({
    mobile,
    conversationVisible,
    elements,
    detailsMount,
  }: ReturnType<typeof readLayout>) => {
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
  const position = ({
    mobile,
    conversationVisible,
    externalTrigger,
    elements,
    presentation: currentPresentation,
    mobileHost,
    isDesktop,
    open,
  }: ReturnType<typeof readLayout>) => {
    if (mobileHost) {
      return;
    }
    const pane = elements?.pane;
    const frame = elements?.frame;
    const footerBounds = conversationVisible
      ? elements?.footer?.getBoundingClientRect()
      : undefined;
    const bounds = (
      mobile ? (pane ?? frame) : conversationVisible ? frame : (pane ?? host)
    )?.getBoundingClientRect();
    if (!panel || !bounds) {
      return;
    }
    // Dock against the layout destination, not an intermediate animation frame.
    // Otherwise the inspector releases its column halfway through a side-panel
    // opening and makes the transcript shrink past its destination, then return.
    let dockingWidth = bounds.width;
    if (isDesktop && pane && conversationVisible) {
      const style = getComputedStyle(pane);
      const sideWidth = Number.parseFloat(style.getPropertyValue("--desktop-side-reserve"));
      const dividerWidth = Number.parseFloat(style.getPropertyValue("--desktop-divider-reserve"));
      const conversationIsSide =
        frame?.closest("[data-region]")?.getAttribute("data-region") === "side";
      // The pane uses border-box sizing; route-entry transforms must not
      // become the retained conversation width.
      dockingWidth = Number.parseFloat(style.width);
      if (
        !pane.classList.contains("sidebar-region--bottom") &&
        !pane.classList.contains("sidebar-region--expanded")
      ) {
        dockingWidth = conversationIsSide ? sideWidth : dockingWidth - sideWidth - dividerWidth;
      }
    }
    if (isDesktop) {
      frame?.style.setProperty("--chat-details-frame-width", `${dockingWidth}px`);
    }
    setWideEnough(dockingWidth >= DETAILS_DOCK_MIN_WIDTH);
    if (isDesktop) {
      // Measure the conversation owner, never the moving Details surface. Its
      // reservation changes the composer width, but not this frame's width.
      if (!open) {
        return;
      }
      const composer = conversationVisible
        ? elements?.getComposerInput?.()?.getBoundingClientRect()
        : undefined;
      const viewport = window.visualViewport;
      const headerBottom = !conversationVisible
        ? elements?.header?.getBoundingClientRect().bottom
        : undefined;
      const top = Math.max((headerBottom ?? bounds.top) + 8, (viewport?.offsetTop ?? 0) + 8);
      const bottom = Math.min(
        docked() && composer && composer.height > 0
          ? composer.bottom
          : footerBounds && footerBounds.height > 0
            ? footerBounds.top - 8
            : bounds.bottom - 8,
        bounds.bottom - 8,
        (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 8,
      );
      const right = Math.min(
        bounds.right - DETAILS_DESKTOP_INLINE_INSET,
        (viewport?.offsetLeft ?? 0) +
          (viewport?.width ?? window.innerWidth) -
          DETAILS_DESKTOP_INLINE_INSET,
      );
      const width = Math.max(0, Math.min(DETAILS_WIDTH, right - bounds.left - 8));
      panel.style.left = `${right - width - (conversationVisible ? bounds.left : 0)}px`;
      panel.style.top = `${top - (conversationVisible ? bounds.top : 0)}px`;
      panel.style.width = `${width}px`;
      panel.style.maxHeight = `${Math.max(0, bottom - top)}px`;
      panel.style.height = "auto";
      return;
    }
    if (panel.classList.contains("chat-details--docked")) {
      return;
    }
    const viewport = window.visualViewport;
    // A desktop-open inspector can survive a mobile resize without an opener.
    // Keep the persistent Panels header reachable in that case too.
    const headerBottom =
      mobile || !conversationVisible ? elements?.header?.getBoundingClientRect().bottom : undefined;
    const minimumTop = Math.max((headerBottom ?? bounds.top) + 8, (viewport?.offsetTop ?? 0) + 8);
    const left = Math.max(bounds.left + 8, (viewport?.offsetLeft ?? 0) + 8);
    const right = Math.min(
      bounds.right - 8,
      (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - 8,
    );
    const bottom =
      Math.min(
        footerBounds && footerBounds.height > 0 ? footerBounds.top : bounds.bottom,
        bounds.bottom,
        (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
      ) - 8;
    const triggerBounds = focusSource(
      mobile,
      externalTrigger,
      currentPresentation,
    )?.getBoundingClientRect();
    // The header is already above the frame: keep one gap below the trigger,
    // rather than adding its height to the conversation top a second time.
    const top = Math.max(
      minimumTop,
      Math.min((triggerBounds?.bottom ?? minimumTop) + 6, bottom - 120),
    );
    const width = mobile ? right - left : Math.min(DETAILS_WIDTH, right - left);
    panel.style.left = `${Math.max(left, right - width)}px`;
    panel.style.top = `${top}px`;
    panel.style.width = `${Math.max(0, width)}px`;
    panel.style.maxHeight = `${Math.max(0, bottom - top)}px`;
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
  const outside = (event: Event) => {
    if (
      opened() &&
      !props.mobileHost &&
      !docked() &&
      !event.composedPath().includes(host) &&
      !event.composedPath().includes(panel)
    ) {
      panel.removeAttribute("data-instant");
      close();
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
  const surfacePresentation = createMemo(
    () =>
      [
        presentation(),
        opened(),
        docked(),
        isMobile(),
        isConversationVisible(),
        hasExternalTrigger(),
        Boolean(props.mobileHost),
        props.mobileHost?.detailsMount,
        desktop(),
        isPresented(),
        layoutElements(),
      ] as const,
    { equals: (before, after) => before.every((value, index) => value === after[index]) },
  );
  createEffect(
    surfacePresentation,
    (
      [
        identity,
        open,
        dock,
        mobile,
        conversationVisible,
        externalTrigger,
        mobileHost,
        detailsMount,
        isDesktop,
        presented,
        elements,
      ],
      previous,
    ) => {
      const layout = {
        mobile,
        conversationVisible,
        externalTrigger,
        elements,
        presentation: identity,
        mobileHost,
        detailsMount,
        isDesktop,
        open,
      };
      const frame = elements?.frame;
      // Only a direct open/close gesture enables motion for this transition.
      // Automatic docking and retained presentation always take their final state.
      const manual =
        manualChange &&
        previous &&
        identity === previous[0] &&
        presented === previous[9] &&
        open !== previous[1];
      manualChange = false;
      panel.toggleAttribute("data-restoring", isDesktop && !manual);
      if (
        isDesktop &&
        presented &&
        (!previous || identity !== previous[0] || presented !== previous[9])
      ) {
        position(layout);
      }
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
      frame?.toggleAttribute("data-details-restoring", panel.hasAttribute("data-restoring"));
      frame?.style.setProperty(
        "--chat-details-space",
        dock ? `${DETAILS_WIDTH + (isDesktop ? DETAILS_DESKTOP_INLINE_INSET : 0)}px` : "0px",
      );
      if (open && isDesktop) {
        position(layout);
      }
      if (open && (!isDesktop || !conversationVisible) && !dock && !mobileHost) {
        if (!isDesktop) {
          position(layout);
        }
        // Keep native Tab entry beside its header trigger after portaling the content.
        if (!panel.matches(":popover-open")) {
          panel.showPopover({
            source: focusSource(mobile, externalTrigger, identity),
          });
        }
      }
    },
  );
  const reposition = () => {
    const layout = readLayout();
    mountSurface(layout);
    position(layout);
  };
  createResizeObserver(
    () =>
      [
        props.elements?.pane,
        props.elements?.frame,
        props.elements?.footer,
        props.elements?.getComposerInput?.(),
      ].filter((element): element is HTMLElement => Boolean(element)),
    reposition,
  );
  onSettled(() => {
    props.setRef({ open: openFrom });
    const pane = layoutElements()?.pane;
    // The pane publishes target geometry in its class/style before CSS starts
    // interpolating. ResizeObserver remains responsible for actual placement.
    const layout = new MutationObserver(reposition);
    if (pane && desktop()) {
      layout.observe(pane, { attributes: true, attributeFilter: ["class", "style"] });
    }
    reposition();
    const stop = [
      listen(window, "resize", reposition),
      listen(document, "pointerdown", outside),
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
    };
  });
  onCleanup(() => {
    hide();
    const frame = props.elements?.frame;
    frame?.style.removeProperty("--chat-details-space");
    frame?.style.removeProperty("--chat-details-frame-width");
    frame?.removeAttribute("data-details-instant");
    frame?.removeAttribute("data-details-restoring");
    surface.remove();
  });
  return (
    <openclaw-chat-details
      ref={(element) => (host = element)}
      mobile={props.mobile ? "" : undefined}
    >
      <button
        ref={(element) => (trigger = element)}
        class="chat-details-toggle"
        hidden={props.mobile || props.externalTrigger}
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
          data-desktop={desktop() ? "" : undefined}
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
                        <Show when={sessionOpened()}>
                          <Loading
                            fallback={
                              <PanelLoadingSkeleton
                                variant="file-list"
                                label={t("common.loading")}
                                compact
                              />
                            }
                          >
                            <ChatDetailsSession
                              props={props.chat}
                              presented={isPresented() && opened()}
                              dismissed={
                                props.mobileHost ? !props.mobileHost.open : intent() === "closed"
                              }
                            />
                          </Loading>
                        </Show>
                        <Show
                          when={props.chat?.progressCard || props.chat?.progressCardInitialLoading}
                        >
                          <ChatDetailsProgress
                            onHideProgress={() => {
                              // The top-layer inspector must not cover the Undo toast.
                              if (!docked()) {
                                close(true);
                              }
                            }}
                            menuRef={(menu) => {
                              progressMenu = menu;
                            }}
                            props={props.chat}
                            presented={isPresented() && opened()}
                          />
                        </Show>
                      </>
                    }
                  >
                    <Show when={presentation()} keyed>
                      {(_identity) => (
                        <Show when={sessionOpened()}>
                          <Loading
                            fallback={
                              <PanelLoadingSkeleton
                                variant="file-list"
                                label={t("common.loading")}
                                compact
                              />
                            }
                          >
                            <ChatDetailsMobileHostContent
                              details={props.chat!}
                              host={props.mobileHost!}
                              bindings={props.mobileBindings}
                              presented={isPresented() && opened()}
                            />
                          </Loading>
                        </Show>
                      )}
                    </Show>
                  </Show>
                }
              >
                <Show when={sessionOpened()}>
                  <Loading
                    fallback={
                      <PanelLoadingSkeleton
                        variant="file-list"
                        label={t("common.loading")}
                        compact
                      />
                    }
                  >
                    <ChatDetailsDesktopComposition
                      props={props.chat}
                      presented={isPresented() && opened()}
                      dismissed={intent() === "closed"}
                      progressMenuRef={(menu) => {
                        progressMenu = menu;
                      }}
                      onHideProgress={() => {
                        if (!docked()) {
                          close(true);
                        }
                      }}
                    />
                  </Loading>
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
