import { createSignal, For, Show, onSettled } from "solid-js";
import { isReactionEmoji } from "../../../../../packages/gateway-protocol/src/reaction-emoji.js";
import { EmojiSearchPanel } from "../../../components/emoji-search-panel.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../../components/solid/popover.tsx";
import { StrokeIcon } from "../../../components/solid/stroke-icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
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
  compact?: boolean;
  class?: string;
};

export function MessageReactionPicker(props: MessageReactionPickerProps) {
  let host!: HTMLElement;
  const [custom, setCustom] = createSignal(false);
  const [query, setQuery] = createSignal("");
  // Popovers now share the document's ID namespace instead of individual shadow roots.
  const triggerId = `reaction-trigger-${++nextPickerId}`;
  let popover: PopoverHandle | undefined;
  let trigger!: HTMLButtonElement;
  let searchInput: HTMLInputElement | undefined;
  const paletteButtons: HTMLButtonElement[] = [];
  const stop: (() => void)[] = [];
  const focusPicker = () => {
    if (!popover?.overlay.open) {
      return;
    }
    (custom()
      ? searchInput
      : (paletteButtons.find((button) => button.getAttribute("aria-pressed") === "true") ??
        paletteButtons[0])
    )?.focus();
  };
  onSettled(() => () => stop.forEach((dispose) => dispose()));
  const close = () => popover?.overlay.request(false, "return");
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
    reset();
    onSettled(focusPicker);
  };
  const showCustom = () => {
    setCustom(true);
    onSettled(focusPicker);
  };
  const movePaletteFocus = (event: KeyboardEvent) => {
    const buttons = paletteButtons;
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
    <openclaw-message-reaction-picker
      ref={(element) => (host = element)}
      class={props.class}
      compact={props.compact}
    >
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
          <StrokeIcon aria-hidden="true">
            <path d="M21 11.5a9 9 0 1 1-8.5-8.5" />
            <path d="M8 14s1.5 2 4 2 4-2 4-2M16 5h6M19 2v6" />
            <path d="M9 9h.01M15 9h.01" />
          </StrokeIcon>
        </button>
      </openclaw-tooltip>
      <Popover
        lazy="while-open"
        sameRoot
        id={`${triggerId}-popover`}
        ref={(handle) => {
          popover = handle;
          stop.push(
            listen(handle.overlay.surface, "overlay-after-show", focusPicker),
            listen(handle.overlay.surface, "overlay-after-hide", reset),
          );
        }}
        anchor={trigger}
        class={["chat-reaction-picker", { custom: custom() }]}
        placement={props.placement}
        label={t("chat.reactions.add")}
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
                    ref={(button) => {
                      paletteButtons[QUICK_REACTIONS.indexOf(emoji)] = button;
                    }}
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
                  ref={(button) => {
                    paletteButtons[QUICK_REACTIONS.length] = button;
                  }}
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
              inputRef={(input) => {
                searchInput = input;
              }}
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
    </openclaw-message-reaction-picker>
  );
}
