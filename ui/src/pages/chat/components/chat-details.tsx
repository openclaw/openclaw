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
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { createResizeObserver } from "../../../lib/reactive/observers.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
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

type Props = {
  props?: ChatDetailsProps;
  elements?: ChatDetailsElements;
  presented: boolean;
  mobile: boolean;
  conversationVisible?: boolean;
  externalTrigger?: boolean;
};
type Methods = { open(source: HTMLElement): void };
export type ChatDetails = SolidBridgeElement<Props, Methods>;
const controls = new WeakMap<HTMLElement, Methods>();
let nextId = 0;

const DETAILS_WIDTH = 352;
// Preserve the 48rem reading column plus its gutters before offering automatic docking.
const DETAILS_DOCK_MIN_WIDTH = 1200;

/** Pane-local adaptive presentation. Data and mutations remain with the pane. */
export const ChatDetails = defineSolidBridge<Props, Methods>(
  "openclaw-chat-details",
  (props, host) => {
    const presentation = createMemo(
      () =>
        [
          props.props?.sessionKey,
          props.props?.currentAgentId,
          props.props?.selectedSession?.sessionId,
          props.props?.gatewayScope,
        ] as const,
      { equals: (before, after) => before.every((value, index) => value === after[index]) },
    );
    const scope = createMemo(() => ({ value: props.props?.gatewayScope }), {
      equals: (before, after) => before.value === after.value,
    });
    // Session replacement resets intent; parking forgets only an explicitly open inspector.
    const [choice, setChoice] = createSignal<{
      presentation: ReturnType<typeof presentation>;
      intent: "auto" | "open" | "closed";
    }>((previous) => {
      const current = presentation();
      const presented = props.presented;
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
    const canDock = () => !props.mobile && props.conversationVisible !== false && wideEnough();
    const opened = () =>
      props.presented && (intent() === "open" || (intent() === "auto" && canDock()));
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
      mobile: props.mobile,
      conversationVisible: props.conversationVisible ?? true,
      externalTrigger: props.externalTrigger ?? false,
      elements: props.elements,
      presentation: presentation(),
    });
    const mountSurface = ({
      mobile,
      conversationVisible,
      elements,
    }: ReturnType<typeof readLayout>) => {
      // Fullscreen panels hide the conversation frame, but not the pane or mobile header.
      const parent = mobile
        ? host
        : conversationVisible
          ? (elements?.frame ?? host)
          : (elements?.pane ?? host);
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
    }: ReturnType<typeof readLayout>) => {
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
        mobile || !conversationVisible
          ? elements?.header?.getBoundingClientRect().bottom
          : undefined;
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
      if (!props.presented) {
        return;
      }
      setIntent("open");
    };
    controls.set(host, {
      open(source) {
        if (!props.presented) {
          return;
        }
        opener = { presentation: presentation(), element: source };
        setIntent("open");
      },
    });
    const outside = (event: Event) => {
      if (
        opened() &&
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
    // Synchronize the native popover and pane geometry with presentation intent.
    createEffect(
      () => [opened(), docked(), readLayout()] as const,
      ([open, dock, layout]) => {
        hide();
        // Let Portal register delegated events before onSettled first mounts the surface.
        // It can later move outside the header’s render root into the pane or frame.
        if (surface.parentElement) {
          mountSurface(layout);
        }
        panel.hidden = !open;
        panel.popover = dock ? null : "manual";
        panel.style.cssText = "";
        panel.classList.toggle("chat-details--docked", dock);
        layout.elements?.frame?.style.setProperty(
          "--chat-details-space",
          dock ? DETAILS_WIDTH + "px" : "0px",
        );
        if (open && !dock) {
          position(layout);
          // Keep native Tab entry beside its header trigger after portaling the content.
          panel.showPopover({
            source: focusSource(layout.mobile, layout.externalTrigger, layout.presentation),
          });
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
        [props.elements?.pane, props.elements?.frame, props.elements?.footer].filter(
          (element): element is HTMLElement => Boolean(element),
        ),
      reposition,
    );
    onSettled(() => {
      reposition();
      const stop = [
        listen(window, "resize", reposition),
        listen(document, "pointerdown", outside),
        listen(document, "keydown", (event) => {
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
        stop.forEach((dispose) => dispose());
      };
    });
    onCleanup(() => {
      controls.delete(host);
      hide();
      props.elements?.frame?.style.removeProperty("--chat-details-space");
      surface.remove();
    });
    return (
      <>
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
            ref={(element) => (panel = element)}
            class="chat-details"
            id={panelId}
            popover="manual"
            role={docked() ? "complementary" : "dialog"}
            aria-label={t("chat.sessionDetails.title")}
          >
            <Show when={props.mobile || props.externalTrigger}>
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
                        props={props.props}
                        presented={props.presented && opened()}
                        dismissed={intent() === "closed"}
                      />
                    </Loading>
                  </Show>
                  <Show when={props.props?.progressCard || props.props?.progressCardInitialLoading}>
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
                      props={props.props}
                      presented={props.presented && opened()}
                    />
                  </Show>
                </>
              )}
            </Show>
          </div>
        </Portal>
      </>
    );
  },
  {
    properties: {
      props: { default: undefined, attribute: false },
      elements: { default: undefined, attribute: false },
      presented: { default: false, type: Boolean },
      mobile: { default: false, type: Boolean, reflect: true },
      conversationVisible: { default: true, type: Boolean },
      externalTrigger: { default: false, type: Boolean },
    },
    methods: { open: (host, source) => controls.get(host)?.open(source) },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-details": ChatDetails;
  }
}
