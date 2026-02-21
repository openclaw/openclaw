import { html, nothing, type TemplateResult } from "lit";
import { searchEmoji } from "../emoji-data.ts";

export type EmojiAutocompleteState = {
  open: boolean;
  query: string;
  results: Array<{ shortcode: string; emoji: string }>;
  selectedIndex: number;
};

export function createEmojiAutocompleteState(): EmojiAutocompleteState {
  return { open: false, query: "", results: [], selectedIndex: 0 };
}

/**
 * Extract the current emoji shortcode query from textarea text + cursor.
 * Returns the query string (after ':') or null if no active shortcode.
 */
export function extractEmojiQuery(text: string, cursorPos: number): string | null {
  // Look backwards from cursor for an unmatched ':'
  const before = text.slice(0, cursorPos);
  const colonIdx = before.lastIndexOf(":");
  if (colonIdx === -1) {
    return null;
  }

  // The colon must be at start of text, or preceded by whitespace
  if (colonIdx > 0 && !/\s/.test(before[colonIdx - 1])) {
    return null;
  }

  const query = before.slice(colonIdx + 1);

  // Must not contain spaces or another ':'
  if (/[\s:]/.test(query)) {
    return null;
  }

  // Need at least 2 chars after ':' to trigger suggestions
  if (query.length < 2) {
    return null;
  }

  return query;
}

/**
 * Update autocomplete state based on current textarea value and cursor.
 */
export function updateEmojiAutocomplete(text: string, cursorPos: number): EmojiAutocompleteState {
  const query = extractEmojiQuery(text, cursorPos);
  if (!query) {
    return createEmojiAutocompleteState();
  }

  const results = searchEmoji(query);
  if (results.length === 0) {
    return createEmojiAutocompleteState();
  }

  return { open: true, query, results, selectedIndex: 0 };
}

/**
 * Apply the selected emoji: replace ':query' with the emoji character.
 */
export function applyEmojiSelection(
  text: string,
  cursorPos: number,
  emoji: string,
): { text: string; cursor: number } {
  const query = extractEmojiQuery(text, cursorPos);
  if (!query) {
    return { text, cursor: cursorPos };
  }

  // Find the ':' that starts this shortcode
  const before = text.slice(0, cursorPos);
  const colonIdx = before.lastIndexOf(":");
  const after = text.slice(cursorPos);

  const newText = text.slice(0, colonIdx) + emoji + after;
  const newCursor = colonIdx + emoji.length;

  return { text: newText, cursor: newCursor };
}

/**
 * Handle keyboard events for the emoji autocomplete.
 * Returns true if the event was consumed.
 */
export function handleEmojiKeydown(
  e: KeyboardEvent,
  state: EmojiAutocompleteState,
  onUpdate: (state: EmojiAutocompleteState) => void,
  onSelect: (emoji: string) => void,
): boolean {
  if (!state.open) {
    return false;
  }

  switch (e.key) {
    case "ArrowDown": {
      e.preventDefault();
      const next = (state.selectedIndex + 1) % state.results.length;
      onUpdate({ ...state, selectedIndex: next });
      return true;
    }
    case "ArrowUp": {
      e.preventDefault();
      const next = (state.selectedIndex - 1 + state.results.length) % state.results.length;
      onUpdate({ ...state, selectedIndex: next });
      return true;
    }
    case "Enter":
    case "Tab": {
      e.preventDefault();
      const selected = state.results[state.selectedIndex];
      if (selected) {
        onSelect(selected.emoji);
      }
      return true;
    }
    case "Escape": {
      e.preventDefault();
      onUpdate(createEmojiAutocompleteState());
      return true;
    }
  }

  return false;
}

/**
 * Render the emoji autocomplete popup.
 */
export function renderEmojiAutocomplete(
  state: EmojiAutocompleteState,
  onSelect: (emoji: string) => void,
  onUpdate?: (state: EmojiAutocompleteState) => void,
): TemplateResult | typeof nothing {
  if (!state.open || state.results.length === 0) {
    return nothing;
  }

  return html`
    <div class="emoji-autocomplete" role="listbox" aria-label="Emoji suggestions">
      ${state.results.map(
        (r, i) => html`
          <div
            class="emoji-autocomplete__item ${i === state.selectedIndex ? "emoji-autocomplete__item--selected" : ""}"
            role="option"
            aria-selected=${i === state.selectedIndex}
            @mousedown=${(e: MouseEvent) => {
              e.preventDefault();
              onSelect(r.emoji);
            }}
            @mouseenter=${() => {
              if (onUpdate && i !== state.selectedIndex) {
                onUpdate({ ...state, selectedIndex: i });
              }
            }}
          >
            <span class="emoji-autocomplete__emoji">${r.emoji}</span>
            <span class="emoji-autocomplete__name">:${r.shortcode}:</span>
          </div>
        `,
      )}
    </div>
  `;
}
