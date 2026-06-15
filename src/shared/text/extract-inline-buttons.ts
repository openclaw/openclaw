/**
 * Extracts inline button JSON arrays from model-generated text.
 *
 * Some models (e.g. Gemini) output button definitions like
 * `[[{"text":"Label","callback_data":"data"}]]` as raw text instead
 * of using the message tool's `buttons` parameter. This helper scans
 * for well-formed button JSON inside double-bracket markers, removes
 * the marker text, and returns extracted button rows.
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

function isValidButtonArray(value: unknown): value is ExtractedInlineButton[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      typeof (item as Record<string, unknown>).text === "string" &&
      ((item as Record<string, unknown>).text as string).length > 0 &&
      typeof (item as Record<string, unknown>).callback_data === "string" &&
      ((item as Record<string, unknown>).callback_data as string).length > 0,
  );
}

/**
 * Parse the inner content of `[[...]]` as button rows.
 * Handles both single-row `[{...}]` and multi-row `[[{...}],[{...}]]` formats.
 */
function parseButtonRows(innerText: string): ExtractedInlineButton[][] | null {
  try {
    const parsed = JSON.parse(innerText.trim());
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    // Multi-row format: each element is itself an array of buttons
    if (parsed.every((row) => Array.isArray(row))) {
      const rows = parsed as unknown[][];
      const allValid = rows.every(
        (row) =>
          Array.isArray(row) &&
          row.length > 0 &&
          row.every(
            (btn) =>
              typeof btn === "object" &&
              btn !== null &&
              !Array.isArray(btn) &&
              typeof (btn as Record<string, unknown>).text === "string" &&
              ((btn as Record<string, unknown>).text as string).length > 0 &&
              typeof (btn as Record<string, unknown>).callback_data === "string" &&
              ((btn as Record<string, unknown>).callback_data as string).length > 0,
          ),
      );
      if (allValid) {
        return rows.map((row) =>
          row.map((btn) => btn as unknown as ExtractedInlineButton),
        );
      }
      return null;
    }

    // Single-row format: array of button objects
    if (isValidButtonArray(parsed)) {
      return [parsed];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Find matching `]]` for a `[[` opening using bracket-aware scanning.
 * When `[[` is followed by a JSON array `[...]`, the inner brackets
 * must be balanced before the closing `]]` is reached.
 */
function findClosingDoubleBracket(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length - 1; i++) {
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
      depth++;
    } else if (ch === "]") {
      depth--;
      // When depth reaches 0, the next char should also be `]` for `]]`
      if (depth === 0 && i + 1 < text.length && text[i + 1] === "]") {
        return i + 1; // position of the second `]`
      }
    }
  }
  return -1;
}

/**
 * Scans text for double-bracket-wrapped JSON button arrays, extracts
 * valid button definitions, and returns cleaned text along with parsed
 * button rows.
 */
export function extractInlineButtons(text: string): InlineButtonExtractResult {
  const buttons: ExtractedInlineButton[][] = [];
  let cleaned = text;

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const openIdx = text.indexOf("[[", searchFrom);
    if (openIdx === -1) break;

    const closeIdx = findClosingDoubleBracket(text, openIdx + 2);
    if (closeIdx === -1) {
      searchFrom = openIdx + 2;
      continue;
    }

    // Extract content between `[[` and `]]` (exclusive).
    // closeIdx points to the second `]` of `]]`, and slice end is exclusive,
    // so end=closeIdx captures everything up to (but not including) that `]`.
    const innerText = text.slice(openIdx + 2, closeIdx);
    // fullMatch includes the opening `[[` through closing `]]`
    const fullMatch = text.slice(openIdx, closeIdx + 1);

    const rows = parseButtonRows(innerText);
    if (rows) {
      for (const row of rows) {
        buttons.push(row);
      }
      cleaned = cleaned.replace(fullMatch, "");
    }

    searchFrom = closeIdx + 1;
  }

  // Clean up excessive whitespace left by removed markers
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return { text: cleaned, buttons };
}
