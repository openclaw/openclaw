// Grounding pass for replayed assistant transcript text.
//
// A model can fabricate a media reference: it invents an absolute path under
// the managed media dir and then "describes" the attachment as if it were
// real. Replaying that text into later prompts makes the fabrication
// self-reinforcing. Legitimate inbound media never reaches prompts as a raw
// absolute path (media-note.ts normalizes managed refs to media://inbound/...),
// so an absolute managed-media path inside assistant text that does not
// resolve to a regular file is fabricated -- or expired, which is equally
// unusable. Redact only
// the path token and keep the surrounding prose; paths outside the managed
// media dir (code paths, host paths) are out of scope so ordinary technical
// conversation is never touched.
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { isPathInside } from "../../infra/fs-safe.js";
import { getMediaDir } from "../../media/store.js";

// Test files assert the literal directly; keeping this module-local avoids
// an unused production export (knip --production).
const UNGROUNDED_MEDIA_PLACEHOLDER = "[unverified media reference removed]";

// Characters that end a path token inside prose. Mirrors how paths are
// commonly delimited in model output: whitespace, quotes, brackets, and the
// backtick of inline code spans.
const PATH_TOKEN_END = /[\s"'`<>)\]}]/;

type GroundingOptions = {
  /** Managed media root; defaults to the configured media store dir. */
  mediaDir?: string;
  /** Grounding probe (regular-file check), injectable for tests. */
  exists?: (candidate: string) => boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Grounded means "usable attachment": mirror the media store contract
// (openMediaStore opens root-scoped with symlinks:"reject" and returns a
// realPath), so a directory, special file, or symlink at the path is redacted.
// lstat on the leaf keeps a final-component symlink from laundering the ref via
// its target. Then require the leaf's PARENT realpath to stay inside the media
// root's realpath, so an intermediate directory symlink (e.g. <mediaDir>/evil ->
// /outside) cannot redirect the probe to an outside regular file and preserve a
// fabricated ref. realpath canonicalizes the macOS /var -> /private/var twin
// identically for root and candidate, so legitimate paths under the real media
// root stay grounded. Never throws; replay must not break.
function isGroundedRegularFile(candidate: string, mediaRootReal: string | null): boolean {
  try {
    if (!lstatSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      return false;
    }
    if (!mediaRootReal) {
      return false;
    }
    const parentReal = realpathSync(path.dirname(candidate));
    return isPathInside(mediaRootReal, parentReal);
  } catch {
    return false;
  }
}

// Windows model output spells managed paths with backslashes. Matching runs on
// backslash-normalized copies (1:1 char mapping keeps indexes aligned with the
// original text), which also keeps the win32 branch exercisable on POSIX CI.
function normalizeSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

// macOS mounts /var as a symlink to /private/var, so managed media paths can
// legitimately appear with either spelling. Match both, verify either.
function managedMediaRoots(mediaDir: string): string[] {
  const resolved = normalizeSeparators(mediaDir).replace(/\/+$/, "");
  const roots = new Set<string>([resolved]);
  if (resolved.startsWith("/private/var/")) {
    roots.add(resolved.slice("/private".length));
  } else if (resolved.startsWith("/var/")) {
    roots.add(`/private${resolved}`);
  }
  // Longest first so /private/var/... is consumed by its own root before the
  // bare /var/... twin can substring-match inside it.
  return [...roots].toSorted((a, b) => b.length - a.length);
}

// A root match must start a path token: the preceding character (if any) must
// not itself be part of a longer path or word, or /var/... would match inside
// /private/var/... and prose like "supervar/state" would false-positive.
function isPathTokenStart(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  return !/[\w./-]/.test(text.charAt(index - 1));
}

function findPathTokenEnd(text: string, start: number): number {
  for (let i = start; i < text.length; i += 1) {
    if (PATH_TOKEN_END.test(text.charAt(i))) {
      return i;
    }
  }
  return text.length;
}

// Trailing sentence punctuation belongs to the prose, not the path.
function trimTrailingPunctuation(token: string): string {
  return token.replace(/[.,;:!?]+$/, "");
}

/**
 * Redacts absolute managed-media paths in assistant-authored text that do not
 * resolve to a real file. Returns the input unchanged (same reference) when
 * nothing needs redacting so callers can cheaply detect no-ops.
 */
export function redactUngroundedMediaRefs(text: string, options: GroundingOptions = {}): string {
  if (!text.includes("/") && !text.includes("\\")) {
    return text;
  }
  const mediaDir = options.mediaDir ?? getMediaDir();
  // path.win32.isAbsolute accepts POSIX ("/x"), drive ("C:\x"), and UNC
  // shapes, so the guard behaves identically on every host platform.
  if (!mediaDir || !path.win32.isAbsolute(mediaDir)) {
    return text;
  }
  // Canonical media root for the default probe: realpath so an intermediate-dir
  // symlink escape is caught and the macOS /var -> /private/var twin still
  // matches. null when the dir does not resolve on disk, in which case nothing
  // can be grounded and every managed-media token is redacted.
  let mediaRootReal: string | null = null;
  try {
    mediaRootReal = realpathSync(mediaDir);
  } catch {
    mediaRootReal = null;
  }
  const exists =
    options.exists ?? ((candidate: string) => isGroundedRegularFile(candidate, mediaRootReal));
  let result = text;
  for (const root of managedMediaRoots(mediaDir)) {
    // Match against the separator-normalized copy; slice tokens from the
    // original so redaction and fs probes see the authored spelling.
    const searchText = normalizeSeparators(result);
    const rootPattern = new RegExp(`${escapeRegExp(root)}/`, "g");
    let match: RegExpExecArray | null;
    let rebuilt = "";
    let cursor = 0;
    let changed = false;
    while ((match = rootPattern.exec(searchText)) !== null) {
      const tokenStart = match.index;
      if (tokenStart < cursor || !isPathTokenStart(searchText, tokenStart)) {
        continue;
      }
      const tokenEnd = findPathTokenEnd(searchText, tokenStart);
      const token = trimTrailingPunctuation(result.slice(tokenStart, tokenEnd));
      const normalizedToken = normalizeSeparators(token);
      // A token can start with the managed-media root yet use ".." to resolve
      // OUTSIDE it (e.g. "<mediaDir>/../../etc/passwd"). exists() would then
      // probe a real file beyond the sandbox and wrongly preserve a fabricated
      // ref, so require the resolved path to stay contained in the root before
      // trusting the probe; an escaping token is redacted like any ungrounded one.
      const contained = isPathInside(root, normalizedToken);
      if (normalizedToken === `${root}/` || (contained && exists(token))) {
        continue;
      }
      rebuilt += result.slice(cursor, tokenStart) + UNGROUNDED_MEDIA_PLACEHOLDER;
      cursor = tokenStart + token.length;
      changed = true;
    }
    if (changed) {
      result = rebuilt + result.slice(cursor);
    }
  }
  return result;
}
