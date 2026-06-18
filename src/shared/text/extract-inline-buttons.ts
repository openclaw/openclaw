/**
 * Extracts inline button JSON arrays from model-generated text.
 *
 * Some models (e.g. Gemini) output button definitions like
 * `[[{"text":"Label","callback_data":"data"}]]` or
 * `[[[{"text":"Label","callback_data":"data"}]]]` as raw text instead
 * of using the message tool's `interactive` parameter. This helper
 * scans for well-formed button JSON inside double-bracket markers,
 * removes the marker text, and returns extracted button rows.
 *
 * The scanner handles three common model-output formats:
 * - `[[{"text":"X","callback_data":"Y"}]]` — double bracket, inner JSON object array
 * - `[[[{"text":"X","callback_data":"Y"}]]]` — triple bracket, inner JSON object array
 * - `[[[{...}],[{...}]]]` — multi-row format with inner JSON array of arrays
 *
 * It intentionally leaves known non-button double-bracket directives
 * like `[[tts:voice]]` and `[[reply_to_current]]` untouched.
 */

export type ExtractedInlineButton = {
  text: string;
  callback_data: string;
  style?: string;
};

export type InlineButtonExtractResult = {
  /** Cleaned text with button markers and surrounding whitespace removed. */
  text: string;
  /** Extracted button rows. Each inner array is one row of buttons. */
  buttons: ExtractedInlineButton[][];
};

function isValidButtonObject(value: unknown): value is ExtractedInlineButton {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).text === "string" &&
    ((value as Record<string, unknown>).text as string).length > 0 &&
    typeof (value as Record<string, unknown>).callback_data === "string" &&
    ((value as Record<string, unknown>).callback_data as string).length > 0
  );
}

function isValidButtonArray(value: unknown): value is ExtractedInlineButton[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(isValidButtonObject);
}

/**
 * Parse the inner content of a `[[...]]` or `[[[...]]]` wrapper as
 * button rows. Handles:
 * - Single-row: `[{...}]` or `[{"text":"X",...}]` (JSON array of objects)
 * - Single object: `{"text":"X","callback_data":"Y"}` (one button, no array wrapper)
 * - Comma-separated objects: `{"text":"X",...}, {"text":"Y",...}` (multiple
 *   buttons without array wrapper — Gemini sometimes emits this)
 * - Multi-row: `[[{...}],[{...}]]` (array of arrays)
 */
function parseButtonRows(innerText: string): ExtractedInlineButton[][] | null {
  const trimmed = innerText.trim();

  try {
    const parsed = JSON.parse(trimmed);

    // Multi-row format: each element is itself an array of buttons
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((row) => Array.isArray(row))) {
      const rows = parsed as unknown[][];
      const allValid = rows.every(
        (row) =>
          Array.isArray(row) &&
          row.length > 0 &&
          row.every(isValidButtonObject),
      );
      if (allValid) {
        return rows.map((row) => row as ExtractedInlineButton[]);
      }
      return null;
    }

    // Single-row format: array of button objects
    if (Array.isArray(parsed) && parsed.length > 0 && isValidButtonArray(parsed)) {
      return [parsed];
    }

    // Single object format: {"text":"X","callback_data":"Y"} (not wrapped in an array)
    if (isValidButtonObject(parsed)) {
      return [[parsed]];
    }

    return null;
  } catch {
    // JSON.parse failed — the content might be comma-separated values
    // without an outer array wrapper. Models emit several variants:
    // - `{"text":"A",...}, {"text":"B",...}` (comma-separated objects)
    // - `[{...}], [{...}]` (comma-separated arrays, i.e. multi-row)
    // Try wrapping it in brackets: `[..., ...]`
    try {
      const wrapped = `[${trimmed}]`;
      const parsed = JSON.parse(wrapped);

      // Multi-row: wrapped content is array-of-arrays
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((row) => Array.isArray(row))
      ) {
        const rows = parsed as unknown[][];
        const allValid = rows.every(
          (row) =>
            Array.isArray(row) &&
            row.length > 0 &&
            row.every(isValidButtonObject),
        );
        if (allValid) {
          return rows.map((row) => row as ExtractedInlineButton[]);
        }
        return null;
      }

      // Single-row: wrapped content is array of button objects
      if (Array.isArray(parsed) && isValidButtonArray(parsed)) {
        return [parsed];
      }

      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Known non-button directives that use `[[...]]` syntax and should
 * not be treated as inline button JSON. These contain colons, which
 * valid button JSON never has at the top level of a bracket marker.
 */
const KNOWN_DIRECTIVE_PATTERN = /^\s*[a-z_]+:/;

/**
 * Find the closing `]]` for an opening `[[` using bracket-aware scanning.
 *
 * The inner content between `[[` and `]]` can be any valid JSON that
 * includes nested brackets (arrays `[...]`), curly braces `{...}`, and
 * strings with escaped characters. The scanner tracks both square-bracket
 * depth and curly-brace depth, plus string state, to correctly identify
 * the matching closing `]]`.
 *
 * For `[[{"text":"X","callback_data":"Y"}]]`, the inner JSON starts with
 * `{` (not `[`). Since `{` increases braceDepth, the inner `}` decreases
 * it, and the `]` that follows the JSON object is only recognized as the
 * closing `]]` marker when braceDepth has already reached 0 — preventing
 * the JSON object's internal `]` from being misidentified as the marker.
 *
 * For `[[[{"text":"X"}]]]`, the inner `[` increases bracketDepth to 1,
 * the inner `]` decreases it back to 0, then the next two `]` form `]]`.
 *
 * For `[[{"text":"X","callback_data":"Y"},{"text":"Z","callback_data":"W"}]]`,
 * braceDepth goes 0→1→1→1→0 after the JSON object array closes, and the
 * first `]` at bracketDepth=0 + braceDepth=0 pairs with the following `]`
 * to form the closing `]]`.
 */
function findClosingDoubleBracket(text: string, start: number): number {
  // bracketDepth tracks nesting of `[` and `]` inside the marker.
  // braceDepth tracks nesting of `{` and `}` inside the marker.
  // Both start at 0 because we are past the opening `[[`.
  // The inner JSON may contain `[...]` arrays and `{...}` objects.
  // The closing `]]` is found when we see `]` with both depths at 0
  // AND the next character is also `]`.
  let bracketDepth = 0;
  let braceDepth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "[") {
      bracketDepth++;
    } else if (ch === "]") {
      if (bracketDepth > 0) {
        bracketDepth--;
      } else if (braceDepth === 0) {
        // bracketDepth=0 and braceDepth=0, so this `]` is the first
        // of `]]` closing the marker. Confirm the next character is `]`.
        if (i + 1 < text.length && text[i + 1] === "]") {
          return i + 1; // position of the second `]` of `]]`
        }
        // Lone `]` at depth 0 without a following `]` — not a match.
        // Continue scanning (this might be mismatched brackets).
      }
      // If braceDepth > 0, this `]` is inside a JSON object context
      // and should not be treated as a closing marker. Skip it.
    } else if (ch === "{") {
      braceDepth++;
    } else if (ch === "}") {
      if (braceDepth > 0) {
        braceDepth--;
      }
    }
  }
  return -1;
}

/**
 * Scans text for double-bracket-wrapped JSON button arrays, extracts
 * valid button definitions, and returns cleaned text along with parsed
 * button rows.
 *
 * Handles all three common model-output formats:
 * - `[[{"text":"X","callback_data":"Y"}]]` — double bracket, inner JSON
 *   is an array of button objects (the primary format in the linked issue)
 * - `[[[{"text":"X","callback_data":"Y"}]]]` — triple bracket, inner JSON
 *   is an array of button objects
 * - `[[[{...}],[{...}]]]` — multi-row format with inner JSON array of arrays
 *
 * Known non-button directives like `[[tts:voice]]` and
 * `[[reply_to_current]]` are left untouched.
 */
export function extractInlineButtons(text: string): InlineButtonExtractResult {
  const buttons: ExtractedInlineButton[][] = [];
  const removals: string[] = [];

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const openIdx = text.indexOf("[[", searchFrom);
    if (openIdx === -1) break;

    const closeIdx = findClosingDoubleBracket(text, openIdx + 2);
    if (closeIdx === -1) {
      searchFrom = openIdx + 2;
      continue;
    }

    // fullMatch includes `[[` through `]]`
    // closeIdx points to the second `]` of the closing `]]`, so the
    // full marker spans openIdx..closeIdx inclusive.
    const fullMatch = text.slice(openIdx, closeIdx + 1);
    // innerText is the content between `[[` and `]]`, exclusive of both
    // markers. closeIdx is the second `]`, so the first `]` is at
    // closeIdx-1; innerText stops before that first closing `]`.
    const innerText = text.slice(openIdx + 2, closeIdx - 1);

    // Skip known non-button directives like [[tts:voice]]
    if (KNOWN_DIRECTIVE_PATTERN.test(innerText.trim())) {
      searchFrom = closeIdx + 1;
      continue;
    }

    const rows = parseButtonRows(innerText);
    if (rows) {
      for (const row of rows) {
        buttons.push(row);
      }
      removals.push(fullMatch);
    }

    searchFrom = closeIdx + 1;
  }

  // Remove all matched button markers from the text.
  // Replace from longest to shortest to avoid partial overlaps.
  // Use split+join instead of replace to handle all occurrences.
  let cleaned = text;
  for (const match of removals) {
    cleaned = cleaned.split(match).join("");
  }

  // Clean up excessive whitespace left by removed markers
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return { text: cleaned, buttons };
}
