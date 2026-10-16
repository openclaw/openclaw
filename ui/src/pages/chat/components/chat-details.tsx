import { Portal } from "@solidjs/web";
import { Show, createEffect, createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuHandle } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { ChatDetailsProgress } from "./chat-details-progress.tsx";
import { ChatDetailsSession } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import "../../../styles/chat/details.css";

type Props = { props?: ChatDetailsProps; presented: boolean; mobile: boolean };
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
    const [intent, setIntent] = createSignal<"auto" | "open" | "closed">("auto");
    const [canDock, setCanDock] = createSignal(false);
    const opened = () =>
      props.presented && (intent() === "open" || (intent() === "auto" && canDock()));
    const docked = () => opened() && canDock();
    const surface = document.createElement("div");
    surface.style.display = "contents";
    let frame: HTMLElement | null = null;
    let pane: HTMLElement | null = null;
    const panelId = `chat-details-${++nextId}`;
    let panel!: HTMLDivElement;
    let trigger!: HTMLButtonElement;
    let opener: HTMLElement | undefined;
    const focusSource = (mobile: boolean) => (mobile ? opener : trigger);
    let progressMenu: MenuHandle | undefined;
    const mountSurface = (mobile: boolean) => {
      // The mobile header stays visible when a full-width panel hides the conversation.
      const parent = mobile ? host : (frame ?? host);
      if (surface.parentElement !== parent) {
        parent.append(surface);
      }
    };
    const position = (mobile: boolean) => {
      const footerBounds = frame?.querySelector(".chat-footer")?.getBoundingClientRect();
      const bounds = (mobile ? (pane ?? frame) : frame)?.getBoundingClientRect();
      if (!panel || !bounds) {
        return;
      }
      setCanDock(!mobile && bounds.width >= DETAILS_DOCK_MIN_WIDTH);
      if (panel.classList.contains("chat-details--docked")) {
        return;
      }
      const viewport = window.visualViewport;
      // A desktop-open inspector can survive a mobile resize without an opener.
      // Keep the persistent Panels header reachable in that case too.
      const headerBottom = mobile
        ? pane?.querySelector(".sidebar-region__header")?.getBoundingClientRect().bottom
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
      const triggerBounds = focusSource(mobile)?.getBoundingClientRect();
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
        focusSource(props.mobile)?.focus({ preventScroll: true });
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
        opener = source;
        setIntent("open");
      },
    });
    const outside = (event: PointerEvent) => {
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
    const identity = createMemo(() =>
      JSON.stringify([
        props.props?.sessionKey,
        props.props?.currentAgentId,
        props.props?.selectedSession?.sessionId,
      ]),
    );
    const presentation = createMemo(() => [identity(), props.props?.gatewayScope] as const, {
      equals: (before, after) => before.every((value, index) => value === after[index]),
    });
    const scope = createMemo(() => ({ value: props.props?.gatewayScope }), {
      equals: (before, after) => before.value === after.value,
    });
    createEffect(
      () => presentation(),
      () => {
        setIntent("auto");
        opener = undefined;
      },
    );
    createEffect(
      () => [props.presented, intent()] as const,
      ([presented, choice]) => {
        if (!presented && choice === "open") {
          setIntent("auto");
        }
      },
    );
    createEffect(
      () => [opened(), docked(), props.mobile] as const,
      ([open, dock, mobile]) => {
        hide();
        mountSurface(mobile);
        panel.hidden = !open;
        panel.popover = dock ? null : "manual";
        panel.style.cssText = "";
        panel.classList.toggle("chat-details--docked", dock);
        frame?.style.setProperty("--chat-details-space", dock ? DETAILS_WIDTH + "px" : "0px");
        if (open && !dock) {
          position(mobile);
          // Keep native Tab entry beside its header trigger after portaling the content.
          panel.showPopover({ source: focusSource(mobile) });
        }
      },
    );
    const reposition = () => {
      mountSurface(props.mobile);
      position(props.mobile);
    };
    onSettled(() => {
      pane = host.closest<HTMLElement>(".sidebar-region");
      frame =
        host.closest<HTMLElement>(".chat-main__conversation-frame") ??
        host
          .closest("openclaw-chat-pane")
          ?.querySelector<HTMLElement>(".chat-main__conversation-frame") ??
        null;
      const resize =
        typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(reposition);
      for (const element of [pane, frame, frame?.querySelector(".chat-footer")]) {
        if (element) {
          resize?.observe(element);
        }
      }
      reposition();
      return () => resize?.disconnect();
    });
    window.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", reposition);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    onCleanup(() => {
      controls.delete(host);
      hide();
      frame?.style.removeProperty("--chat-details-space");
      surface.remove();
      window.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("scroll", reposition);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    });
    return (
      <>
        <button
          ref={(element) => {
            trigger = element;
          }}
          class="chat-details-toggle"
          hidden={props.mobile}
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
            ref={(element) => {
              panel = element;
            }}
            class="chat-details"
            id={panelId}
            popover="manual"
            role={docked() ? "complementary" : "dialog"}
            aria-label={t("chat.sessionDetails.title")}
          >
            <Show when={props.mobile}>
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
                  <ChatDetailsSession
                    props={props.props}
                    presented={props.presented && opened()}
                    dismissed={intent() === "closed"}
                  />
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
      presented: { default: false, type: Boolean },
      mobile: { default: false, type: Boolean, reflect: true },
    },
    methods: { open: (host, source) => controls.get(host)?.open(source) },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-details": ChatDetails;
  }
}
