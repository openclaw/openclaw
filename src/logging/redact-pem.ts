import type { RedactMatch, ResolvedRedactPattern } from "./redact-pattern-runtime.js";

export const PEM_REDACT_PATTERN_SOURCE = String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`;

type Delimiter = { kind: "begin" | "end"; start: number; end: number };
type Scanner = {
  offset: number;
  phase: "search" | "keyword" | "label" | "close";
  dashes: number;
  keyword: "BEGIN " | "END ";
  keywordOffset: number;
  start: number;
  suffix: string;
};
type PemState = {
  scanner: Scanner;
  open?: { start: number; end: number };
  matchEnd: number;
};

function createState(): PemState {
  return {
    scanner: {
      offset: 0,
      phase: "search",
      dashes: 0,
      keyword: "BEGIN ",
      keywordOffset: 0,
      start: 0,
      suffix: "",
    },
    matchEnd: 0,
  };
}

function resetScanner(scanner: Scanner, char: string): void {
  scanner.phase = "search";
  scanner.dashes = char === "-" ? 1 : 0;
  scanner.suffix = "";
}

function* readDelimiters(text: string, scanner: Scanner): Iterable<Delimiter> {
  for (let index = 0; index < text.length; index += 1) {
    if (scanner.phase === "search" && scanner.dashes === 0) {
      const nextDash = text.indexOf("-", index);
      if (nextDash === -1) {
        scanner.offset += text.length - index;
        return;
      }
      scanner.offset += nextDash - index;
      index = nextDash;
    }
    const code = text.charCodeAt(index);
    const char = code >= 97 && code <= 122 ? String.fromCharCode(code - 32) : text.charAt(index);
    const offset = scanner.offset++;
    switch (scanner.phase) {
      case "search":
        if (char === "-") {
          scanner.dashes = Math.min(5, scanner.dashes + 1);
        } else if (scanner.dashes === 5 && (char === "B" || char === "E")) {
          scanner.phase = "keyword";
          scanner.keyword = char === "B" ? "BEGIN " : "END ";
          scanner.keywordOffset = 1;
          scanner.start = offset - 5;
        } else {
          scanner.dashes = 0;
        }
        break;
      case "keyword":
        if (char !== scanner.keyword.charAt(scanner.keywordOffset)) {
          resetScanner(scanner, char);
        } else if (++scanner.keywordOffset === scanner.keyword.length) {
          scanner.phase = "label";
          scanner.suffix = "";
        }
        break;
      case "label":
        if ((char >= "A" && char <= "Z") || char === " ") {
          // The label is unbounded; only its fixed terminal phrase matters.
          scanner.suffix = (scanner.suffix + char).slice(-"PRIVATE KEY".length);
        } else if (char === "-" && scanner.suffix === "PRIVATE KEY") {
          scanner.phase = "close";
          scanner.dashes = 1;
        } else {
          resetScanner(scanner, char);
        }
        break;
      case "close":
        if (char !== "-") {
          resetScanner(scanner, char);
        } else if (++scanner.dashes === 5) {
          scanner.phase = "search";
          scanner.suffix = "";
          // An unmatched delimiter can share these dashes with the next opener.
          yield {
            kind: scanner.keyword === "BEGIN " ? "begin" : "end",
            start: scanner.start,
            end: offset + 1,
          };
        }
        break;
    }
  }
}

function consumeDelimiter(
  state: PemState,
  delimiter: Delimiter,
): { start: number; end: number; bodyStart: number; bodyEnd: number } | undefined {
  if (!state.open) {
    if (delimiter.kind === "begin" && delimiter.start >= state.matchEnd) {
      state.open = { start: delimiter.start, end: delimiter.end };
    }
    return undefined;
  }
  // The public expression requires at least one character between delimiters.
  if (delimiter.kind !== "end" || delimiter.start <= state.open.end) {
    return undefined;
  }
  const block = {
    start: state.open.start,
    end: delimiter.end,
    bodyStart: state.open.end,
    bodyEnd: delimiter.start,
  };
  state.open = undefined;
  state.matchEnd = delimiter.end;
  return block;
}

function* matchPem(text: string, context: PemState, incomplete: boolean): Iterable<RedactMatch> {
  const state: PemState = {
    ...context,
    scanner: { ...context.scanner },
    open: context.open && { ...context.open },
  };
  const origin = state.scanner.offset;
  for (const delimiter of readDelimiters(text, state.scanner)) {
    const block = consumeDelimiter(state, delimiter);
    if (!block) {
      continue;
    }
    const start = Math.max(0, (incomplete ? block.bodyStart : block.start) - origin);
    const end = (incomplete ? block.bodyEnd : block.end) - origin;
    if (end <= start) {
      continue;
    }
    yield {
      match: text.slice(start, end),
      groups: [],
      input: text,
      offset: start,
      ...(incomplete ? { replacement: "…redacted…" } : {}),
    };
  }
  if (incomplete && state.open) {
    const start = Math.max(0, state.open.end - origin);
    if (start < text.length) {
      yield {
        match: text.slice(start),
        groups: [],
        input: text,
        offset: start,
        replacement: "…redacted…",
      };
    }
  }
}

export const PEM_REDACT_MATCHER = {
  source: PEM_REDACT_PATTERN_SOURCE,
  exec(text: string): Iterable<RedactMatch> {
    return matchPem(text, createState(), false);
  },
  createContext(): {
    pattern: ResolvedRedactPattern;
    prepend: () => { consume: (text: string) => void; finish: () => boolean };
  } {
    let whenClosed = false;
    let whenOpen = true;
    return {
      prepend() {
        const closed = createState();
        const open = createState();
        open.open = { start: -1, end: -1 };
        return {
          consume(text) {
            for (const delimiter of readDelimiters(text, closed.scanner)) {
              consumeDelimiter(closed, delimiter);
              consumeDelimiter(open, delimiter);
            }
          },
          finish() {
            // At a newline boundary only open/closed survives. Compose this earlier
            // block with the suffix for both possible histories, including overlaps.
            const nextClosed = closed.open ? whenOpen : whenClosed;
            const nextOpen = open.open ? whenOpen : whenClosed;
            whenClosed = nextClosed;
            whenOpen = nextOpen;
            return whenClosed === whenOpen;
          },
        };
      },
      pattern: {
        source: PEM_REDACT_PATTERN_SOURCE,
        exec(text) {
          const state = createState();
          if (whenClosed) {
            state.open = { start: -1, end: -1 };
          }
          return matchPem(text, state, true);
        },
      },
    };
  },
};
