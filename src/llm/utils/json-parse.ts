import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
const JSON_CONTROL_ESCAPES = new Set(["b", "f", "n", "r", "t"]);
const DECODED_WINDOWS_PATH_ESCAPES = new Map([
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
]);

function isControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
  switch (char) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
  }
}

function isLikelyWindowsPathPrefix(value: string): boolean {
  return /^[A-Za-z]:(?:[\\/].*)?$/u.test(value);
}

function normalizeDecodedWindowsPathEscapes(value: unknown): unknown {
  if (typeof value === "string") {
    if (!/^[A-Za-z]:[\\/\b\f\n\r\t]/u.test(value)) {
      return value;
    }
    return value.replace(
      /[\b\f\n\r\t]/gu,
      (char) => DECODED_WINDOWS_PATH_ESCAPES.get(char) ?? char,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeDecodedWindowsPathEscapes(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeDecodedWindowsPathEscapes(item)]),
    );
  }
  return value;
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
  let repaired = "";
  let inString = false;
  let stringPrefix = "";

  for (let index = 0; index < json.length; index++) {
    const char = json[index];

    if (!inString) {
      repaired += char;
      if (char === '"') {
        inString = true;
        stringPrefix = "";
      }
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      stringPrefix = "";
      continue;
    }

    if (char === "\\") {
      const nextChar = json[index + 1];
      if (nextChar === undefined) {
        repaired += "\\\\";
        stringPrefix += "\\";
        continue;
      }

      if (nextChar === "u") {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          stringPrefix += String.fromCodePoint(Number.parseInt(unicodeDigits, 16));
          index += 5;
          continue;
        }
        // A \u not followed by four hex digits is an invalid escape: double the
        // backslash like the other invalid escapes below. Falling through would
        // hit the valid-escape branch (VALID_JSON_ESCAPES contains "u") and
        // re-emit the broken \u, leaving the JSON unparseable.
        repaired += "\\\\";
        stringPrefix += "\\";
        continue;
      }

      if (JSON_CONTROL_ESCAPES.has(nextChar) && isLikelyWindowsPathPrefix(stringPrefix)) {
        repaired += "\\\\";
        stringPrefix += "\\";
        continue;
      }

      if (VALID_JSON_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        stringPrefix += nextChar;
        index += 1;
        continue;
      }

      repaired += "\\\\";
      stringPrefix += "\\";
      continue;
    }

    repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
    stringPrefix += char;
  }

  return repaired;
}

export function parseJsonWithRepair(
  json: string,
  options?: { normalizeWindowsPathEscapes?: boolean },
): unknown {
  const normalize = (value: unknown): unknown =>
    options?.normalizeWindowsPathEscapes ? normalizeDecodedWindowsPathEscapes(value) : value;

  try {
    return normalize(JSON.parse(json) as unknown);
  } catch (error) {
    const repairedJson = repairJson(json);
    if (repairedJson !== json) {
      return normalize(JSON.parse(repairedJson) as unknown);
    }
    throw error;
  }
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson(partialJson: string | undefined): Record<string, unknown> {
  if (!partialJson || partialJson.trim() === "") {
    return {};
  }

  try {
    return parseJsonWithRepair(partialJson, {
      normalizeWindowsPathEscapes: true,
    }) as Record<string, unknown>;
  } catch {
    try {
      const result = partialParse(partialJson);
      return normalizeDecodedWindowsPathEscapes(result ?? {}) as Record<string, unknown>;
    } catch {
      try {
        const result = partialParse(repairJson(partialJson));
        return normalizeDecodedWindowsPathEscapes(result ?? {}) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
  }
}
