import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import { isReactionEmoji } from "../../../../../packages/gateway-protocol/src/index.js";
import { EmojiSearchPanel } from "../../../components/emoji-search-panel.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../../components/solid/popover.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../../lib/solid-bridge.ts";
import type { MessageReactionPlacement } from "./chat-message-reaction-model.ts";
import "./chat-message-reactions.css";

const QUICK_REACTIONS = ["👍", "❤️", "🎉", "👀", "🚀", "😂"] as const;
// Shown before the search has a query; quick reactions lead so the grid extends the palette.
const SEARCH_DEFAULTS = [
  ...QUICK_REACTIONS,
  "👎",
  "🙏",
  "🔥",
  "✅",
  "❌",
  "💯",
  "🤔",
  "😮",
  "😢",
  "👏",
  "🙌",
  "💡",
  "🐛",
  "🦞",
  "⚠️",
  "🤝",
  "✨",
  "🎯",
] as const;
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
    const [query, setQuery] = createSignal("");
    // Popovers now share the document's ID namespace instead of individual shadow roots.
    const triggerId = `reaction-trigger-${++nextPickerId}`;
    let popover: PopoverHandle | undefined;
    let trigger!: HTMLButtonElement;
    let focusAfterCommit: "input" | "palette" | undefined;
    const paletteButtons = () => [...host.querySelectorAll<HTMLButtonElement>(".palette button")];
    const focusPalette = () => {
      const buttons = paletteButtons();
      (
        buttons.find((button) => button.getAttribute("aria-pressed") === "true") ?? buttons[0]
      )?.focus();
    };
    const focusPicker = () => {
      if (custom()) {
        host.querySelector("input")?.focus();
      } else {
        focusPalette();
      }
    };
    onCleanup(() => {
      popover?.overlay.surface.removeEventListener("overlay-after-show", focusPicker);
      popover?.overlay.surface.removeEventListener("overlay-after-hide", reset);
    });
    createEffect(custom, () => {
      if (focusAfterCommit === "input") {
        host.querySelector("input")?.focus();
      } else if (focusAfterCommit === "palette") {
        focusPalette();
      }
      focusAfterCommit = undefined;
    });
    const close = () => {
      popover?.overlay.request(false, "return");
    };
    const select = (emoji: string) => {
      props.onSelect?.(emoji, props.activeEmoji.has(emoji));
      close();
    };
    const search = (text: string) => {
      setQuery(text);
      // A pasted or OS-picker emoji applies at once, including ones the shortcode catalog lacks.
      const candidate = text.trim();
      if (isReactionEmoji(candidate)) {
        select(candidate);
      }
    };
    const reset = () => {
      setCustom(false);
      setQuery("");
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
    return (
      <>
        <openclaw-tooltip prop:content={t("chat.reactions.add")}>
          <button
            ref={(element) => {
              trigger = element;
            }}
            id={triggerId}
            class="trigger"
            type="button"
            aria-label={t("chat.reactions.add")}
            aria-haspopup="dialog"
            aria-expanded="false"
            onClick={() => popover?.overlay.request(!popover.overlay.open)}
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
        <Popover
          lazy="while-open"
          sameRoot
          id={`${triggerId}-popover`}
          ref={(handle) => {
            popover = handle;
            handle.overlay.surface.addEventListener("overlay-after-show", focusPicker);
            handle.overlay.surface.addEventListener("overlay-after-hide", reset);
          }}
          anchor={trigger}
          class={custom() ? "chat-reaction-picker custom" : "chat-reaction-picker"}
          placement={props.placement}
          label={t("chat.reactions.add")}
          onOpenChange={(open) => {
            if (!open) {
              focusAfterCommit = undefined;
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
              <EmojiSearchPanel
                query={query()}
                onQueryChange={search}
                onSelect={select}
                isSelected={(emoji) => props.activeEmoji.has(emoji)}
                defaults={SEARCH_DEFAULTS}
                searchLabel={t("chat.reactions.search")}
                gridLabel={t("chat.reactions.emoji")}
                emptyLabel={t("chat.reactions.noMatches")}
                onInputKeyDown={(event) => {
                  if (event.key === "Backspace" && !event.currentTarget.value) {
                    event.preventDefault();
                    showPalette();
                  }
                }}
                leading={
                  <button
                    class="back"
                    type="button"
                    aria-label={t("chat.reactions.back")}
                    onClick={showPalette}
                  >
                    <Icon name="arrowLeft" />
                  </button>
                }
              />
            </div>
          </Show>
        </Popover>
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
