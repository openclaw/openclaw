import type { RedactMatch, ResolvedRedactPattern } from "./redact-pattern-runtime.js";
import {
  base64SafeToken,
  CONFIG_ASSIGNMENT_SECRET_KEYS,
  CONFIG_PREFIXED_PASSWORD_ASSIGNMENT_SECRET_KEYS,
  CONFIG_QUOTED_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_QUOTED_ASSIGNMENT_SECRET_KEYS,
  FORM_BODY_FIRST_PAIR_KEYS,
  STANDALONE_ASSIGNMENT_QUOTED_REDACT_PATTERN,
  STANDALONE_ASSIGNMENT_SECRET_KEYS,
} from "./redact-patterns.js";

/*
 * Linear matchers for default rules whose regex cost is quadratic in long character runs,
 * or whose unbounded repeats overflow the backtrack stack on multi-megabyte values. Each
 * matcher yields exactly the matches its source regex yields, in the same order and with
 * the same capture shape, while reading every character region a bounded number of times.
 *
 * All matcher state lives inside one exec() call, so nested redaction calls never share it.
 */

const JS_WHITESPACE_CODES = new Set([
  9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279,
]);

function isJsWhitespaceAt(text: string, index: number): boolean {
  if (index >= text.length) {
    return false;
  }
  const code = text.charCodeAt(index);
  return JS_WHITESPACE_CODES.has(code) || (code >= 0x2000 && code <= 0x200a);
}

function isJsWhitespaceChar(char: string | undefined): boolean {
  return char !== undefined && isJsWhitespaceAt(char, 0);
}

function isAlnumChar(char: string | undefined): boolean {
  if (char === undefined) {
    return false;
  }
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isLetterChar(char: string | undefined): boolean {
  if (char === undefined) {
    return false;
  }
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isWordChar(char: string | undefined): boolean {
  return char === "_" || isAlnumChar(char);
}

function isHexChar(char: string | undefined): boolean {
  if (char === undefined) {
    return false;
  }
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function isDigitChar(char: string | undefined): boolean {
  return char !== undefined && char.charCodeAt(0) >= 48 && char.charCodeAt(0) <= 57;
}

function isBase64UrlChar(char: string | undefined): boolean {
  return isAlnumChar(char) || char === "+" || char === "/" || char === "=";
}

const prefixRegexPools = new Map<string, RegExp[]>();

/** Reuse compiled prefixes without sharing mutable lastIndex with a reentrant scan. */
function* scanPrefixOccurrences(text: string, prefix: string): Generator<number> {
  let pool = prefixRegexPools.get(prefix);
  if (!pool) {
    pool = [];
    prefixRegexPools.set(prefix, pool);
  }
  const re = pool.pop() ?? new RegExp(prefix, "gi");
  try {
    re.lastIndex = 0;
    for (let match = re.exec(text); match; match = re.exec(text)) {
      yield match.index;
    }
  } finally {
    re.lastIndex = 0;
    pool.push(re);
  }
}

/** The `;base64,` exemption under the shared case-insensitive compilation of these rules. */
function isDataUrlPrefix(text: string, runStart: number): boolean {
  return runStart >= 8 && text.slice(runStart - 8, runStart).toLowerCase() === ";base64,";
}

type Base64SafeTokenEnd = (text: string, start: number) => number | null;

function runEndOf(
  text: string,
  start: number,
  isMember: (char: string | undefined) => boolean,
): number {
  let end = start;
  while (end < text.length && isMember(text[end])) {
    end += 1;
  }
  return end;
}

/**
 * Shared matcher for the `BASE64_SAFE_TOKEN_BOUNDARY` vendor rules. The boundary group is
 * checked per candidate in O(1); the `(?<!;base64,[A-Za-z0-9+/=]*)` exemption walks each
 * base64 run once because candidates advance left to right and share runs, replacing the
 * unbounded lookbehind that rescanned the whole run from every candidate. The token-end
 * function is created per exec() call so concurrent redactions never share scanner state.
 */
function makeBase64SafeTokenMatcher(
  source: string,
  prefix: string,
  makeTokenEnd: () => Base64SafeTokenEnd,
) {
  function* exec(text: string): Iterable<RedactMatch> {
    const tokenEnd = makeTokenEnd();
    // Maximal [A-Za-z0-9+/=] run ending at the latest candidate's boundary position.
    let runStart = -1;
    let runEnd = -1;
    let searchFloor = 0;
    for (const candidate of scanPrefixOccurrences(text, prefix)) {
      if (candidate < searchFloor) {
        continue;
      }
      if (candidate > 0 && isAlnumChar(text[candidate - 1])) {
        continue;
      }
      if (candidate > 0) {
        let runAtCandidate: number;
        if (isBase64UrlChar(text[candidate - 1])) {
          if (candidate - 1 >= runStart && candidate - 1 < runEnd) {
            runAtCandidate = runStart;
          } else {
            let walk = candidate - 1;
            while (walk > 0 && isBase64UrlChar(text[walk - 1])) {
              walk -= 1;
            }
            runStart = walk;
            runEnd = runEndOf(text, candidate, isBase64UrlChar);
            runAtCandidate = walk;
          }
        } else {
          // A boundary character outside the base64 class leaves no run to exempt.
          runAtCandidate = candidate;
        }
        if (isDataUrlPrefix(text, runAtCandidate)) {
          continue;
        }
      }
      const end = tokenEnd(text, candidate);
      if (end === null) {
        continue;
      }
      const matchStart = candidate > 0 ? candidate - 1 : 0;
      yield {
        match: text.slice(matchStart, end),
        groups: [candidate > 0 ? text[candidate - 1]! : "", text.slice(candidate, end)],
        input: text,
        offset: matchStart,
      };
      searchFloor = end + 1;
    }
  }
  return Object.freeze({ source, exec });
}

const GAAAA_VALUE_CHAR = (char: string | undefined): boolean =>
  isAlnumChar(char) || char === "_" || char === "=" || char === "-";
const ATBB_VALUE_CHAR = (char: string | undefined): boolean =>
  isAlnumChar(char) || char === "_" || char === "=" || char === "." || char === "-";
const AT_VALUE_CHAR = (char: string | undefined): boolean =>
  isAlnumChar(char) || char === "+" || char === "/" || char === "=" || char === "-" || char === "_";

function fixedTailTokenEnd(
  tailStart: number,
  tailLength: number,
  isMember: (char: string | undefined) => boolean,
): Base64SafeTokenEnd {
  return (text, start) => {
    const end = start + tailStart + tailLength;
    for (let index = start + tailStart; index < end; index++) {
      if (!isMember(text[index])) {
        return null;
      }
    }
    return end;
  };
}

/** `dapi` + 32 hex digits + an optional `-<digit>`; the optional tail is greedy like the regex. */
function dapiTokenEnd(text: string, start: number): number | null {
  const bodyEnd = start + 4 + 32;
  for (let index = start + 4; index < bodyEnd; index++) {
    if (!isHexChar(text[index])) {
      return null;
    }
  }
  if (text[bodyEnd] === "-" && isDigitChar(text[bodyEnd + 1])) {
    return bodyEnd + 2;
  }
  return bodyEnd;
}

/**
 * `ATCTT3xFfG`/`ATATT` value: one or more class characters, then `=`, then exactly eight
 * alphanumerics. Greedy backtracking lands on the rightmost `=` in the run whose next
 * eight characters are alphanumerics; each run is scanned once and candidates share it.
 */
function makeAtEqualsTokenMatcher(source: string, prefix: string) {
  const prefixLength = prefix.length;
  return makeBase64SafeTokenMatcher(source, prefix, () => {
    let runStart = -1;
    let runEnd = -1;
    let equals: number[] = [];
    return (text: string, start: number): number | null => {
      const valueStart = start + prefixLength;
      if (valueStart < runStart || valueStart >= runEnd) {
        runEnd = runEndOf(text, valueStart, AT_VALUE_CHAR);
        runStart = valueStart;
        equals = [];
        for (let index = valueStart; index < runEnd; index++) {
          if (
            text[index] === "=" &&
            index + 9 <= text.length &&
            isAlnumChar(text[index + 1]) &&
            isAlnumChar(text[index + 2]) &&
            isAlnumChar(text[index + 3]) &&
            isAlnumChar(text[index + 4]) &&
            isAlnumChar(text[index + 5]) &&
            isAlnumChar(text[index + 6]) &&
            isAlnumChar(text[index + 7]) &&
            isAlnumChar(text[index + 8])
          ) {
            equals.push(index);
          }
        }
      }
      // Greedy backtracking lands on the rightmost valid split, and later candidates in the
      // same run only raise the minimum, so the largest entry is always the answer.
      const minimum = valueStart + 1;
      const split = equals[equals.length - 1];
      return split !== undefined && split >= minimum ? split + 9 : null;
    };
  });
}

const GAAAA_TOKEN_MATCHER = makeBase64SafeTokenMatcher(
  "vendor-token gAAAA (linear)",
  "gAAAA",
  () => (text, start) => {
    const end = runEndOf(text, start + 5, GAAAA_VALUE_CHAR);
    return end - (start + 5) >= 20 ? end : null;
  },
);
const ATBB_TOKEN_MATCHER = makeBase64SafeTokenMatcher(
  "vendor-token ATBB (linear)",
  "ATBB",
  () => (text, start) => {
    const end = runEndOf(text, start + 4, ATBB_VALUE_CHAR);
    return end - (start + 4) >= 16 ? end : null;
  },
);
const AKIA_TOKEN_MATCHER = makeBase64SafeTokenMatcher("vendor-token AKIA (linear)", "AKIA", () =>
  fixedTailTokenEnd(4, 16, isAlnumChar),
);
const ASIA_TOKEN_MATCHER = makeBase64SafeTokenMatcher("vendor-token ASIA (linear)", "ASIA", () =>
  fixedTailTokenEnd(4, 16, isAlnumChar),
);
const DAPI_TOKEN_MATCHER = makeBase64SafeTokenMatcher(
  "vendor-token dapi (linear)",
  "dapi",
  () => dapiTokenEnd,
);
const ATCTT_TOKEN_MATCHER = makeAtEqualsTokenMatcher(
  "vendor-token ATCTT3xFfG (linear)",
  "ATCTT3xFfG",
);
const ATATT_TOKEN_MATCHER = makeAtEqualsTokenMatcher("vendor-token ATATT (linear)", "ATATT");

const JWT_REDACT_PATTERN = String.raw`(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`;
const JWT_SEGMENT_CHAR = (char: string | undefined): boolean =>
  isAlnumChar(char) || char === "_" || char === "-";

/** JWT rule: each `eyJ` candidate parses its three segments forward; class runs are shared. */
const JWT_MATCHER = Object.freeze({
  source: "jwt (linear)",
  *exec(text: string): Iterable<RedactMatch> {
    // Run caches are per-segment: scanning the second or third segment must not invalidate
    // the first segment's cache, or candidates that share one long first segment rescan it
    // for every occurrence (quadratic work on adversarial input like "eyJ".repeat(N)).
    const firstRun = { start: -1, end: -1 };
    const secondRun = { start: -1, end: -1 };
    const thirdRun = { start: -1, end: -1 };
    const segmentEnd = (position: number, run: { start: number; end: number }): number => {
      if (position >= run.start && position < run.end) {
        return run.end;
      }
      const end = runEndOf(text, position, JWT_SEGMENT_CHAR);
      run.start = position;
      run.end = end;
      return end;
    };
    let searchFloor = 0;
    for (const candidate of scanPrefixOccurrences(text, "eyj")) {
      if (candidate < searchFloor) {
        continue;
      }
      const firstEnd = segmentEnd(candidate + 3, firstRun);
      if (firstEnd - (candidate + 3) < 10 || text[firstEnd] !== ".") {
        continue;
      }
      const secondEnd = segmentEnd(firstEnd + 1, secondRun);
      if (secondEnd - (firstEnd + 1) < 10 || text[secondEnd] !== ".") {
        continue;
      }
      const thirdEnd = segmentEnd(secondEnd + 1, thirdRun);
      if (thirdEnd - (secondEnd + 1) < 10) {
        continue;
      }
      const token = text.slice(candidate, thirdEnd);
      yield { match: token, groups: [token], input: text, offset: candidate };
      searchFloor = thirdEnd;
    }
  },
});

const URL_USERINFO_REDACT_PATTERN = String.raw`\b(?:https?|wss?|ftp):\/\/[^\/\s:@]*:([^\/\s@]+)@`;
const CONNECTION_STRING_REDACT_PATTERN = String.raw`\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:\s/@]*:([^@\s]+)@`;
const URL_USERINFO_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp"]);
const CONNECTION_STRING_SCHEMES = new Set([
  "postgres",
  "postgresql",
  "mysql",
  "mongodb",
  "mongodb+srv",
  "redis",
  "rediss",
  "amqp",
  "amqps",
]);

/**
 * Shared matcher for the URL-userinfo and connection-string password rules. Both regexes are
 * deterministic parses (each character class excludes its own terminators), so every `://`
 * candidate parses forward once; failed password scans are memoized because later candidates
 * share their tail regions.
 */
function makeUserInfoMatcher(
  source: string,
  schemes: ReadonlySet<string>,
  isPassTerminator: (char: string | undefined) => boolean,
) {
  function* exec(text: string): Iterable<RedactMatch> {
    let searchFloor = 0;
    let failedPassScanEnd = -1;
    let separator = text.indexOf("://");
    while (separator !== -1) {
      let schemeStart = separator;
      while (schemeStart > 0 && isWordChar(text[schemeStart - 1])) {
        schemeStart -= 1;
      }
      // `mongodb+srv` carries a non-word `+`; extend the word run through that one shape.
      let scheme = text.slice(schemeStart, separator).toLowerCase();
      let matchStart = schemeStart;
      if (
        !schemes.has(scheme) &&
        schemeStart >= 8 &&
        scheme === "srv" &&
        text.slice(schemeStart - 8, schemeStart).toLowerCase() === "mongodb+"
      ) {
        // Only the actual `mongodb+srv` shape extends the word run; other suffixes after
        // `mongodb+` keep their original path and stay unmasked by the connection scanner.
        scheme = "mongodb+srv";
        matchStart = schemeStart - 8;
      }
      if (
        separator >= searchFloor &&
        schemes.has(scheme) &&
        (matchStart === 0 || !isWordChar(text[matchStart - 1]))
      ) {
        const userStart = separator + 3;
        let cursor = userStart;
        while (
          cursor < text.length &&
          text[cursor] !== ":" &&
          text[cursor] !== "/" &&
          text[cursor] !== "@" &&
          !isJsWhitespaceAt(text, cursor)
        ) {
          cursor += 1;
        }
        if (text[cursor] === ":") {
          const passStart = cursor + 1;
          if (passStart >= failedPassScanEnd) {
            const passEnd = runEndOf(text, passStart, (char) => !isPassTerminator(char));
            if (text[passEnd] === "@" && passEnd > passStart) {
              yield {
                match: text.slice(matchStart, passEnd + 1),
                groups: [text.slice(passStart, passEnd)],
                input: text,
                offset: matchStart,
              };
              searchFloor = passEnd + 1;
              separator = text.indexOf("://", passEnd + 1);
              continue;
            }
            failedPassScanEnd = passEnd;
          }
        }
      }
      separator = text.indexOf("://", separator + 1);
    }
  }
  return Object.freeze({ source, exec });
}

const URL_USERINFO_MATCHER = makeUserInfoMatcher(
  "url-userinfo (linear)",
  URL_USERINFO_SCHEMES,
  // `[^\/\s@]+` stops at a slash, whitespace, or the terminating `@`.
  (char) => char === "/" || char === "@" || isJsWhitespaceChar(char),
);
const CONNECTION_STRING_MATCHER = makeUserInfoMatcher(
  "connection-string (linear)",
  CONNECTION_STRING_SCHEMES,
  // `[^@\s]+` stops at whitespace or the terminating `@`; slashes stay inside the value.
  (char) => char === "@" || isJsWhitespaceChar(char),
);

const FORM_BODY_FIRST_PAIR_REDACT_PATTERN = String.raw`(^|[\s,;])(?:${FORM_BODY_FIRST_PAIR_KEYS})=([^&\s]+)(?=&[A-Za-z_][A-Za-z0-9_.-]*=)`;
const FORM_FIRST_PAIR_KEYS_RE = new RegExp(`^(?:${FORM_BODY_FIRST_PAIR_KEYS})$`, "i");
const FORM_FIRST_PAIR_KEY_CHAR = (char: string | undefined): boolean =>
  isAlnumChar(char) || char === "-" || char === "_";
const FORM_FIRST_PAIR_TAIL_CHAR = (char: string | undefined): boolean =>
  isAlnumChar(char) || char === "_" || char === "." || char === "-";

/** The lookahead `&[A-Za-z_][A-Za-z0-9_.-]*=` is a deterministic forward check. */
function isFormPairBoundary(text: string, ampersand: number): boolean {
  // The original lookahead requires a letter or underscore as the second key's first
  // character; digits do not start a form key, so `session=publicvalue&1=x` stays unmasked.
  const first = text[ampersand + 1];
  if (!(first !== undefined && (isLetterChar(first) || first === "_"))) {
    return false;
  }
  const keyEnd = runEndOf(text, ampersand + 2, FORM_FIRST_PAIR_TAIL_CHAR);
  return text[keyEnd] === "=";
}

/**
 * Form first-pair rule: the value class excludes `&` and whitespace, so the greedy value
 * always ends at the first `&` or whitespace and the lookahead is checked there alone;
 * per-candidate value runs are shared so long runs are read once.
 */
const FORM_BODY_FIRST_PAIR_MATCHER = Object.freeze({
  source: "form-body-first-pair (linear)",
  *exec(text: string): Iterable<RedactMatch> {
    let runStart = -1;
    let runEnd = -1;
    const valueEnd = (start: number): number => {
      if (start >= runStart && start < runEnd) {
        return runEnd;
      }
      const end = runEndOf(text, start, (char) => char !== "&" && !isJsWhitespaceChar(char));
      runStart = start;
      runEnd = end;
      return end;
    };
    let searchFloor = 0;
    let separator = text.indexOf("=");
    while (separator !== -1) {
      let keyStart = separator;
      while (keyStart > 0 && FORM_FIRST_PAIR_KEY_CHAR(text[keyStart - 1])) {
        keyStart -= 1;
      }
      const key = text.slice(keyStart, separator);
      if (
        separator >= searchFloor &&
        key.length > 0 &&
        FORM_FIRST_PAIR_KEYS_RE.test(key) &&
        (keyStart === 0 ||
          text[keyStart - 1] === "," ||
          text[keyStart - 1] === ";" ||
          isJsWhitespaceAt(text, keyStart - 1))
      ) {
        const start = separator + 1;
        const end = valueEnd(start);
        if (
          end > start &&
          end < text.length &&
          text[end] === "&" &&
          isFormPairBoundary(text, end)
        ) {
          const matchStart = keyStart > 0 ? keyStart - 1 : 0;
          yield {
            match: text.slice(matchStart, end),
            groups: [keyStart > 0 ? text[keyStart - 1]! : "", text.slice(start, end)],
            input: text,
            offset: matchStart,
          };
          searchFloor = end;
          separator = text.indexOf("=", end);
          continue;
        }
      }
      separator = text.indexOf("=", separator + 1);
    }
  },
});

const STANDALONE_QUOTED_PREFIX_SOURCE = String.raw`(^|[\s,;({\["])(?:${STANDALONE_ASSIGNMENT_SECRET_KEYS})=(["'\x60])`;
const CONFIG_QUOTED_PREFIX_SOURCE = String.raw`(^|[\s,{])(?:(?:${CONFIG_QUOTED_ASSIGNMENT_SECRET_KEYS})(?:\s*:\s*|\s+=\s*|=\s*)|[a-z0-9][a-z0-9._-]{0,79}[-_](?:${CONFIG_PREFIXED_PASSWORD_ASSIGNMENT_SECRET_KEYS})\s*[:=]\s*|[a-z0-9_.-]{1,80}\.(?:${CONFIG_ASSIGNMENT_SECRET_KEYS})\s*[:=]\s*)(["'\x60])`;

/**
 * Shared matcher for the two quoted-value rules. The tempered dot `((?:(?!\2)[^\r\n])+)`
 * forced a per-character lookahead and one backtrack stack entry per value character; the
 * value here is a linear scan to the first closing quote or line end, and failed scans are
 * memoized per quote character because later candidates share their tail regions.
 */
function makeQuotedAssignmentMatcher(source: string, prefixSource: string, flags: string) {
  const prefixRegexPool: RegExp[] = [];
  function* exec(text: string): Iterable<RedactMatch> {
    const prefixRe = prefixRegexPool.pop() ?? new RegExp(prefixSource, flags);
    const failedScans = new Map<string, { start: number; end: number }>();
    let searchFrom = 0;
    try {
      for (;;) {
        prefixRe.lastIndex = searchFrom;
        const prefix = prefixRe.exec(text);
        if (!prefix) {
          return;
        }
        const start = prefix.index;
        const quote = prefix[2]!;
        const valueStart = start + prefix[0].length;
        const memo = failedScans.get(quote);
        let closing = -1;
        // A failed scan proved its region holds no closing quote for this character; later
        // candidates inside that region fail without rescanning it.
        const covered = memo !== undefined && valueStart >= memo.start && valueStart < memo.end;
        if (!covered) {
          closing = valueStart;
          while (closing < text.length) {
            const char = text[closing];
            if (char === quote || char === "\r" || char === "\n") {
              break;
            }
            closing += 1;
          }
        }
        if (closing > valueStart && text[closing] === quote) {
          const end = closing + 1;
          yield {
            match: text.slice(start, end),
            groups: [prefix[1] ?? "", quote, text.slice(valueStart, closing)],
            input: text,
            offset: start,
          };
          searchFrom = end;
        } else {
          if (closing !== -1) {
            failedScans.set(quote, { start: valueStart, end: closing });
          }
          searchFrom = start + 1;
        }
      }
    } finally {
      prefixRe.lastIndex = 0;
      prefixRegexPool.push(prefixRe);
    }
  }
  return Object.freeze({ source, exec });
}

const STANDALONE_QUOTED_MATCHER = makeQuotedAssignmentMatcher(
  "standalone-quoted-assignment (linear)",
  STANDALONE_QUOTED_PREFIX_SOURCE,
  "gi",
);
const CONFIG_QUOTED_MATCHER = makeQuotedAssignmentMatcher(
  "config-quoted-assignment (linear)",
  CONFIG_QUOTED_PREFIX_SOURCE,
  "g",
);

/** Default rule sources whose compilation routes to the linear matchers above. */
export const LINEAR_MATCHER_SOURCES: ReadonlyMap<string, ResolvedRedactPattern> = new Map<
  string,
  ResolvedRedactPattern
>([
  [base64SafeToken(String.raw`gAAAA[A-Za-z0-9_=-]{20,}`), GAAAA_TOKEN_MATCHER],
  [base64SafeToken(String.raw`ATCTT3xFfG[A-Za-z0-9+/=_-]+=[A-Za-z0-9]{8}`), ATCTT_TOKEN_MATCHER],
  [base64SafeToken(String.raw`ATATT[A-Za-z0-9+/=_-]+=[A-Za-z0-9]{8}`), ATATT_TOKEN_MATCHER],
  [base64SafeToken(String.raw`ATBB[A-Za-z0-9_=.-]{16,}`), ATBB_TOKEN_MATCHER],
  [base64SafeToken(String.raw`dapi[0-9a-f]{32}(?:-\d)?`), DAPI_TOKEN_MATCHER],
  [base64SafeToken(String.raw`AKIA[A-Z0-9]{16}`), AKIA_TOKEN_MATCHER],
  [base64SafeToken(String.raw`ASIA[A-Z0-9]{16}`), ASIA_TOKEN_MATCHER],
  [JWT_REDACT_PATTERN, JWT_MATCHER],
  [URL_USERINFO_REDACT_PATTERN, URL_USERINFO_MATCHER],
  [CONNECTION_STRING_REDACT_PATTERN, CONNECTION_STRING_MATCHER],
  [FORM_BODY_FIRST_PAIR_REDACT_PATTERN, FORM_BODY_FIRST_PAIR_MATCHER],
  [STANDALONE_ASSIGNMENT_QUOTED_REDACT_PATTERN, STANDALONE_QUOTED_MATCHER],
  [CONFIG_QUOTED_ASSIGNMENT_REDACT_PATTERN, CONFIG_QUOTED_MATCHER],
]);
