import type { ManagedMediaGrounding } from "../../media/media-reference.js";

const UNGROUNDED_MEDIA_PLACEHOLDER = "[unverified media reference removed]";

const TOKEN_BOUNDARY = /[\s"'`<>{}()[\]]/u;
const PUNCTUATION = /[.,;:!?\u2012-\u2015\u2026]/u;
const REMOTE_URI = /[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+/iu;
// A URI scheme and authority are case-insensitive: FILE:///x, file://LOCALHOST/x and
// MEDIA://inbound/x all resolve. Only the path bytes after them follow the owner's rules.
const URI_PREFIX = /^[a-z][a-z0-9+.-]*:(?:\/\/[^/]*)?/iu;

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

export function invalidateUngroundedMediaPrefixes(
  text: string,
  grounding: ManagedMediaGrounding,
): string {
  if (!text || (grounding.rootAliases.length === 0 && grounding.uriRoots.length === 0)) {
    return text;
  }
  let cursor = 0,
    tokenStart = 0;
  const output: string[] = [];
  const comparisonText = grounding.caseInsensitivePaths ? text.toLowerCase() : text;
  const comparable = (alias: string) =>
    grounding.caseInsensitivePaths ? alias.toLowerCase() : alias;
  const lowercaseText = grounding.caseInsensitivePaths ? comparisonText : text.toLowerCase();
  type AliasCandidate = { alias: string; lower: string; split?: { prefix: string; rest: string } };
  const candidates = (aliases: readonly string[]): AliasCandidate[] =>
    aliases.map((alias) => ({ alias, lower: alias.toLowerCase() }));
  const rootCandidates = candidates(grounding.rootAliases);
  const uriRootCandidates = candidates(grounding.uriRoots);
  const authorizedCandidates = candidates(grounding.authorizedAliases);
  const matchesAt = (candidate: AliasCandidate, at: number): boolean => {
    // An all-lowercase match is necessary for any match, and costs one startsWith. Splitting
    // scheme from path is deferred so a prompt carrying no managed reference never pays for it.
    if (!lowercaseText.startsWith(candidate.lower, at)) {
      return false;
    }
    if (!candidate.split) {
      const prefix = URI_PREFIX.exec(candidate.alias)?.[0] ?? "";
      candidate.split = {
        prefix: prefix.toLowerCase(),
        rest: comparable(candidate.alias.slice(prefix.length)),
      };
    }
    const { prefix, rest } = candidate.split;
    return comparisonText.startsWith(rest, at + prefix.length);
  };
  while (cursor < text.length) {
    const root =
      rootCandidates.find((candidate) => matchesAt(candidate, cursor))?.alias ??
      uriRootCandidates.find((candidate) => matchesAt(candidate, cursor))?.alias;
    if (
      !root ||
      /[\w/\\]/u.test(text.charAt(cursor - 1)) ||
      REMOTE_URI.test(text.slice(tokenStart, cursor)) ||
      (!["", "/", "\\"].includes(text.charAt(cursor + root.length)) &&
        !endsReference(text, cursor + root.length))
    ) {
      const char = text.charAt(cursor++);
      output.push(char);
      tokenStart = TOKEN_BOUNDARY.test(char) ? cursor : tokenStart;
      continue;
    }
    const allowed = authorizedCandidates.find(
      (candidate) =>
        matchesAt(candidate, cursor) && endsReference(text, cursor + candidate.alias.length),
    )?.alias;
    if (allowed) {
      output.push(text.slice(cursor, cursor + allowed.length));
      cursor += allowed.length;
    } else {
      output.push(UNGROUNDED_MEDIA_PLACEHOLDER);
      cursor += root.length;
    }
  }
  return output.join("");
}
