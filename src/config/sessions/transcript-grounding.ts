import path from "node:path";
import type { ManagedMediaGrounding } from "../../media/media-reference.js";

const UNGROUNDED_MEDIA_PLACEHOLDER = "[unverified media reference removed]";

const TOKEN_BOUNDARY = /[\s"'`<>{}()[\]]/u;
const PUNCTUATION = /[.,;:!?\u2012-\u2015\u2026]/u;
const REMOTE_URI = /[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+/iu;
// A URI scheme and authority are case-insensitive: FILE:///x, file://LOCALHOST/x and
// MEDIA://inbound/x all resolve. Only the path bytes after them follow the owner's rules.
// A managed path is a handful of segments; this only bounds pathological tokens so the
// normalization walk cannot be turned into a denial of service by a long crafted string.
const MAX_NORMALIZED_SEGMENTS = 64;
// Bounds the phase-2 token scan; longer than any real managed path, short enough that a
// crafted run of non-boundary bytes cannot make the walk expensive.
const MAX_GROUNDING_TOKEN_CHARS = 4096;
// A token that begins at a managed root but exhausts the normalization budget is redacted
// rather than replayed. A real managed path never needs this many segments; an adversarial
// one does, and failing open here is what the budget itself would otherwise enable.
// Bounds how many times one token may be folded against a root it could plausibly name.
// Reached only by crafted input, and refusing to decide redacts rather than rescanning.
const MAX_PHASE2_WALKS_PER_TOKEN = 32;
const UNDECIDABLE_PREFIX = -1;
// A non-ASCII root segment has NFC and NFD spellings APFS folds; see canonicalForCompare.
const NON_ASCII = /[^\u0020-\u007e]/u;
const URI_PREFIX = /^[a-z][a-z0-9+.-]*:(?:\/\/[^/]*)?/iu;
// A ".." segment in any spelling a resolver parser folds; over-matching only widens a search.
const DOT_DOT_SEGMENT = /(?:[/\\]|%2f|%5c)(?:\.|%2e){2}(?=[/\\]|%2f|%5c)/gu;
// What the WHATWG URL parser deletes from its input before parsing; see urlParserReading.
const URL_DELETED_RUNS = /[\t\n\r]+/gu;
// The `~` spellings resolveUserPath expands; `~name` is left to the filesystem.
const HOME_PREFIX = /^~(?=$|[\\/])/u;

function endsReference(text: string, end: number): boolean {
  let cursor = end;
  let char = text.charAt(cursor);
  if (!char || TOKEN_BOUNDARY.test(char)) {
    return true;
  }
  if (!PUNCTUATION.test(char)) {
    return false;
  }
  while (PUNCTUATION.test((char = text.charAt(++cursor)))) {}
  return !char || TOKEN_BOUNDARY.test(char);
}

/**
 * Lowercase without changing length. `String.prototype.toLowerCase` can expand a
 * character (U+0130 becomes two code units), and the matcher below indexes the folded
 * text with offsets taken from the ORIGINAL text. One expanding character anywhere
 * earlier in a prompt would shift every later comparison and silently stop grounding
 * from matching at all. Characters whose lowercase is not the same length keep their
 * original form, so the fold is length-preserving by construction.
 */
function foldCasePreservingLength(value: string): string {
  let folded = "";
  for (const char of value) {
    const lower = char.toLowerCase();
    folded += lower.length === char.length ? lower : char;
  }
  return folded;
}

/**
 * A root the platform parsers can fold tokens against.
 *
 * `path` is the root's own path put through the SAME parser the candidate tokens go
 * through, so the comparison is parser-output to parser-output and never a raw spelling.
 */
type NormalizableRoot = {
  /** Parsed scheme and authority for a URI root; null for a filesystem root. */
  uri: { protocol: string; host: string } | null;
  /** Length of the raw scheme+authority text, so offsets stay in token coordinates. */
  prefixLength: number;
  path: string;
  /** Conservative gate: folding removes segments, it never invents a segment NAME. */
  lastSegment: string;
  lowerLastSegment: string;
  lowerSegments: readonly string[];
  /** The segments a leading `~` does not supply; see admitsRange. */
  lowerSegmentsBeyondHome: readonly string[];
  /** Whole path, not just the last segment: ANY accented segment needs the fold to decide. */
  pathIsAscii: boolean;
  lowerPrefix: string;
};

/** A path normalized by the platform, with no trailing separator except at the root. */
function normalizedFilesystemPath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/**
 * Length of the raw prefix of `token` that the platform folds onto `root`, 0 when no prefix
 * does, or UNDECIDABLE_PREFIX when the spelling cannot be decided here.
 *
 * Equivalence is decided by the parsers the resolver itself uses - WHATWG `URL` for a URI
 * root, `path.posix.normalize` for a filesystem root - rather than by a fold written here.
 * Four consecutive review rounds each found a spelling a hand-written walk missed (`./root`,
 * `../root`, `//root`, `root2/../root`, `x/../root`, `%2e/root`) and a fix for one round's
 * spelling opened the next round's. Every one of them folds correctly in the parser, so the
 * class is closed by delegating rather than by enumerating spellings.
 *
 * The SHORTEST prefix that folds onto the root is the reference, so the bytes after it stay
 * the caller's to preserve.
 *
 * Lexical only. Never touches the filesystem: this runs on every replayed prompt, and a
 * symlink read per candidate would be both a hot-path cost and a new I/O dependency.
 * Symlinked spellings stay the alias preparer's job, which resolves the real path once.
 */
/**
 * Unicode canonical form for COMPARISON only.
 *
 * APFS folds NFC and NFD spellings to one file, so "café" precomposed and "cafe" + combining
 * acute name the same managed directory while comparing unequal byte-for-byte. Normalizing
 * changes length, so it can never touch the text being scanned - offsets into the transcript
 * have to stay exact. Both sides of the comparison are derived strings, so it is safe here.
 * Found by claude-air-opus5-477349 against the pre-phase-2 matcher; it reproduced here.
 */
function canonicalForCompare(value: string): string {
  return value.normalize("NFC");
}

function resolvedManagedPrefix(
  token: string,
  root: NormalizableRoot,
  comparable: (value: string) => string,
  homeDir: string,
): number {
  let boundaries = 0;
  for (let end = root.prefixLength + 1; end <= token.length; end += 1) {
    const char = token.charAt(end);
    if (end !== token.length && char !== "/" && char !== "\\") {
      continue;
    }
    boundaries += 1;
    // A managed path is a handful of segments. Past the cap the token is adversarial rather
    // than a reference, and refusing to decide redacts it instead of replaying it.
    if (boundaries > MAX_NORMALIZED_SEGMENTS) {
      return UNDECIDABLE_PREFIX;
    }
    const candidate = token.slice(0, end);
    let resolved: string;
    if (root.uri) {
      let url: URL;
      try {
        url = new URL(candidate);
      } catch {
        continue;
      }
      // The parser lowercases scheme and host for special schemes and preserves them for the
      // rest, which is exactly the resolver's own rule; comparing the parsed fields inherits
      // it instead of restating it.
      if (url.protocol !== root.uri.protocol || url.host !== root.uri.host) {
        continue;
      }
      // WHATWG percent-encodes every non-ASCII code point in `pathname` and folds only %2e,
      // so the parsed path is not yet comparable with a filesystem root. Both sides are
      // decoded exactly once - here and at setup - so one comparison decides every spelling.
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(url.pathname);
      } catch {
        // A malformed escape names nothing the owner's own decode could open either, so it
        // does not resolve into the root. Refusing here redacted ordinary transcript URLs
        // like file:///docs/100%_done.pdf whole.
        continue;
      }
      resolved = normalizedFilesystemPath(decodedPath);
    } else {
      // The resolver's resolveUserPath expands a leading "~" before it normalizes.
      resolved = normalizedFilesystemPath(
        HOME_PREFIX.test(candidate) ? `${homeDir}${candidate.slice(1)}` : candidate,
      );
    }
    if (canonicalForCompare(comparable(resolved)) === canonicalForCompare(comparable(root.path))) {
      return end;
    }
    // Candidates are cut at RAW separators, but decoding turns %2F into one. A token spelling
    // its separator that way has no raw cut at the end of the root, so equality can never be
    // reached even though the decoded path lands under it. The exact prefix is unknowable
    // here, so refuse the token rather than replay it.
    if (
      root.uri &&
      canonicalForCompare(comparable(resolved)).startsWith(
        `${canonicalForCompare(comparable(root.path))}/`,
      )
    ) {
      return UNDECIDABLE_PREFIX;
    }
  }
  return 0;
}

/** Ranges of `text` naming a managed root that no authorized alias covers, in text order. */
function ungroundedRanges(text: string, grounding: ManagedMediaGrounding): [number, number][] {
  const ranges: [number, number][] = [];
  if (!text || (grounding.rootAliases.length === 0 && grounding.uriRoots.length === 0)) {
    return ranges;
  }
  let cursor = 0,
    tokenStart = 0;
  const comparisonText = grounding.caseInsensitivePaths ? foldCasePreservingLength(text) : text;
  const comparable = (alias: string) =>
    grounding.caseInsensitivePaths ? foldCasePreservingLength(alias) : alias;
  const lowercaseText = grounding.caseInsensitivePaths
    ? comparisonText
    : foldCasePreservingLength(text);
  type AliasCandidate = { alias: string; lower: string; split?: { prefix: string; rest: string } };
  const candidates = (aliases: readonly string[]): AliasCandidate[] =>
    aliases.map((alias) => ({ alias, lower: foldCasePreservingLength(alias) }));
  const rootCandidates = candidates(grounding.rootAliases);
  const uriRootCandidates = candidates(grounding.uriRoots);
  const authorizedCandidates = candidates(grounding.authorizedAliases);
  // Only plain filesystem spellings are normalized. A file:// or UNC root carries its own
  // escaping rules, and folding dot segments inside those is a separate contract; those
  // keep the literal alias match above.
  // Plain filesystem roots normalize whole. A file:// root normalizes only after its
  // scheme and authority, because WHATWG URL folds dot segments in the PATH exactly like
  // path normalization does: file:///managed/state/./media resolves into the managed root
  // just as the bare path does, so excluding URI roots here would leave the same bypass
  // reachable through a different spelling.
  const homeSegments = new Set(
    normalizedFilesystemPath(grounding.homeDir)
      .split("/")
      .map((segment) => foldCasePreservingLength(segment)),
  );
  const beyondHome = (segments: readonly string[]) =>
    segments.filter((segment) => !homeSegments.has(segment));
  const normalizableRoots: NormalizableRoot[] = grounding.rootAliases
    .concat(grounding.uriRoots)
    .map((alias) => {
      const prefix = URI_PREFIX.exec(alias)?.[0] ?? "";
      if (prefix) {
        let url: URL;
        try {
          url = new URL(alias);
        } catch {
          return null;
        }
        let decodedRootPath: string;
        try {
          decodedRootPath = decodeURIComponent(url.pathname);
        } catch {
          return null;
        }
        const rootPath = normalizedFilesystemPath(decodedRootPath);
        const lowerSegments = rootPath
          .split("/")
          .filter(Boolean)
          .map((segment) => foldCasePreservingLength(segment));
        return {
          uri: { protocol: url.protocol, host: url.host },
          prefixLength: url.protocol.length,
          path: rootPath,
          lastSegment: rootPath.split("/").pop() ?? "",
          lowerLastSegment: foldCasePreservingLength(rootPath.split("/").pop() ?? ""),
          lowerSegments,
          lowerSegmentsBeyondHome: beyondHome(lowerSegments),
          // Scheme only. WHATWG folds empty host, "localhost" and "LOCALHOST" to the same
          // file: authority, so gating on the raw authority text rejected spellings the
          // parser resolves into the root - the exact mistake this gate must never make.
          pathIsAscii: !NON_ASCII.test(rootPath),
          lowerPrefix: foldCasePreservingLength(url.protocol),
        };
      }
      if (!/^[/\\]/u.test(alias) && !/^[a-z]:[/\\]/iu.test(alias)) {
        return null;
      }
      const rootPath = normalizedFilesystemPath(alias);
      const lowerSegments = rootPath
        .split("/")
        .filter(Boolean)
        .map((segment) => foldCasePreservingLength(segment));
      return {
        uri: null,
        prefixLength: 0,
        path: rootPath,
        lastSegment: rootPath.split("/").pop() ?? "",
        lowerLastSegment: foldCasePreservingLength(rootPath.split("/").pop() ?? ""),
        lowerSegments,
        lowerSegmentsBeyondHome: beyondHome(lowerSegments),
        pathIsAscii: !NON_ASCII.test(rootPath),
        lowerPrefix: "",
      };
    })
    .filter((entry) => entry !== null)
    // Drops a URI root with no path of its own: "media://inbound" normalizes to ".". A
    // drive-letter root does NOT need an arm here - URI_PREFIX matches "C:" as a scheme, so
    // it takes the branch above and its pathname already starts with "/".
    .filter(({ path: rootPath, lastSegment }) => rootPath.startsWith("/") && lastSegment !== "");
  // Conservative gate, and conservative is the whole point: it may admit a token the parser
  // then rejects, but it must never reject one the parser would fold onto a root. Every
  // bypass found in rounds 5 through 8 was a prefilter that decided a token was uninteresting
  // before the fold could look at it. Folding deletes segments and never invents a segment
  // NAME, so a token that cannot fold onto the root unless it spells the root's last segment
  // - or hides it behind an escape - is safe to skip.
  const firstAtOrAfter = (sorted: readonly number[], value: number): number => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((sorted[middle] ?? value) < value) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  };
  // indexOf from the token start scanned to the end of the PROMPT, so a prompt of many
  // one-character absolute tokens ("/ " repeated) paid two full-text scans each, and a scan of
  // the range cost a range per query. Each needle is located once per call instead, without a
  // single String.slice, and a range query is two binary searches.
  const occurrences = new Map<string, number[]>();
  const containsWithin = (needle: string, at: number, end: number): boolean => {
    let starts = occurrences.get(needle);
    if (!starts) {
      starts = [];
      for (let found = lowercaseText.indexOf(needle); found !== -1;) {
        starts.push(found);
        found = lowercaseText.indexOf(needle, found + 1);
      }
      occurrences.set(needle, starts);
    }
    const first = starts[firstAtOrAfter(starts, at)];
    return first !== undefined && first + needle.length <= end;
  };
  // Memoized per token: whether the token could still name this root does not depend on WHICH
  // position inside it is being tried, and recomputing per position is what made the scan
  // quadratic. Searching the token's whole extent admits at least as much as searching from
  // `at`, and this gate must only ever over-admit.
  let admitMemo: (boolean | undefined)[] = [];
  const admitsRange = (root: NormalizableRoot, end: number): boolean => {
    // The segment scan is byte-literal, so it cannot see across an NFC/NFD difference in
    // EITHER direction: an NFD token against an NFC root, or an NFC token against an NFD root.
    // Screening on the token's own form got the first and missed the second. Any root path
    // that is not plain ASCII simply goes to the fold, which compares canonical forms - keyed
    // on the LAST segment alone this missed "/managed/etat/media", where the accent sits in a
    // middle segment and the last one is ASCII.
    // EVERY root segment must appear literally, not just the last one. Folding deletes
    // segments and never invents a segment NAME, so this cannot reject a token the parser
    // would fold onto the root - and it is what keeps ordinary content away from the caps
    // below. Matching on the last segment alone admitted any absolute-path list containing
    // the word "media", and a 41-entry PATH then lost its tail to a cost cap.
    const spelled = (segments: readonly string[]) =>
      segments.every((segment) => containsWithin(segment, cachedTokenStart, end));
    return (
      !root.pathIsAscii ||
      containsWithin("%", cachedTokenStart, end) ||
      spelled(root.lowerSegments) ||
      // A leading "~" supplies the home directory's segments without spelling them.
      (containsWithin("~", cachedTokenStart, end) && spelled(root.lowerSegmentsBeyondHome))
    );
  };
  const admitsToken = (root: NormalizableRoot, rootIndex: number): boolean =>
    (admitMemo[rootIndex] ??= admitsRange(root, cachedTokenEnd));
  const matchesAt = (candidate: AliasCandidate, at: number): boolean => {
    // An all-lowercase match is necessary for any match, and costs one startsWith. Splitting
    // scheme from path is deferred so a prompt carrying no managed reference never pays for it.
    if (!lowercaseText.startsWith(candidate.lower, at)) {
      return false;
    }
    if (!candidate.split) {
      const prefix = URI_PREFIX.exec(candidate.alias)?.[0] ?? "";
      candidate.split = {
        prefix: foldCasePreservingLength(prefix),
        rest: comparable(candidate.alias.slice(prefix.length)),
      };
    }
    const { prefix, rest } = candidate.split;
    return comparisonText.startsWith(rest, at + prefix.length);
  };
  // Phase 2: a managed path spelled with dot segments matches no alias but still names a
  // file under the root. Only attempted where the text already begins a root's first
  // segment, so prose pays one startsWith per position and nothing else.
  // Returns how much to redact, and whether the walk could not decide. Undecidable means
  // the token BEGINS at a managed root and could not be proven safe, so it is redacted
  // whole and skips the trailing-boundary check: every truncation or budget exhaustion
  // must fail closed, or the caps meant to bound cost become the bypass.
  // Computed once per token: re-scanning it per position is what made a single long token
  // cost O(N^2) twice over (200k separators = 119s, a URI token plus 100k dot segments = 178s).
  let cachedTokenStart = -1;
  let cachedTokenEnd = -1;
  let phase2Walks = 0;
  let cachedRemoteUriStart = -1;
  let cachedRemoteUriEnd: number | undefined;
  type PathWalk = {
    cleanCuts: number[];
    /** Stopped by a cap while the spelling could still resolve past it. */
    truncatedAt: number;
    admits: Map<number, (boolean | undefined)[]>;
  };
  let pathWalks: { lastSlash: number; exact?: PathWalk; loose?: PathWalk } | undefined;
  const tokenEndFrom = (start: number): number => {
    if (start === cachedTokenStart) {
      return cachedTokenEnd;
    }
    let end = start;
    while (end < text.length && !TOKEN_BOUNDARY.test(text.charAt(end))) {
      end += 1;
    }
    cachedTokenStart = start;
    cachedTokenEnd = end;
    phase2Walks = 0;
    admitMemo = [];
    cachedRemoteUriEnd = undefined;
    pathWalks = undefined;
    return end;
  };
  // A redaction jump can carry the cursor past a boundary INSIDE a matched alias - user
  // directories contain spaces - and then the memo above no longer describes where the cursor
  // is. Left stale, the extent could end behind the cursor and the walk cap handed back a
  // negative length, moving the cursor BACKWARD. A jump that stays inside the token keeps the
  // extent: nothing in it is a boundary, so a rescan only repeats the answer, and rescanning
  // after every redaction made one token of N comma-separated managed paths cost O(N^2).
  const reanchorToken = (at: number) => {
    tokenStart = at;
    if (cachedTokenStart === -1 || at < cachedTokenStart || at > cachedTokenEnd) {
      cachedTokenStart = -1;
      return;
    }
    // Per-start state resets exactly as a rescan would, except where the old answer provably
    // holds for the suffix: a root refused over the wider extent is refused over this one, and
    // a remote URI starting at or after `at` is still the first one in it.
    cachedTokenStart = at;
    phase2Walks = 0;
    const keepRefusals = (memo: (boolean | undefined)[]) =>
      memo.map((admitted) => (admitted === false ? false : undefined));
    admitMemo = keepRefusals(admitMemo);
    for (const walk of [pathWalks?.exact, pathWalks?.loose]) {
      for (const [end, admits] of walk?.admits ?? []) {
        walk?.admits.set(end, keepRefusals(admits));
      }
    }
    if (cachedRemoteUriEnd !== Number.MAX_SAFE_INTEGER && cachedRemoteUriStart < at) {
      cachedRemoteUriEnd = undefined;
    }
  };
  const startsAbsolutePath = (at: number): boolean => {
    const first = text.charAt(at);
    const second = text.charAt(at + 1);
    if (first === "/" || first === "\\" || (first === "~" && (second === "/" || second === "\\"))) {
      return true;
    }
    const third = text.charAt(at + 2);
    return /[a-z]/iu.test(first) && second === ":" && (third === "/" || third === "\\");
  };
  // A token ends at whitespace, quotes and brackets, all legal in a file name. That matters
  // where the resolver still lands in a root: the boundary sits in a segment a later ".."
  // discards ("/state/x y/../media") or in a root segment ("/Users/John Doe/..."). pathExtent
  // finds how far such a spelling reaches and the parser decides it. Its model only over-reaches:
  // "/" splits, "."/".." fold in either %2e spelling, and a segment holding "\\", %2F or %5C
  // may split and pop once decoded, so it clears all before it. It crosses a boundary only while
  // enough ".." lie ahead to discard what it holds or a root segment could still be spelled,
  // which keeps it out of prose, and never past MAX_GROUNDING_TOKEN_CHARS (isValidMedia's cap).
  const rootSegments = new Set(
    normalizableRoots.flatMap((root) =>
      root.path
        .split("/")
        .filter(Boolean)
        .map((segment) => canonicalForCompare(comparable(segment))),
    ),
  );
  // 12 raw characters per code point covers a root segment spelled fully percent-encoded.
  const rootSegmentReach = Math.max(
    0,
    ...[...rootSegments]
      .filter((segment) => TOKEN_BOUNDARY.test(segment))
      .map((segment) => 12 * segment.length),
  );
  const spellsRootSegment = (raw: string): boolean => {
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // An undecodable escape leaves only the raw spelling to compare.
    }
    return [raw, decoded].some((form) => rootSegments.has(canonicalForCompare(comparable(form))));
  };
  let dotDotStarts: number[] | undefined;
  const dotDotsBetween = (from: number, to: number) => {
    dotDotStarts ??= Array.from(lowercaseText.matchAll(DOT_DOT_SEGMENT), (match) => match.index);
    return firstAtOrAfter(dotDotStarts, to) - firstAtOrAfter(dotDotStarts, from);
  };
  // One walk per token past its end, from the start of the segment the end interrupts. `loose`
  // serves attempts that begin after the token's last "/": their first segment starts with "\\",
  // a drive or a scheme and can spell no root segment, so it is taken as discardable - reaching
  // further, never less. Every clean cut is kept so each attempt can stop within its own cap.
  // A walk covers at most MAX_NORMALIZED_SEGMENTS segments, the fold's own budget, which bounds
  // how far neighbouring walks overlap. A walk stopped by a cap refuses what a root claims.
  const walkPastToken = (segmentStart: number, tokenEnd: number, loose: boolean): PathWalk => {
    const limit = Math.min(text.length, tokenEnd + MAX_GROUNDING_TOKEN_CHARS);
    const cleanCuts: number[] = [];
    const unresolved: boolean[] = [];
    let pending = 0;
    let deepestPending = -1;
    let from = segmentStart;
    let truncatedAt = -1;
    let segments = 0;
    for (let pos = tokenEnd; pos <= limit; pos += 1) {
      if (pos === limit && limit < text.length) {
        truncatedAt = pos;
        break;
      }
      const char = text.charAt(pos);
      if (pos < limit && char !== "/") {
        const popsNeeded = (pending > 0 ? unresolved.length - deepestPending : 0) + 1;
        if (
          !TOKEN_BOUNDARY.test(char) ||
          pos - from < rootSegmentReach ||
          dotDotsBetween(pos, limit) >= popsNeeded
        ) {
          continue;
        }
      }
      // [from, pos) is a whole segment, ended by "/", the text end, or a boundary not crossed.
      const raw = lowercaseText.slice(from, pos);
      const segment = raw.replaceAll("%2e", ".");
      if (segment === "..") {
        pending -= unresolved.pop() ? 1 : 0;
      } else if (/\\|%2f|%5c/u.test(raw)) {
        unresolved.fill(false);
        unresolved.push(false);
        pending = 0;
      } else if (segment !== "" && segment !== ".") {
        const held =
          !(loose && from === segmentStart) &&
          TOKEN_BOUNDARY.test(raw) &&
          !(rootSegmentReach > 0 && spellsRootSegment(text.slice(from, pos)));
        deepestPending = pending === 0 && held ? unresolved.length : deepestPending;
        unresolved.push(held);
        pending += held ? 1 : 0;
      }
      deepestPending = pending === 0 ? -1 : deepestPending;
      if (pos > tokenEnd && pending === 0) {
        cleanCuts.push(pos);
      }
      const popsNeeded = pending > 0 ? unresolved.length - deepestPending : 0;
      if (char !== "/" || dotDotsBetween(pos, limit) < popsNeeded) {
        break;
      }
      if ((segments += 1) > MAX_NORMALIZED_SEGMENTS) {
        truncatedAt = pos;
        break;
      }
      from = pos + 1;
    }
    return { cleanCuts, truncatedAt, admits: new Map() };
  };
  const pathExtent = (at: number, tokenEnd: number) => {
    if (!pathWalks) {
      let scan = tokenEnd - 1;
      while (scan >= cachedTokenStart && text.charAt(scan) !== "/") {
        scan -= 1;
      }
      pathWalks = { lastSlash: scan };
    }
    const walk =
      at <= pathWalks.lastSlash + 1
        ? (pathWalks.exact ??= walkPastToken(pathWalks.lastSlash + 1, tokenEnd, false))
        : (pathWalks.loose ??= walkPastToken(tokenEnd, tokenEnd, true));
    const cut = firstAtOrAfter(walk.cleanCuts, at + MAX_GROUNDING_TOKEN_CHARS + 1) - 1;
    const end = walk.cleanCuts[cut] ?? tokenEnd;
    // A truncated walk could continue anywhere in its window, so it is admitted over all of it.
    const admitEnd =
      walk.truncatedAt === -1 ? end : Math.min(text.length, tokenEnd + MAX_GROUNDING_TOKEN_CHARS);
    const admits = walk.admits.get(admitEnd) ?? [];
    walk.admits.set(admitEnd, admits);
    return { end, admitEnd, admits, truncated: walk.truncatedAt !== -1 };
  };
  const equivalentRootMatch = (at: number): { length: number; undecidable: boolean } | null => {
    if (normalizableRoots.length === 0) {
      return null;
    }
    const tokenEnd = tokenEndFrom(tokenStart);
    if (tokenEnd <= at) {
      return null;
    }
    let extent: ReturnType<typeof pathExtent> | undefined;
    for (const [rootIndex, root] of normalizableRoots.entries()) {
      // Every gate below reads the text in place. A prompt carrying no managed root must not
      // pay a single String.slice, which is what the rescan guard measures.
      if (root.lowerPrefix && !lowercaseText.startsWith(root.lowerPrefix, at)) {
        continue;
      }
      if (!root.uri && !startsAbsolutePath(at)) {
        continue;
      }
      extent ??= pathExtent(at, tokenEnd);
      const end = extent.end;
      const admitted =
        extent.admitEnd > tokenEnd
          ? (extent.admits[rootIndex] ??= admitsRange(root, extent.admitEnd))
          : admitsToken(root, rootIndex);
      if (!admitted) {
        continue;
      }
      // Counted here, NOT at entry: a cap applied before the gates redacted the tail of any
      // token with enough colons in it - "tokio::sync::mpsc::error::SendError::Full" and a
      // 10-entry PATH both lost text. Only a token a root has already claimed can be refused.
      phase2Walks += 1;
      if (phase2Walks > MAX_PHASE2_WALKS_PER_TOKEN) {
        return { length: end - at, undecidable: true };
      }
      // Only a token that could still name THIS root is worth refusing. Bailing on length
      // before the gate redacted any long token, so a 200k run of "x" lost its own text.
      // A token longer than any real managed path is refused rather than truncated: scanning
      // a prefix and reporting "root not reached" replayed ./-padding that ran past the cap.
      if (end - at > MAX_GROUNDING_TOKEN_CHARS) {
        return { length: end - at, undecidable: true };
      }
      const length = resolvedManagedPrefix(
        text.slice(at, end),
        root,
        comparable,
        grounding.homeDir,
      );
      if (length === UNDECIDABLE_PREFIX) {
        return { length: end - at, undecidable: true };
      }
      if (length > 0) {
        return { length, undecidable: false };
      }
      if (extent.truncated) {
        return { length: end - at, undecidable: true };
      }
    }
    return null;
  };
  // An authorized alias ends the reference only where the path ends. Past a boundary that a
  // later ".." discards ("ok.png /../../x", or a tab the URL parser deletes) the same path goes
  // on to another file under the root, so the verified spelling is not what the resolver opens.
  const pathRunsPast = (at: number, aliasEnd: number): boolean => {
    const tokenEnd = tokenEndFrom(tokenStart);
    const extent = pathExtent(at, tokenEnd);
    return extent.truncated || extent.end > Math.max(tokenEnd, aliasEnd);
  };
  const advanceOne = () => {
    tokenStart = TOKEN_BOUNDARY.test(text.charAt(cursor++)) ? cursor : tokenStart;
  };
  // The guard asks whether a remote authority appears BEFORE the cursor, and the prefix only
  // grows within a token, so the answer flips exactly once - at the end of the earliest match.
  // Finding that threshold costs one scan per token; re-running the unanchored regex over the
  // prefix at every post-cap position cost O(N*M), 24s on a long scheme-like run.
  const inRemoteUri = () => {
    // tokenEndFrom FIRST: it is what notices a token change and drops the memo. Reading the
    // memo before calling it compared this cursor against the PREVIOUS token's offset, and
    // since the cursor only grows the guard read true - so one URL token anywhere ahead of a
    // managed path suppressed that path's redaction entirely.
    const end = tokenEndFrom(tokenStart);
    if (cachedRemoteUriEnd === undefined) {
      const match = REMOTE_URI.exec(text.slice(tokenStart, end));
      cachedRemoteUriStart = match ? tokenStart + match.index : -1;
      cachedRemoteUriEnd = match
        ? tokenStart + match.index + match[0].length
        : Number.MAX_SAFE_INTEGER;
    }
    return cursor >= cachedRemoteUriEnd;
  };
  while (cursor < text.length) {
    const literalRoot =
      rootCandidates.find((candidate) => matchesAt(candidate, cursor))?.alias ??
      uriRootCandidates.find((candidate) => matchesAt(candidate, cursor))?.alias;
    // A literal hit that fails its own trailing-boundary check must NOT end the attempt:
    // /managed/state/media2/../media/x matches the root literally, fails the boundary on
    // "2", and still resolves back into the root. Short-circuiting there replayed it.
    const literalFits =
      literalRoot !== undefined &&
      !/[\w/\\]/u.test(text.charAt(cursor - 1)) &&
      (["", "/", "\\"].includes(text.charAt(cursor + literalRoot.length)) ||
        endsReference(text, cursor + literalRoot.length));
    let rootLength = 0;
    let undecidable = false;
    if (literalFits && literalRoot !== undefined) {
      rootLength = literalRoot.length;
    } else if (!/[\w/\\]/u.test(text.charAt(cursor - 1))) {
      // Exactly the literal matcher's predecessor test. Anything narrower left a spelling the
      // literal path redacts and the fold does not: "../managed/state/./media/x" after ".",
      // "foo,/managed/state/./media/x" after ",". Cost is bounded by the per-token walk cap
      // above, not by narrowing this test.
      // Phase 2 decides a TOKEN, once. Re-entering inside one re-ran an O(N) token scan per
      // position: 200k separators cost 119s, and a URI token followed by 100k "/." segments
      // cost 178s. A reference always begins a token, so one attempt per token loses nothing.
      const match = equivalentRootMatch(cursor);
      if (match) {
        rootLength = match.length;
        undecidable = match.undecidable;
      }
    }
    if (rootLength === 0 || inRemoteUri()) {
      advanceOne();
      continue;
    }
    if (
      !undecidable &&
      !["", "/", "\\"].includes(text.charAt(cursor + rootLength)) &&
      !endsReference(text, cursor + rootLength)
    ) {
      advanceOne();
      continue;
    }
    const allowed = authorizedCandidates.find(
      (candidate) =>
        matchesAt(candidate, cursor) && endsReference(text, cursor + candidate.alias.length),
    )?.alias;
    if (allowed && !pathRunsPast(cursor, cursor + allowed.length)) {
      cursor += allowed.length;
    } else {
      // A dot-segment spelling of an AUTHORIZED reference is redacted too: authorized
      // aliases are the exact spellings the resolver verified, and re-deriving
      // equivalence for them would decide authorization from prompt text. Failing closed
      // costs a visible placeholder on an exotic spelling; failing open replays an
      // unverified path.
      ranges.push([cursor, cursor + rootLength]);
      cursor += rootLength;
    }
    reanchorToken(cursor);
  }
  return ranges;
}

/**
 * The text as the URL parser reads a file: reference in it, or undefined when that reading
 * cannot differ from the raw scan's.
 *
 * WHATWG URL deletes ASCII tab, LF and CR anywhere in its input, and the media resolver hands
 * every `file:` reference to it (`safeFileURLToPath`), so `file:///state/me<TAB>dia/x` opens a
 * file under `/state/media` while no raw spelling names that root. A run of those characters
 * right before `file:` is kept: the reference starts after it, and deleting it would join the
 * preceding word onto the scheme, which the predecessor rule then refuses.
 */
function urlParserReading(text: string): { text: string; offsets: Uint32Array } | undefined {
  if (!/file:/iu.test(text)) {
    return undefined;
  }
  const runs = [...text.matchAll(URL_DELETED_RUNS)];
  if (runs.length === 0) {
    return undefined;
  }
  const kept: string[] = [];
  const offsets = new Uint32Array(text.length);
  let length = 0;
  const keep = (from: number, to: number) => {
    kept.push(text.slice(from, to));
    for (let index = from; index < to; index += 1) {
      offsets[length++] = index;
    }
  };
  let from = 0;
  for (const run of runs) {
    const end = run.index + run[0].length;
    keep(from, text.slice(end, end + 5).toLowerCase() === "file:" ? end : run.index);
    from = end;
  }
  keep(from, text.length);
  return { text: kept.join(""), offsets: offsets.subarray(0, length) };
}

export function invalidateUngroundedMediaPrefixes(
  text: string,
  grounding: ManagedMediaGrounding,
): string {
  const ranges = ungroundedRanges(text, grounding);
  const fileRoots = grounding.rootAliases.filter((alias) => /^file:/iu.test(alias));
  const reading = fileRoots.length > 0 ? urlParserReading(text) : undefined;
  if (reading) {
    // Only file: roots, and only a range with a deleted character inside it: every other range
    // spells bytes the raw scan already decided, and only that scan sees prose boundaries.
    // Reading "ok.png<LF>next" as one URL would otherwise redact an authorized reference. No
    // alias is authorized here: a spelling that needs deleted characters to name the root is
    // not the one the resolver verified, so it is redacted like the dot-segment spellings.
    const parsedRanges = ungroundedRanges(reading.text, {
      ...grounding,
      authorizedAliases: [],
      rootAliases: fileRoots,
      uriRoots: [],
    });
    for (const [start, end] of parsedRanges) {
      const from = reading.offsets[start];
      const last = reading.offsets[end - 1];
      if (from !== undefined && last !== undefined) {
        if (text.slice(from, last + 1).search(URL_DELETED_RUNS) !== -1) {
          ranges.push([from, last + 1]);
        }
      }
    }
    ranges.sort(([left], [right]) => left - right);
  }
  if (ranges.length === 0) {
    return text;
  }
  let output = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start >= cursor) {
      output += `${text.slice(cursor, start)}${UNGROUNDED_MEDIA_PLACEHOLDER}`;
    }
    cursor = Math.max(cursor, end);
  }
  return output + text.slice(cursor);
}
