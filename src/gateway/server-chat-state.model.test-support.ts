import {
  normalizeLiveAssistantBufferedText,
  projectLiveAssistantBufferedText,
} from "./live-chat-projector.js";

export type ModelOccurrence = {
  id?: string;
  native?: string;
  group?: string;
  text: string;
  retired: boolean;
  evicted?: boolean;
};
export type AvailableAssistantPart = {
  owner?: ModelOccurrence;
  separatorFor?: string;
  text: string;
  evicted?: boolean;
};
export type CharacterRun = { character: string; minimum: number; maximum: number };

export function assistantTextDifference(
  actual: string,
  expected: string,
  context: string,
): string | undefined {
  if (actual === expected) {
    return undefined;
  }
  let divergence = 0;
  while (
    divergence < actual.length &&
    divergence < expected.length &&
    actual[divergence] === expected[divergence]
  ) {
    divergence++;
  }
  return `${context} ${JSON.stringify({
    actualLength: actual.length,
    expectedLength: expected.length,
    divergence,
    actual: actual.slice(divergence, divergence + 40),
    expected: expected.slice(divergence, divergence + 40),
  })}`;
}

// Classification uses the complete available source. Retirement selects raw
// occurrence chunks; normalizing that tail deliberately does not classify it again.
export const projectAvailableParts = (
  parts: AvailableAssistantPart[],
  tail: string,
  final: boolean,
  managedMediaUrls: string[],
  contextEvicted: boolean,
) => {
  const source = parts.map((part) => part.text).join("");
  const options = { final, managedMediaUrls };
  const classified = projectLiveAssistantBufferedText(
    normalizeLiveAssistantBufferedText(source, options),
    { suppressLeadFragments: !final },
  );
  const displayText = contextEvicted
    ? tail
    : classified.suppress
      ? ""
      : tail === source
        ? classified.text
        : normalizeLiveAssistantBufferedText(tail, options);
  return { ...classified, displayText };
};

export const paragraphSeparator = (before: string, after: string) => {
  const trailing = before.endsWith("\n\n") ? 2 : before.endsWith("\n") ? 1 : 0;
  const leading = after.startsWith("\n\n") ? 2 : after.startsWith("\n") ? 1 : 0;
  return "\n".repeat(Math.max(0, 2 - trailing - leading));
};
export const joinOccurrences = (entries: ModelOccurrence[]) => {
  let text = "";
  let native: string | undefined;
  for (const entry of entries) {
    if (!entry.text) {
      continue;
    }
    const group = entry.group ?? entry.native;
    if (text && group !== undefined && group !== native) {
      text += paragraphSeparator(text, entry.text);
    }
    text += entry.text;
    native = group;
  }
  return text;
};

export const appendCharacterRuns = (runs: CharacterRun[], text: string, required: boolean) => {
  for (let start = 0; start < text.length;) {
    const character = text[start]!;
    let end = start + 1;
    while (end < text.length && text[end] === character) {
      end++;
    }
    const length = end - start;
    const previous = runs.at(-1);
    if (previous?.character === character) {
      previous.minimum += required ? length : 0;
      previous.maximum += length;
    } else {
      runs.push({ character, minimum: required ? length : 0, maximum: length });
    }
    start = end;
  }
};
// Recognize source order with only committed bytes and presentation separators
// optional. Run-length intervals avoid backtracking over the 600k fixtures.
export const preservesAvailableText = (source: CharacterRun[], actual: string) => {
  const actualRuns: CharacterRun[] = [];
  appendCharacterRuns(actualRuns, actual, true);
  let positions = new Map<number, Array<[number, number]>>([[0, [[0, 0]]]]);
  for (const run of source) {
    const next = new Map<number, Array<[number, number]>>();
    const retain = (index: number, low: number, high: number) => {
      if (low <= high) {
        const ranges = next.get(index) ?? [];
        ranges.push([low, high]);
        next.set(index, ranges);
      }
    };
    for (const [index, ranges] of positions) {
      const current = actualRuns[index];
      for (const [low, high] of ranges) {
        if (run.minimum === 0) {
          retain(index, low, high);
        }
        if (current?.character !== run.character) {
          continue;
        }
        const from = low + Math.max(1, run.minimum);
        const through = Math.min(current.maximum, high + run.maximum);
        retain(index, from, Math.min(through, current.maximum - 1));
        if (from <= current.maximum && through === current.maximum) {
          retain(index + 1, 0, 0);
        }
      }
    }
    for (const [index, ranges] of next) {
      const merged: Array<[number, number]> = [];
      for (const range of ranges.toSorted((left, right) => left[0] - right[0])) {
        const previous = merged.at(-1);
        if (previous && range[0] <= previous[1] + 1) {
          previous[1] = Math.max(previous[1], range[1]);
        } else {
          merged.push(range);
        }
      }
      next.set(index, merged);
    }
    positions = next;
    if (positions.size === 0) {
      return false;
    }
  }
  return positions.has(actualRuns.length);
};
