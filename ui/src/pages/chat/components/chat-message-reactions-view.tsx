import WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import { createEffect, createSignal, For, Show } from "solid-js";
import { isReactionEmoji } from "../../../../../packages/gateway-protocol/src/index.js";
import { sessionEmojiPickerShortcut } from "../../../components/session-icon-picker.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { syncPopoverLabel } from "../../../components/web-awesome-popover.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../../lit/solid-bridge.ts";
import "./chat-message-reactions.css";

export type MessageReactionPlacement = "bottom-start" | "bottom-end";

const QUICK_REACTIONS = ["👍", "❤️", "🎉", "👀", "🚀", "😂"] as const;
let nextPickerId = 0;

type MessageReactionPickerProps = {
  onSelect?: (emoji: string, remove: boolean) => void;
  activeEmoji: ReadonlySet<string>;
  placement: MessageReactionPlacement;
  compact: boolean;
};

export const MessageReactionPicker = defineSolidBridge<MessageReactionPickerProps>(
  "openclaw-message-reaction-picker",
  (props, host) => {
    const [custom, setCustom] = createSignal(false);
    const [value, setValue] = createSignal("");
    const [invalid, setInvalid] = createSignal(false);
    // Popovers now share the document's ID namespace instead of individual shadow roots.
    const triggerId = `reaction-trigger-${++nextPickerId}`;
    let popover: WaPopover | undefined;
    let focusAfterCommit: "input" | "palette" | undefined;
    const paletteButtons = () => [...host.querySelectorAll<HTMLButtonElement>(".palette button")];
    const focusPalette = () => {
      const buttons = paletteButtons();
      (
        buttons.find((button) => button.getAttribute("aria-pressed") === "true") ?? buttons[0]
      )?.focus();
    };
    createEffect(custom, () => {
      if (focusAfterCommit === "input") {
        host.querySelector("input")?.focus();
      } else if (focusAfterCommit === "palette") {
        focusPalette();
      }
      focusAfterCommit = undefined;
    });
    const close = () => {
      if (popover) {
        popover.open = false;
      }
    };
    const select = (emoji: string) => {
      props.onSelect?.(emoji, props.activeEmoji.has(emoji));
      close();
    };
    const applyCustom = (text: string) => {
      const candidate = text.trim();
      if (isReactionEmoji(candidate)) {
        select(candidate);
      } else {
        setInvalid(candidate.length > 0);
      }
    };
    const reset = () => {
      setCustom(false);
      setValue("");
      setInvalid(false);
    };
    const showPalette = () => {
      focusAfterCommit = "palette";
      reset();
    };
    const showCustom = () => {
      focusAfterCommit = "input";
      setCustom(true);
    };
    const movePaletteFocus = (event: KeyboardEvent) => {
      const buttons = paletteButtons();
      const current = buttons.findIndex((button) => button === host.ownerDocument.activeElement);
      const target =
        event.key === "ArrowRight"
          ? (current + 1) % buttons.length
          : event.key === "ArrowLeft"
            ? (current - 1 + buttons.length) % buttons.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : -1;
      if (target >= 0) {
        event.preventDefault();
        buttons[target]?.focus();
      }
    };
    const shortcut = sessionEmojiPickerShortcut()?.join("");
    return (
      <>
        <openclaw-tooltip prop:content={t("chat.reactions.add")}>
          <button
            id={triggerId}
            class="trigger"
            type="button"
            aria-label={t("chat.reactions.add")}
            aria-haspopup="dialog"
            aria-expanded="false"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M21 11.5a9 9 0 1 1-8.5-8.5" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2M16 5h6M19 2v6" />
              <path d="M9 9h.01M15 9h.01" />
            </svg>
          </button>
        </openclaw-tooltip>
        <wa-popover
          ref={(element: WaPopover) => {
            popover = element;
            syncPopoverLabel(element);
          }}
          class={["chat-reaction-picker", { custom: custom() }]}
          for={triggerId}
          placement={props.placement}
          distance="6"
          without-arrow
          aria-label={t("chat.reactions.add")}
          onWa-show={() => popover?.anchor?.setAttribute("aria-expanded", "true")}
          onWa-after-show={() => (custom() ? host.querySelector("input")?.focus() : focusPalette())}
          onWa-hide={() => popover?.anchor?.setAttribute("aria-expanded", "false")}
          onWa-after-hide={() => {
            focusAfterCommit = undefined;
            reset();
          }}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <Show
            when={custom()}
            fallback={
              <div
                class="palette"
                role="group"
                aria-label={t("chat.reactions.quick")}
                onKeyDown={movePaletteFocus}
              >
                <For each={QUICK_REACTIONS}>
                  {(emoji) => (
                    <button
                      class="emoji"
                      type="button"
                      aria-label={emoji}
                      aria-pressed={props.activeEmoji.has(emoji) ? "true" : "false"}
                      onClick={() => select(emoji)}
                    >
                      {emoji}
                    </button>
                  )}
                </For>
                <span class="divider" aria-hidden="true" />
                <openclaw-tooltip prop:content={t("chat.reactions.more")}>
                  <button
                    class="more"
                    type="button"
                    aria-label={t("chat.reactions.more")}
                    onClick={showCustom}
                  >
                    <Icon name="moreHorizontal" />
                  </button>
                </openclaw-tooltip>
              </div>
            }
          >
            <div class="custom">
              <div class="custom-row">
                <button
                  class="back"
                  type="button"
                  aria-label={t("chat.reactions.back")}
                  onClick={showPalette}
                >
                  <Icon name="arrowLeft" />
                </button>
                <input
                  aria-label={t("chat.reactions.emoji")}
                  aria-invalid={invalid() ? "true" : "false"}
                  autocomplete="off"
                  placeholder={t("chat.reactions.placeholder")}
                  value={value()}
                  onInput={(event) => {
                    const text = event.currentTarget.value;
                    setValue(text);
                    setInvalid(false);
                    // The OS picker commits one emoji; IME candidates wait for compositionend.
                    if (!event.isComposing && isReactionEmoji(text.trim())) {
                      applyCustom(text);
                    }
                  }}
                  onCompositionEnd={(event) => {
                    const text = event.currentTarget.value;
                    setValue(text);
                    if (isReactionEmoji(text.trim())) {
                      applyCustom(text);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.isComposing) {
                      return;
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.stopPropagation();
                      applyCustom(event.currentTarget.value);
                    } else if (event.key === "Backspace" && !event.currentTarget.value) {
                      event.preventDefault();
                      showPalette();
                    }
                  }}
                />
              </div>
              <p class="hint" aria-live="polite">
                {invalid()
                  ? t("chat.reactions.invalid")
                  : shortcut
                    ? t("chat.reactions.shortcut", { shortcut })
                    : t("chat.reactions.hint")}
              </p>
            </div>
          </Show>
        </wa-popover>
      </>
    );
  },
  {
    properties: {
      onSelect: { default: undefined, attribute: false },
      activeEmoji: { default: new Set(), attribute: false },
      placement: { default: "bottom-start" },
      compact: { default: false, type: Boolean, reflect: true },
    },
  },
);
