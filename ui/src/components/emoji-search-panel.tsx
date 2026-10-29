import type { JSX } from "@solidjs/web";
import emojiDefinitions from "markdown-it-emoji/lib/data/full.mjs";
import { createMemo, For, Show } from "solid-js";
import "../styles/emoji-search-panel.css";

type EmojiChoice = { name: string; emoji: string };

const choices: readonly EmojiChoice[] = Object.entries(emojiDefinitions).map(([name, emoji]) => ({
  name,
  emoji,
}));
const MAX_RESULTS = 96;

/** Shortcode search: prefix matches rank first; each emoji appears once under its first alias. */
function searchEmoji(query: string): EmojiChoice[] {
  // Accept typed shortcodes such as ":banana:" as well as bare names.
  const search = query.trim().toLowerCase().replace(/^:|:$/gu, "").replaceAll(" ", "_");
  const prefix: EmojiChoice[] = [];
  const other: EmojiChoice[] = [];
  const seen = new Set<string>();
  for (const choice of choices) {
    if (seen.has(choice.emoji)) {
      continue;
    }
    if (choice.name.startsWith(search) || choice.emoji === search) {
      prefix.push(choice);
    } else if (choice.name.includes(search)) {
      other.push(choice);
    } else {
      continue;
    }
    seen.add(choice.emoji);
  }
  return [...prefix, ...other].slice(0, MAX_RESULTS);
}

function labelChoices(emojis: readonly string[]): EmojiChoice[] {
  return emojis.map(
    (emoji) => choices.find((choice) => choice.emoji === emoji) ?? { name: emoji, emoji },
  );
}

export function EmojiSearchPanel(props: {
  query: string;
  /** Receives committed text only; IME candidates wait for compositionend. */
  onQueryChange: (query: string) => void;
  onSelect: (emoji: string) => void;
  isSelected: (emoji: string) => boolean;
  /** Shown while the query is empty. */
  defaults: readonly string[];
  searchLabel: string;
  gridLabel: string;
  emptyLabel: string;
  inputRef?: (input: HTMLInputElement) => void;
  onInputKeyDown?: (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => void;
  leading?: JSX.Element;
}) {
  const defaults = createMemo(() => labelChoices(props.defaults));
  const resultsFor = (query: string) => (query.trim() ? searchEmoji(query) : defaults());
  const results = createMemo(() => resultsFor(props.query));
  return (
    <div class="emoji-search-panel">
      <div class="emoji-search-panel__row">
        {props.leading}
        <input
          ref={(input) => props.inputRef?.(input)}
          class="emoji-search-panel__search"
          type="search"
          autocomplete="off"
          aria-label={props.searchLabel}
          placeholder={props.searchLabel}
          value={props.query}
          onInput={(event) => {
            if (!event.isComposing) {
              props.onQueryChange(event.currentTarget.value);
            }
          }}
          onCompositionEnd={(event) => props.onQueryChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.isComposing) {
              return;
            }
            props.onInputKeyDown?.(event);
            if (event.defaultPrevented || event.key !== "Enter") {
              return;
            }
            // Read the field itself: the query signal may not have flushed since the last input.
            const first = resultsFor(event.currentTarget.value)[0];
            if (first) {
              event.preventDefault();
              event.stopPropagation();
              props.onSelect(first.emoji);
            }
          }}
        />
      </div>
      <div class="emoji-search-panel__grid" role="group" aria-label={props.gridLabel}>
        <Show
          when={results().length}
          fallback={<span class="emoji-search-panel__empty">{props.emptyLabel}</span>}
        >
          <For each={results()}>
            {(choice) => (
              <button
                type="button"
                class="emoji-search-panel__choice"
                aria-label={choice.name.replaceAll("_", " ")}
                title={choice.name.replaceAll("_", " ")}
                aria-pressed={props.isSelected(choice.emoji) ? "true" : "false"}
                onClick={() => props.onSelect(choice.emoji)}
              >
                {choice.emoji}
              </button>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
