import emojiDefinitions from "markdown-it-emoji/lib/data/full.mjs";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { generateUUID } from "../lib/uuid.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
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
const choices = Object.entries(emojiDefinitions).map(([name, emoji]) => ({ name, emoji }));
const favoriteChoices = favorites.map(
  (emoji) => choices.find((choice) => choice.emoji === emoji) ?? { name: emoji, emoji },
);

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
    const unique = createMemo(() => {
      const search = query().trim().toLowerCase().replaceAll(" ", "_");
      const visible = search
        ? choices
            .filter(({ name, emoji }) => name.includes(search) || emoji === search)
            .slice(0, 96)
        : favoriteChoices;
      const seen = new Set<string>();
      return visible.filter(({ emoji }) => !seen.has(emoji) && seen.add(emoji));
    });
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
              <div class="agent-emoji-picker__panel">
                <input
                  ref={(node) => {
                    searchInput = node;
                  }}
                  class="agent-emoji-picker__search"
                  type="search"
                  autofocus
                  aria-label={t("agents.identity.searchEmoji")}
                  placeholder={t("agents.identity.searchEmoji")}
                  value={query()}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
                <div
                  class="agent-emoji-picker__grid"
                  role="group"
                  aria-label={t("agents.identity.emoji")}
                >
                  <Show
                    when={unique().length}
                    fallback={
                      <span class="agent-emoji-picker__empty">
                        {t("agents.identity.noEmojiMatches")}
                      </span>
                    }
                  >
                    <For each={unique()}>
                      {(choice) => (
                        <button
                          type="button"
                          class="agent-emoji-picker__choice"
                          aria-label={choice.name.replaceAll("_", " ")}
                          title={choice.name.replaceAll("_", " ")}
                          aria-pressed={props.value === choice.emoji ? "true" : "false"}
                          onClick={() => {
                            if (!props.disabled) {
                              props.onSelect(choice.emoji);
                              popover?.overlay.request(false, "return");
                            }
                          }}
                        >
                          {choice.emoji}
                        </button>
                      )}
                    </For>
                  </Show>
                </div>
              </div>
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
