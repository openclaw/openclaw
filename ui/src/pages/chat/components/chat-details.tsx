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
} from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuHandle } from "../../../components/solid/menu.tsx";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { createResizeObserver } from "../../../lib/reactive/observers.ts";
import type { ChatMobileHost } from "../chat-mobile-host.ts";
import { usePanePresentation } from "../chat-pane-presentation.ts";
import { ChatDetailsProgress } from "./chat-details-progress.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import "../../../styles/chat/details.css";

const ChatDetailsSession = lazy(() => import("./chat-details-session.tsx"), {
  export: "ChatDetailsSession",
});

export type ChatDetailsElements = {
  pane?: HTMLElement;
  header?: HTMLElement;
  frame?: HTMLElement;
  footer?: HTMLElement;
};

export type ChatDetailsViewProps = {
  chat?: ChatDetailsProps;
  elements?: ChatDetailsElements;
  presentation: PresentationValue;
  setRef: (details: ChatDetails | undefined) => void;
  mobile: boolean;
  mobileHost?: ChatMobileHost;
  conversationVisible?: boolean;
  externalTrigger?: boolean;
};
export type ChatDetails = { open(source: HTMLElement): void };
let nextId = 0;

const DETAILS_WIDTH = 352;
// Preserve the 48rem reading column plus its gutters before offering automatic docking.
const DETAILS_DOCK_MIN_WIDTH = 1200;

/** Pane-local adaptive presentation. Data and mutations remain with the pane. */
export function ChatDetails(props: ChatDetailsViewProps) {
  let host!: HTMLElement;
  const isPresented = usePanePresentation(() => props.presentation);
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
  const setIntent = (nextIntent: "auto" | "open" | "closed") =>
    setChoice((previous) => ({ ...previous, intent: nextIntent }));
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
    elements: {
      pane: layoutElements()?.pane,
      header: layoutElements()?.header,
      frame: layoutElements()?.frame,
      footer: layoutElements()?.footer,
    },
    presentation: presentation(),
    mobileHost: Boolean(props.mobileHost),
    detailsMount: props.mobileHost?.detailsMount,
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
  }: ReturnType<typeof readLayout>) => {
    if (mobileHost) {
      return;
    }
    const footerBounds = conversationVisible
      ? elements?.footer?.getBoundingClientRect()
      : undefined;
    const bounds = (
      mobile
        ? (elements?.pane ?? elements?.frame)
        : conversationVisible
          ? elements?.frame
          : (elements?.pane ?? host)
    )?.getBoundingClientRect();
    if (!panel || !bounds) {
      return;
    }
    setWideEnough(bounds.width >= DETAILS_DOCK_MIN_WIDTH);
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
  const close = (restoreFocus = false) => {
    if (props.mobileHost) {
      props.mobileHost.close();
      return;
    }
    hide();
    setIntent("closed");
    if (restoreFocus && host.isConnected) {
      focusSource(props.mobile, props.externalTrigger ?? false)?.focus({ preventScroll: true });
    }
  };
  const toggle = () => {
    if (opened()) {
      close();
      return;
    }
    if (!isPresented()) {
      return;
    }
    setIntent("open");
  };
  const openFrom = (source: HTMLElement) => {
    if (!isPresented()) {
      return;
    }
    opener = { presentation: presentation(), element: source };
    if (props.mobileHost) {
      props.mobileHost.navigate({ area: "details" }, source);
      return;
    }
    setIntent("open");
  };
  const outside = (event: Event) => {
    if (
      opened() &&
      !props.mobileHost &&
      !docked() &&
      !event.composedPath().includes(host) &&
      !event.composedPath().includes(panel)
    ) {
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
      close(true);
    }
  };
  // Unrelated session updates must not retire an open progress menu.
  const layoutState = createMemo(() => ({ open: opened(), dock: docked(), ...readLayout() }), {
    equals: (before, after) =>
      before.open === after.open &&
      before.dock === after.dock &&
      before.mobile === after.mobile &&
      before.conversationVisible === after.conversationVisible &&
      before.externalTrigger === after.externalTrigger &&
      before.elements.pane === after.elements.pane &&
      before.elements.header === after.elements.header &&
      before.elements.frame === after.elements.frame &&
      before.elements.footer === after.elements.footer &&
      before.presentation === after.presentation &&
      before.mobileHost === after.mobileHost &&
      before.detailsMount === after.detailsMount,
  });
  // Synchronize the native popover and pane geometry with presentation intent.
  createEffect(layoutState, ({ open, dock, ...layout }) => {
    hide();
    // Let Portal register delegated events before onSettled first mounts the surface.
    // It can later move outside the header’s render root into the pane or frame.
    if (surface.parentElement) {
      mountSurface(layout);
    }
    panel.hidden = !open;
    panel.popover = dock || layout.mobileHost ? null : "manual";
    panel.style.cssText = "";
    panel.classList.toggle("chat-details--docked", dock);
    layout.elements?.frame?.style.setProperty(
      "--chat-details-space",
      dock ? DETAILS_WIDTH + "px" : "0px",
    );
    if (open && !dock && !layout.mobileHost) {
      position(layout);
      // Keep native Tab entry beside its header trigger after portaling the content.
      panel.showPopover({
        source: focusSource(layout.mobile, layout.externalTrigger, layout.presentation),
      });
    }
  });
  const reposition = () => {
    const layout = readLayout();
    mountSurface(layout);
    position(layout);
  };
  createResizeObserver(
    () =>
      [props.elements?.pane, props.elements?.frame, props.elements?.footer].filter(
        (element): element is HTMLElement => Boolean(element),
      ),
    reposition,
  );
  onSettled(() => {
    props.setRef({ open: openFrom });
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
      stop.forEach((dispose) => dispose());
    };
  });
  onCleanup(() => {
    hide();
    props.elements?.frame?.style.removeProperty("--chat-details-space");
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
        aria-controls={panelId}
        aria-expanded={opened() ? "true" : "false"}
        aria-haspopup={docked() ? undefined : "dialog"}
        onClick={toggle}
      >
        <Icon name="listChecks" />
        <span>{t("chat.sessionDetails.title")}</span>
      </button>
      <Portal mount={surface}>
        <div
          ref={[(element) => (panel = element), elementRef(props.chat?.onScrollPortRef)]}
          class="chat-details"
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
                onClick={() => close(true)}
              >
                <Icon name="x" />
              </button>
            </div>
          </Show>
          <Show when={scope()} keyed>
            {(_scope) => (
              <>
                <Show when={sessionOpened()}>
                  <Loading
                    fallback={
                      <div class="chat-details__muted" role="status">
                        {t("common.loading")}
                      </div>
                    }
                  >
                    <ChatDetailsSession
                      props={props.chat}
                      presented={isPresented() && opened()}
                      dismissed={props.mobileHost ? !props.mobileHost.open : intent() === "closed"}
                    />
                  </Loading>
                </Show>
                <Show when={props.chat?.progressCard || props.chat?.progressCardInitialLoading}>
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
