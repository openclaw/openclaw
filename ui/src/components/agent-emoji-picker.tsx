import { createEffect, createSignal, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { generateUUID } from "../lib/uuid.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { EmojiSearchPanel } from "./emoji-search-panel.tsx";
import { Popover, type PopoverHandle } from "./solid/popover.tsx";
import "../styles/agent-emoji-picker.css";

const favorites = [
  "🦞",
  "🚀",
  "✨",
  "🐬",
  "🦊",
  "🤖",
  "🌻",
  "🧠",
  "🎨",
  "📚",
  "🌍",
  "⚡",
  "🔥",
  "🌈",
  "🦉",
  "🐙",
  "🌙",
  "🎯",
  "💡",
  "🧪",
  "🎵",
  "💜",
  "🌟",
  "🐱",
];

type AgentEmojiPickerProps = {
  value: string;
  disabled: boolean;
  onSelect: (emoji: string) => void;
};
type AgentEmojiPicker = SolidBridgeElement<AgentEmojiPickerProps>;
defineSolidBridge<AgentEmojiPickerProps>(
  "openclaw-agent-emoji-picker",
  (props) => {
    const [query, setQuery] = createSignal("");
    const [opened, setOpened] = createSignal(false);
    const [trigger, setTrigger] = createSignal<HTMLButtonElement>();
    const id = `agent-emoji-trigger-${generateUUID()}`;
    let popover: PopoverHandle | undefined;
    let searchInput!: HTMLInputElement;
    createEffect(
      () => props.disabled,
      (disabled) => {
        if (disabled) {
          popover?.hide();
        }
      },
    );
    return (
      <>
        <button
          ref={setTrigger}
          id={id}
          type="button"
          class="agent-emoji-picker__trigger"
          aria-label={t("agents.identity.chooseEmoji")}
          disabled={props.disabled}
          aria-haspopup="dialog"
          aria-expanded={opened() ? "true" : "false"}
          aria-controls={`${id}-popover`}
          onClick={() => popover?.overlay.request(!popover.overlay.open)}
        >
          <span class="agent-emoji-picker__icon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <path d="M9 9h.01M15 9h.01" />
            </svg>
          </span>
        </button>
        <Show when={trigger()}>
          {(anchor) => (
            <Popover
              id={`${id}-popover`}
              anchor={anchor()}
              class="agent-emoji-picker__popover"
              placement="bottom-end"
              label={t("agents.identity.chooseEmoji")}
              ref={(handle) => {
                popover = handle;
              }}
              onBeforeShow={(event) => {
                if (props.disabled) {
                  event.preventDefault();
                }
              }}
              onOpenChange={(open) => {
                setOpened(open);
                if (open) {
                  searchInput.focus({ preventScroll: true });
                } else {
                  setQuery("");
                }
              }}
            >
              <EmojiSearchPanel
                query={query()}
                onQueryChange={setQuery}
                onSelect={(emoji) => {
                  if (!props.disabled) {
                    props.onSelect(emoji);
                    popover?.overlay.request(false, "return");
                  }
                }}
                isSelected={(emoji) => props.value === emoji}
                defaults={favorites}
                searchLabel={t("agents.identity.searchEmoji")}
                gridLabel={t("agents.identity.emoji")}
                emptyLabel={t("agents.identity.noEmojiMatches")}
                inputRef={(input) => {
                  searchInput = input;
                }}
              />
            </Popover>
          )}
        </Show>
      </>
    );
  },
  {
    properties: {
      value: { default: "" },
      disabled: { default: false, type: Boolean },
      onSelect: { default: () => {}, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-agent-emoji-picker": AgentEmojiPicker;
  }
}
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-agent-emoji-picker": HTMLAttributes<AgentEmojiPicker> & {
        "prop:value"?: string;
        "prop:disabled"?: boolean;
        "prop:onSelect"?: (emoji: string) => void;
      };
    }
  }
}
