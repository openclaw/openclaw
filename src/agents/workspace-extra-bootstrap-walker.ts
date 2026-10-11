/**
 * Extra bootstrap file glob resolution.
 *
 * Resolves `**\/AGENTS.md`-style extra-bootstrap patterns with Node's async
 * `fs.promises.glob`, which awaits per-directory lstat/readdir and keeps the
 * event loop live during embedded_run bootstrap-context. fs.glob owns matching
 * (dot rules, platform case, `..`, literal-named directory symlinks); this
 * module only filters each match to a workspace-contained realpath, a boundary
 * fs.glob does not enforce, so out-of-workspace bootstrap content never reaches
 * the prompt.
 *
 * fs.glob is absent on some runtimes (older Node, certain Bun builds). A narrow
 * capability fallback resolves the same pattern with a local Minimatch directory
 * walk there, so a configured glob still loads its files instead of throwing
 * into the loader's `io` diagnostic and dropping the whole configured set. The
 * same walk also recovers a non-ENOENT fs.glob failure: the resolver reports the
 * original error as `nativeGlobError` so the loader can warn, while readable
 * matches still load. Fallback matches pass through the same realpath
 * containment filter as the fs.glob path.
 */
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { braceExpand, Minimatch } from "minimatch";
import { isPathInside } from "../infra/path-guards.js";
import { hasGlobPattern, normalizeWorkspacePatternPath } from "./workspace-bootstrap-policy.js";

// Minimatch options for the fallback matcher and its brace expansion, kept in one
// place so the matcher, the brace expansion, and the per-segment magic check all
// agree on grammar. Default Minimatch treats `[ab]` as a character class, so a
// bracket segment counts as magic here — consistent, because a fully-literal
// bracket path (`pkg[ab]/AGENTS.md`) is routed to the literal reader by the
// loader and never reaches this walk. Case handling mirrors Node fs.glob's
// matcher (case-insensitive wildcards on macOS and Windows). Its
// `optimizationLevel: 2` is deliberately not copied: that rewrites `**/../x` to
// `{..,**}/x`, which only Node's own walker interprets correctly; a downward walk
// would turn it into a superset of fs.glob's matches.
const EXTRA_BOOTSTRAP_FALLBACK_MINIMATCH_OPTIONS = {
  nocase: process.platform === "darwin" || process.platform === "win32",
  nocaseMagicOnly: true,
  nocomment: true,
  nonegate: true,
  platform: process.platform,
  windowsPathsNoEscape: true,
} as const;

// Fold ONLY the platform separator in an fs.glob match, never backslashes: a
// backslash is a legal POSIX filename byte, so rewriting it (as the pattern-side
// normalization does) would point the loader at a different, missing path and
// silently drop the file. Windows folding stays lossless — its names cannot hold
// a backslash. `separator` is injectable so both branches get test coverage on
// one platform.
export function toPortableMatchPath(match: string, separator: string = path.sep): string {
  return match.replaceAll(separator, "/");
}

// Leading literal directory prefix of a glob-routed pattern: the security
// pre-gate realpaths it to decide whether a pattern rooted at a literal directory
// symlink escapes the workspace before fs.glob reads there, and the
// fs.glob-absent fallback roots its walk there. It must be where fs.glob roots
// its walk, so it comes from the matcher's parsed segments rather than raw text:
// the leading literal segments shared by every brace alternative, never the
// final segment. A bracket class (`pkg[ab]/*`), extglob, or alternation
// (`{a,b}/…`, including one spanning a `/`) collapses the prefix there; an
// escaped class (`[[]ab]`) or an unmatched `]` stays literal, so
// `/srv/workspace]/*/AGENTS.md` keeps the workspace as its root. Fully-literal
// patterns never come here: the pre-gate checks their exact path.
function literalPatternPrefix(pattern: string): string {
  const { set } = new Minimatch(
    normalizeWorkspacePatternPath(pattern),
    EXTRA_BOOTSTRAP_FALLBACK_MINIMATCH_OPTIONS,
  );
  const [first = []] = set;
  const literal: string[] = [];
  for (let index = 0; index < first.length - 1; index++) {
    const segment = first[index];
    if (typeof segment !== "string" || set.some((parts) => parts[index] !== segment)) {
      break;
    }
    literal.push(segment);
  }
  return literal.join("/") || ".";
}

// Whether a brace-free pattern segment is a wildcard the fallback matcher treats
// as magic (`?`, `*`, `**`, a bracket class, an extglob). Used only to decide
// symlink descent: fs.glob follows a directory symlink solely when a LITERAL
// segment names it, so a magic segment leaves the link terminal.
function patternSegmentIsMagic(segment: string): boolean {
  return new Minimatch(segment, EXTRA_BOOTSTRAP_FALLBACK_MINIMATCH_OPTIONS).hasMagic();
}

// Whether a directory segment satisfies one pattern segment, via the same
// Minimatch grammar as the rest of the fallback. Deliberately NOT `path.matchesGlob`:
// it is absent on the runtimes this fallback exists for (Node ships fs.glob at 22.0
// but matchesGlob only at 22.5; some Bun builds ship neither), so calling it would
// throw the moment symlink descent aligns a segment and drop the whole bootstrap set.
function patternSegmentMatches(segment: string, patternSegment: string): boolean {
  return new Minimatch(patternSegment, EXTRA_BOOTSTRAP_FALLBACK_MINIMATCH_OPTIONS).match(segment);
}

// Ancestor node for the active descent path in the fallback walk. `symlinkDepths`
// holds the 0-based path-segment indices at which a directory symlink was
// followed to reach this frame. It is what makes the walk terminate without a
// realpath cycle guard: a symlink is descended only when symlinkDescentAllowed
// aligns it against a LITERAL pattern segment whose preceding `**` did not consume
// one of these depths, so globstar can never re-cross a contained ancestor link
// (`a/loop -> a`, `self -> .`). Each followed link therefore advances past a
// distinct literal pattern segment, and a pattern has finitely many, so the walk
// is bounded — and two distinct links to the same target (`link-a`, `link-b` ->
// target) are both followed, because descent is decided by pattern position, not
// by the target's realpath.
type FallbackWalkFrame = { relativeDir: string; symlinkDepths: ReadonlySet<number> };

// Decide whether a directory symlink at the current walk depth should be
// descended, mirroring Node fs.glob's symlink rule for one brace-free
// alternative: a directory symlink is followed only when its own path segment is
// named by a LITERAL pattern segment whose immediately-preceding pattern segment
// is not `**`. A symlink consumed by a wildcard (`*`/`**`), or one sitting
// directly after a `**` recursive prefix, is never followed even when a later
// literal names it. `ancestorSymlinkDepths` holds the 0-based path indices
// already reached by following a symlink; a `**` may not consume one of them
// because globstar never traverses INTO a symlink (see FallbackWalkFrame), which
// is what bounds a cycle.
function symlinkDescentAllowed(
  dirSegments: string[],
  patternSegments: string[],
  ancestorSymlinkDepths: ReadonlySet<number>,
): boolean {
  const dirLength = dirSegments.length;
  const patternLength = patternSegments.length;
  const lastDirIndex = dirLength - 1;
  const literalNotAfterRecursive = (patternIndex: number): boolean =>
    !patternSegmentIsMagic(patternSegments[patternIndex]!) &&
    (patternIndex === 0 || patternSegments[patternIndex - 1] !== "**");
  const align = (dirIndex: number, patternIndex: number): boolean => {
    if (dirIndex === dirLength || patternIndex === patternLength) {
      return false;
    }
    const segment = dirSegments[dirIndex]!;
    const patternSegment = patternSegments[patternIndex]!;
    if (patternSegment === "**") {
      // `**` matches zero segments: try the pattern past it against this segment.
      if (align(dirIndex, patternIndex + 1)) {
        return true;
      }
      // `**` never consumes the final symlink segment (that is wildcard-reached),
      // never crosses a leading-dot segment, and never crosses an already-followed
      // symlink: letting a leading `**` absorb an ancestor link would re-cross a
      // contained ancestor-pointing link on every pass and never terminate.
      if (
        dirIndex === lastDirIndex ||
        segment.startsWith(".") ||
        ancestorSymlinkDepths.has(dirIndex)
      ) {
        return false;
      }
      return align(dirIndex + 1, patternIndex);
    }
    if (!patternSegmentMatches(segment, patternSegment)) {
      return false;
    }
    if (dirIndex === lastDirIndex) {
      // Final (symlink) segment: descend only when named by a literal that does
      // not sit directly after a `**`.
      return literalNotAfterRecursive(patternIndex);
    }
    return align(dirIndex + 1, patternIndex + 1);
  };
  return align(0, 0);
}

// A literal-named directory symlink is descended like a directory when its target
// resolves to a directory; a stat failure (dangling/ELOOP cycle) means "do not
// descend", so mutual and self links terminate. Containment is NOT re-checked
// here — the resolver's shared realpath filter drops any match whose canonical
// path escapes the workspace, so an escaping link is descended but yields nothing.
async function fallbackSymlinkTargetIsDirectory(childAbs: string): Promise<boolean> {
  try {
    // fs.stat follows the link; only a directory target is walked into.
    return (await fs.stat(childAbs)).isDirectory();
  } catch {
    return false;
  }
}

// fs.glob-absent fallback matcher (older Node / some Bun builds): resolve the
// pattern with a local Minimatch directory walk, yielding workspace-relative
// matches for the shared realpath-containment filter in the resolver. A subtree
// that cannot be read is skipped, not thrown — mirroring how fs.glob walks past
// an unreadable branch, so an unreadable sibling package never aborts loading of
// a readable one. Literal-named directory symlinks are followed exactly where
// fs.glob follows them (see symlinkDescentAllowed), so a bootstrap file behind a
// symlinked package directory still loads here. Yields the raw separator-joined
// relative path (backslashes preserved) so the caller's toPortableMatchPath folds
// only the platform separator, exactly as on the fs.glob path.
//
// Node's globber walks each brace alternative with its own traversal state
// (`pkg/{linked,other}/**` -> `pkg/linked/**` and `pkg/other/**`), so each
// alternative is walked independently here: one alternative's literal symlink
// segment must not let another alternative match below that link. A path
// reached by several alternatives is yielded once per alternative; the resolver
// collects matches into a set and the loader dedupes failures.
async function* walkFallbackMatches(
  workspaceDir: string,
  normalizedPattern: string,
): AsyncGenerator<string> {
  for (const alternative of braceExpand(
    normalizedPattern,
    EXTRA_BOOTSTRAP_FALLBACK_MINIMATCH_OPTIONS,
  )) {
    yield* walkFallbackAlternative(workspaceDir, alternative);
  }
}

async function* walkFallbackAlternative(
  workspaceDir: string,
  alternative: string,
): AsyncGenerator<string> {
  const matcher = new Minimatch(alternative, EXTRA_BOOTSTRAP_FALLBACK_MINIMATCH_OPTIONS);
  // fs.glob yields a directory (or descended directory symlink) that fully matches
  // the pattern, not just files, so the fallback must too or it silently drops the
  // match. The trailing-slash form covers directory-only patterns (`pkg/*/`), which
  // Minimatch full-matches only against `dir/`, never `dir`.
  const patternMatchesDirectory = (key: string): boolean =>
    matcher.match(key, false) || matcher.match(`${key}/`, false);
  const patternSegments = alternative.split("/");
  // Root the local scan where fs.glob would root its walk (`packages/[ab]/*`
  // roots at `packages`) instead of always re-reading from the workspace root.
  const walkRoot = literalPatternPrefix(alternative);
  const stack: FallbackWalkFrame[] = [
    { relativeDir: walkRoot === "." ? "" : walkRoot, symlinkDepths: new Set() },
  ];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) {
      continue;
    }
    const currentRelativeDir = frame.relativeDir;
    const currentDir = path.resolve(workspaceDir, currentRelativeDir);
    if (!isPathInside(workspaceDir, currentDir)) {
      continue;
    }
    let entries: syncFs.Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRelativePath = currentRelativeDir
        ? path.join(currentRelativeDir, entry.name)
        : entry.name;
      const matchKey = toPortableMatchPath(childRelativePath);
      if (entry.isDirectory()) {
        // A directory that fully matches is a match in its own right (fs.glob parity),
        // independent of whether it is also a descent prefix below.
        if (patternMatchesDirectory(matchKey)) {
          yield childRelativePath;
        }
        // Descend only where a partial match can still be completed: a shallow
        // pattern never enters a deeper subtree, bounding the walk to fs.glob's. A
        // real directory is never a symlink crossing, so inherit the parent's
        // followed-symlink depths unchanged.
        if (matcher.match(matchKey, true)) {
          stack.push({ relativeDir: childRelativePath, symlinkDepths: frame.symlinkDepths });
        }
        continue;
      }
      if (entry.isSymbolicLink()) {
        const childSegments = matchKey.split("/");
        // A literal-named directory symlink not sitting after a `**` is descended
        // like a directory (same partial-match prune), so a package linked into the
        // workspace still resolves. The recorded depth stops a deeper `**` from
        // re-crossing this link, which is what terminates a symlink cycle.
        if (
          symlinkDescentAllowed(childSegments, patternSegments, frame.symlinkDepths) &&
          matcher.match(matchKey, true) &&
          (await fallbackSymlinkTargetIsDirectory(path.resolve(workspaceDir, childRelativePath)))
        ) {
          // A descended directory symlink that also fully matches is itself a match
          // (fs.glob parity), the same directory full-match yield as the plain
          // directory branch above.
          if (patternMatchesDirectory(matchKey)) {
            yield childRelativePath;
          }
          const childSymlinkDepths = new Set(frame.symlinkDepths);
          childSymlinkDepths.add(childSegments.length - 1);
          stack.push({ relativeDir: childRelativePath, symlinkDepths: childSymlinkDepths });
          continue;
        }
        // Not descended: the link is a terminal leaf candidate, yielded like a file
        // only on a full match. The explicit `partial=false` keeps the Minimatch
        // two-argument call shape shared with the other match sites.
        if (matcher.match(matchKey, false)) {
          yield childRelativePath;
        }
        continue;
      }
      if (entry.isFile() && matcher.match(matchKey)) {
        yield childRelativePath;
      }
    }
  }
}

// A matched path the resolver could not canonicalize (a non-ENOENT realpath
// fault: EACCES/ELOOP/…). Recorded per match instead of aborting the walk, so a
// readable sibling still resolves; the loader surfaces each as its own
// diagnostic keyed to `path` (the match as yielded, like the returned match
// keys). `detail` carries the underlying fs error message. Module-local:
// callers consume it structurally through the exported `ExtraBootstrapResolution`
// return shape, so it needs no export of its own.
type ExtraBootstrapMatchFailure = { path: string; detail: string };

// Resolver result: readable matches plus per-match canonicalization failures.
// The failures list preserves the specific unreadable matched paths so the
// loader reports each individually rather than collapsing a whole pattern.
// `nativeGlobError` is set when fs.glob failed for a non-ENOENT reason and the
// matches came from the fallback walk instead.
export type ExtraBootstrapResolution = {
  matches: string[];
  failures: ExtraBootstrapMatchFailure[];
  nativeGlobError?: string;
};

// Resolve a glob pattern to workspace-relative POSIX paths, keeping only matches
// whose realpath stays inside the workspace root. fs.glob owns matching where
// available; a runtime without it uses the local Minimatch walk fallback.
export async function resolveExtraBootstrapPatternPaths(
  workspaceDir: string,
  pattern: string,
): Promise<ExtraBootstrapResolution> {
  const normalizedPattern = normalizeWorkspacePatternPath(pattern);
  // Canonical workspace root bounds containment: a symlinked workspace dir
  // (macOS /var -> /private/var) must compare against its realpath, not its
  // lexical path, or every contained match would be rejected.
  let workspaceRealpath: string;
  try {
    workspaceRealpath = await fs.realpath(workspaceDir);
  } catch {
    workspaceRealpath = path.resolve(workspaceDir);
  }
  const matches = new Set<string>();
  const failures: ExtraBootstrapMatchFailure[] = [];
  // Single async pass over one match source. fs.glob resolves `..` (a globstar
  // parent steps above cwd) and follows literal-named directory symlinks out of
  // the tree; the realpath containment filter drops any match that escapes the
  // workspace so those never enter the prompt. The fallback walk yields the same
  // shape and shares this filter.
  const collect = async (matchSource: AsyncIterable<string>) => {
    for await (const relativeMatch of matchSource) {
      const absolute = path.resolve(workspaceDir, relativeMatch);
      let realpath: string;
      try {
        realpath = await fs.realpath(absolute);
      } catch (error) {
        // ENOENT here is a benign delete-race: the entry vanished between
        // fs.glob yielding it and this realpath, so skip that one match. Any
        // other failure (EACCES/ELOOP/…) is a real fault on this matched file,
        // recorded against its own path and skipped so readable sibling matches
        // still resolve. The loader turns each recorded failure into its own
        // operator-visible `io` diagnostic keyed to that matched path — per-match
        // isolation, replacing the earlier all-or-nothing pattern-level throw.
        // SAFETY: Node fs failures carry an ErrnoException-shaped `code`; the cast only reads that property.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        failures.push({
          path: toPortableMatchPath(relativeMatch),
          detail: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (isPathInside(workspaceRealpath, realpath)) {
        matches.add(toPortableMatchPath(relativeMatch));
      }
    }
  };
  // Capability branch: the local walk keeps configured patterns resolving where
  // fs.glob is absent.
  if (typeof fs.glob !== "function") {
    await collect(walkFallbackMatches(workspaceDir, normalizedPattern));
    return { matches: [...matches], failures };
  }
  try {
    // fs.glob gets the configured pattern unchanged: its matcher already folds
    // backslashes, and a leading `./` changes how it treats symlinks under `**`.
    // The call sits inside the try so a synchronous throw is recovered too.
    await collect(fs.glob(pattern, { cwd: workspaceDir }));
  } catch (error) {
    // fs.glob walks past per-entry read failures (an unreadable subtree is
    // skipped, not thrown), so a throw here is a top-level failure. A missing
    // cwd (ENOENT) legitimately means "no matches".
    // SAFETY: Node fs failures carry an ErrnoException-shaped `code`; the cast only reads that property.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { matches: [...matches], failures };
    }
    // Any other failure falls back to the local walk so readable bootstrap files
    // still load; partial fs.glob results are discarded so the fallback owns the
    // whole answer. The loader logs `nativeGlobError` as a warning.
    matches.clear();
    failures.length = 0;
    await collect(walkFallbackMatches(workspaceDir, normalizedPattern));
    return {
      matches: [...matches],
      failures,
      nativeGlobError: error instanceof Error ? error.message : String(error),
    };
  }
  return { matches: [...matches], failures };
}

// Loader security pre-gate: reject a pattern whose walk root escapes the
// workspace so the loader surfaces a `security` diagnostic instead of a silent
// empty resolve. A glob-routed pattern is checked at its leading literal prefix;
// a fully-literal pattern at the exact path the loader reads, so a POSIX
// filename holding a backslash is not checked under a different `/`-split path.
// Lexical containment first (a literal `../outside` prefix), then realpath
// containment: a literal-prefix directory symlink can point outside the
// workspace while staying lexically inside (`linked/**` where `linked` ->
// /external), and fs.glob would resolve that external target. A root that does
// not exist yet has no realpath — fall through to the lexical result, since the
// glob simply finds nothing there.
export async function patternWalkRootStaysInWorkspace(
  workspaceDir: string,
  pattern: string,
): Promise<boolean> {
  const walkRoot = path.resolve(
    workspaceDir,
    hasGlobPattern(pattern) ? literalPatternPrefix(pattern) : pattern,
  );
  if (!isPathInside(workspaceDir, walkRoot)) {
    return false;
  }
  let workspaceRealpath: string;
  try {
    workspaceRealpath = await fs.realpath(workspaceDir);
  } catch {
    return true;
  }
  let rootRealpath: string;
  try {
    rootRealpath = await fs.realpath(walkRoot);
  } catch {
    return true;
  }
  return isPathInside(workspaceRealpath, rootRealpath);
}
