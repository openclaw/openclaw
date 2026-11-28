import type { DeveloperRange } from "./dictation-developer-types.ts";

export type DeveloperToken = DeveloperRange & { text: string; quoted: boolean };

function regexLiteralEnd(source: string, start: number): { end?: number; scannedEnd: number } {
  let inClass = false;
  for (let cursor = start + 1; cursor < source.length; cursor++) {
    const char = source[cursor];
    if (char === "\n" || char === "\r") {
      return { scannedEnd: cursor };
    }
    if (char === "\\") {
      cursor++;
    } else if (char === "[") {
      inClass = true;
    } else if (char === "]") {
      inClass = false;
    } else if (char === "/" && !inClass) {
      let end = cursor + 1;
      while (end < source.length && /[a-z]/iu.test(source[end]!)) {
        end++;
      }
      return { end, scannedEnd: end };
    }
  }
  return { scannedEnd: source.length };
}

/** Quoted text is one opaque token, including unterminated quoted fragments. */
export function lexDeveloperText(source: string): DeveloperToken[] {
  const tokens: DeveloperToken[] = [];
  let cursor = 0;
  let regexScanFloor = 0;
  while (cursor < source.length) {
    if (/\s/u.test(source[cursor]!)) {
      cursor++;
      continue;
    }
    const start = cursor;
    let quoted = false;
    while (cursor < source.length && !/\s/u.test(source[cursor]!)) {
      const char = source[cursor]!;
      // Closed slash literals are opaque even in prose or after spoken operators.
      // A slash pair ambiguous with division stays literal; spoken slash commands
      // make arithmetic explicit. Each failed scan advances the floor, so hostile
      // unterminated character classes cannot cause repeated suffix scans.
      if (
        char === "/" &&
        source[cursor - 1] !== "/" &&
        source[cursor + 1] !== "/" &&
        source[cursor + 1] !== "*" &&
        cursor >= regexScanFloor
      ) {
        const regex = regexLiteralEnd(source, cursor);
        regexScanFloor = regex.scannedEnd;
        if (regex.end !== undefined) {
          quoted = true;
          cursor = regex.end;
          continue;
        }
      }
      const quote = char === "“" ? "”" : char === "‘" ? "’" : char;
      // Apostrophes inside ordinary words are not quote delimiters.
      const pythonPrefix = /(?:^|[^\p{L}\p{M}\p{N}_])(?:r|b|u|f|fr|rf|br|rb)$/iu.test(
        source.slice(Math.max(start, cursor - 4), cursor),
      );
      if (
        (char === '"' || char === "`" || char === "“" || char === "‘" || char === "'") &&
        !(char === "'" && cursor > start && !pythonPrefix && /\p{L}/u.test(source[cursor - 1]!))
      ) {
        quoted = true;
        const delimiter =
          (char === "'" || char === '"') && source.startsWith(char.repeat(3), cursor)
            ? quote.repeat(3)
            : quote;
        cursor += delimiter.length;
        while (cursor < source.length) {
          if (source[cursor] === "\\") {
            cursor = Math.min(cursor + 2, source.length);
          } else if (source.startsWith(delimiter, cursor)) {
            cursor += delimiter.length;
            break;
          } else {
            cursor++;
          }
        }
      } else {
        cursor++;
      }
    }
    tokens.push({ text: source.slice(start, cursor), start, end: cursor, quoted });
  }
  return tokens;
}

export function matchesPhrase(
  tokens: readonly DeveloperToken[],
  at: number,
  phrase: string,
): number {
  const words = phrase.split(" ");
  return words.every(
    (word, index) => !tokens[at + index]?.quoted && tokens[at + index]?.text.toLowerCase() === word,
  )
    ? words.length
    : 0;
}

export function findPhrase(
  tokens: readonly DeveloperToken[],
  start: number,
  end: number,
  phrase: string,
): number {
  for (let index = start; index < end; index++) {
    const size = matchesPhrase(tokens, index, phrase);
    if (size && index + size <= end) {
      return index;
    }
  }
  return -1;
}

export function exactDeveloperToken(token: DeveloperToken): boolean {
  return token.quoted || /[\d_./\\@:$=<>\p{Lu}]|[^\p{L}\p{M}]|^[a-f]{16,128}$/u.test(token.text);
}

export function developerGraphemeBoundaries(source: string): ReadonlySet<number> {
  const boundaries = new Set<number>([0, source.length]);
  for (const segment of new Intl.Segmenter("en-US", { granularity: "grapheme" }).segment(source)) {
    boundaries.add(segment.index);
  }
  return boundaries;
}
