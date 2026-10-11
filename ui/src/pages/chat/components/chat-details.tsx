import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import { Show, createEffect, createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { ChatDetailsProgress } from "./chat-details-progress.tsx";
import { ChatDetailsSession } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import "../../../styles/chat/details.css";

type Props = { props?: ChatDetailsProps; presented: boolean };
export type ChatDetails = SolidBridgeElement<Props>;
let nextId = 0;

/** User-opened, pane-local presentation. Data and mutations remain with the pane. */
export const ChatDetails = defineSolidBridge<Props>(
  "openclaw-chat-details",
  (props, host) => {
    const [opened, setOpened] = createSignal(false);
    const panelId = `chat-details-${++nextId}`;
    let panel!: HTMLDivElement;
    let trigger!: HTMLButtonElement;
    const position = () => {
      const frame =
        host.closest(".chat-main__conversation-frame") ??
        host.closest("openclaw-chat-pane")?.querySelector(".chat-main__conversation-frame");
      const footer = frame?.querySelector(".chat-footer");
      const bounds = frame?.getBoundingClientRect();
      if (!panel || !bounds) {
        return;
      }
      const viewport = window.visualViewport;
      const minimumTop = Math.max(bounds.top + 8, (viewport?.offsetTop ?? 0) + 8);
      const left = Math.max(bounds.left + 8, (viewport?.offsetLeft ?? 0) + 8);
      const right = Math.min(
        bounds.right - 8,
        (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - 8,
      );
      const bottom =
        Math.min(
          footer?.getBoundingClientRect().top ?? bounds.bottom,
          bounds.bottom,
          (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
        ) - 8;
      const triggerBounds = trigger?.getBoundingClientRect();
      // Retain the gutter clearance when the trigger sits above the conversation.
      const triggerBottom = triggerBounds
        ? Math.max(triggerBounds.bottom, minimumTop + triggerBounds.height)
        : minimumTop + 28;
      const top = Math.max(minimumTop, Math.min(triggerBottom + 6, bottom - 120));
      panel.style.left = `${Math.max(left, right - 352)}px`;
      panel.style.top = `${top}px`;
      panel.style.width = `${Math.max(0, Math.min(352, right - left))}px`;
      panel.style.maxHeight = `${Math.max(0, bottom - top)}px`;
    };
    const hide = () => {
      for (const menu of host.querySelectorAll<WaDropdown>("wa-dropdown")) {
        menu.open = false;
      }
      if (panel?.isConnected) {
        panel.hidePopover?.();
      }
    };
    const close = (restoreFocus = false) => {
      hide();
      setOpened(false);
      if (restoreFocus && host.isConnected) {
        trigger?.focus({ preventScroll: true });
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
      position();
      panel.showPopover?.();
      setOpened(true);
    };
    const outside = (event: PointerEvent) => {
      if (opened() && !event.composedPath().includes(host)) {
        close();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        opened() &&
        !event.defaultPrevented &&
        !host.querySelector("wa-dropdown[open]")
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
    const presentation = createMemo(
      () => [identity(), props.props?.gatewayScope, props.presented] as const,
      {
        equals: (before, after) => before.every((value, index) => value === after[index]),
      },
    );
    const scope = createMemo(() => ({ value: props.props?.gatewayScope }), {
      equals: (before, after) => before.value === after.value,
    });
    createEffect(
      () => presentation(),
      () => close(),
    );
    onSettled(() => {
      const frame =
        host.closest(".chat-main__conversation-frame") ??
        host.closest("openclaw-chat-pane")?.querySelector(".chat-main__conversation-frame");
      const resize =
        typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position);
      for (const element of [frame, frame?.querySelector(".chat-footer")]) {
        if (element) {
          resize?.observe(element);
        }
      }
      position();
      return () => resize?.disconnect();
    });
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    onCleanup(() => {
      hide();
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
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
          type="button"
          aria-label={t("chat.sessionDetails.title")}
          aria-controls={panelId}
          aria-expanded={opened() ? "true" : "false"}
          aria-haspopup="dialog"
          onClick={toggle}
        >
          <Icon name="listChecks" />
          <span>{t("chat.sessionDetails.title")}</span>
        </button>
        <div
          ref={(element) => {
            panel = element;
          }}
          class="chat-details"
          id={panelId}
          popover="manual"
          role="dialog"
          aria-label={t("chat.sessionDetails.title")}
        >
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
          <Show when={scope()} keyed>
            {(_scope) => (
              <>
                <ChatDetailsSession props={props.props} presented={props.presented && opened()} />
                <Show when={props.props?.progressCard || props.props?.progressCardInitialLoading}>
                  <ChatDetailsProgress
                    props={props.props}
                    presented={props.presented && opened()}
                  />
                </Show>
              </>
            )}
          </Show>
        </div>
      </>
    );
  },
  {
    properties: {
      props: { default: undefined, attribute: false },
      presented: { default: false, type: Boolean },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-details": ChatDetails;
  }
}
