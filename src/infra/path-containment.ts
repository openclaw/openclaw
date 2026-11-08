// Owns path spelling for containment decisions: every root and candidate compared for
// "is this inside an allowed folder" resolves through the same function (#194406).
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "./errno.js";
import { isPathInside } from "./path-guards.js";

/** Why a path has no canonical spelling; callers treat all of these as outside. */
export type UncanonicalReason = "parent-after-missing" | "unreadable" | "link-loop";

export type ContainmentPath =
  | {
      kind: "resolved";
      path: string;
      /** First dangling symlink followed on the way; the target it names does not exist yet. */
      danglingLink?: string;
    }
  | { kind: "unresolved"; reason: UncanonicalReason; prefix: string };

const MAX_DANGLING_LINK_HOPS = 32;

// One walk serves sync and async callers: it yields filesystem probes and the driver answers
// them, so both entry points share every rule below.
type Probe = { op: "realpath" | "readlink" | "lstat"; path: string };
type ProbeResult = { ok: true; value: string } | { ok: false; error: unknown };

function* walkForContainment(
  candidate: string,
  hops: number,
): Generator<Probe, ContainmentPath, ProbeResult> {
  const absolute = path.isAbsolute(candidate)
    ? candidate
    : `${process.cwd()}${path.sep}${candidate}`;
  const root = path.parse(absolute).root;
  const segments = absolute
    .slice(root.length)
    .split(path.sep === "\\" ? /[\\/]/ : "/")
    .filter((segment) => segment !== "" && segment !== ".");
  for (let end = segments.length; end >= 0; end -= 1) {
    const missing = segments.slice(end);
    const prefix = root + segments.slice(0, end).join(path.sep);
    if (missing.includes("..")) {
      return { kind: "unresolved", reason: "parent-after-missing", prefix };
    }
    const real = yield { op: "realpath", path: prefix };
    if (real.ok) {
      return { kind: "resolved", path: path.join(real.value, ...missing) };
    }
    if (!isMissingPathError(real.error)) {
      const looping = (real.error as NodeJS.ErrnoException | undefined)?.code === "ELOOP";
      return { kind: "unresolved", reason: looping ? "link-loop" : "unreadable", prefix };
    }
    const link = yield { op: "readlink", path: prefix };
    if (link.ok) {
      // A dangling link: continue from the location it names, keeping the unresolved suffix.
      if (hops <= 0) {
        return { kind: "unresolved", reason: "link-loop", prefix };
      }
      const next = path.isAbsolute(link.value)
        ? link.value
        : `${path.dirname(prefix)}${path.sep}${link.value}`;
      const followed = yield* walkForContainment([next, ...missing].join(path.sep), hops - 1);
      return followed.kind === "resolved"
        ? { ...followed, danglingLink: followed.danglingLink ?? prefix }
        : followed;
    }
    if ((yield { op: "lstat", path: prefix }).ok) {
      return { kind: "unresolved", reason: "unreadable", prefix };
    }
  }
  return { kind: "unresolved", reason: "unreadable", prefix: root };
}

// Native realpath(3) resolves ".." after each link the way the kernel does; Node's JS
// fs.realpath normalizes the string first, which would fold "link/.." lexically.
function realpathNative(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.realpath.native(target, (error, resolved) => (error ? reject(error) : resolve(resolved)));
  });
}

function answerSync(probe: Probe): ProbeResult {
  try {
    if (probe.op === "lstat") {
      fs.lstatSync(probe.path);
      return { ok: true, value: probe.path };
    }
    const value =
      probe.op === "realpath" ? fs.realpathSync.native(probe.path) : fs.readlinkSync(probe.path);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

async function answerAsync(probe: Probe): Promise<ProbeResult> {
  try {
    if (probe.op === "lstat") {
      await fsPromises.lstat(probe.path);
      return { ok: true, value: probe.path };
    }
    const value =
      probe.op === "realpath"
        ? await realpathNative(probe.path)
        : await fsPromises.readlink(probe.path);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Canonicalizes a path to where the kernel would land, through its longest existing prefix.
 *
 * ".." is never folded lexically: the kernel resolves it inside existing prefixes, and a ".."
 * after a missing segment has no canonical meaning until that segment exists (it could become a
 * symlink). Only definite absence falls back to a parent. A dangling symlink is followed through
 * its stored target, so the result names the location a create or read would actually reach; an
 * unreadable or looping prefix has no knowable target and is reported instead of guessed.
 */
export async function canonicalizeForContainment(candidate: string): Promise<ContainmentPath> {
  const walk = walkForContainment(candidate, MAX_DANGLING_LINK_HOPS);
  let step = walk.next();
  while (!step.done) {
    step = walk.next(await answerAsync(step.value));
  }
  return step.value;
}

/** Synchronous counterpart for callers whose surrounding contract is synchronous. */
export function canonicalizeForContainmentSync(candidate: string): ContainmentPath {
  const walk = walkForContainment(candidate, MAX_DANGLING_LINK_HOPS);
  let step = walk.next();
  while (!step.done) {
    step = walk.next(answerSync(step.value));
  }
  return step.value;
}

/** Canonical spelling for containment, or undefined when it cannot be known safely. */
export async function realpathViaExistingPrefix(candidate: string): Promise<string | undefined> {
  const resolved = await canonicalizeForContainment(candidate);
  return resolved.kind === "resolved" ? resolved.path : undefined;
}

/** Synchronous counterpart of `realpathViaExistingPrefix`. */
export function realpathViaExistingPrefixSync(candidate: string): string | undefined {
  const resolved = canonicalizeForContainmentSync(candidate);
  return resolved.kind === "resolved" ? resolved.path : undefined;
}

/** Canonical root spelling; configured roots are trusted, so ".." folds lexically first. */
export async function canonicalizeContainmentRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  return (await realpathViaExistingPrefix(resolved)) ?? resolved;
}

/** Synchronous counterpart of `canonicalizeContainmentRoot`, for trusted recorded paths. */
export function canonicalizeContainmentRootSync(root: string): string {
  const resolved = path.resolve(root);
  return realpathViaExistingPrefixSync(resolved) ?? resolved;
}

/**
 * Re-spells a candidate under the caller's own spelling of root when both canonicalize to a
 * containing pair, so lexical checks that follow (and alias-escape walks) see one spelling.
 */
export async function respellUnderRoot(
  root: string,
  candidate: string,
): Promise<string | undefined> {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    canonicalizeContainmentRoot(root),
    realpathViaExistingPrefix(candidate),
  ]);
  if (!canonicalCandidate || !isPathInside(canonicalRoot, canonicalCandidate)) {
    return undefined;
  }
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative ? path.join(path.resolve(root), relative) : path.resolve(root);
}

/** Synchronous counterpart of `respellUnderRoot`. */
export function respellUnderRootSync(root: string, candidate: string): string | undefined {
  const canonicalRoot = canonicalizeContainmentRootSync(root);
  const canonicalCandidate = realpathViaExistingPrefixSync(candidate);
  if (!canonicalCandidate || !isPathInside(canonicalRoot, canonicalCandidate)) {
    return undefined;
  }
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative ? path.join(path.resolve(root), relative) : path.resolve(root);
}

/** True when the candidate canonically lies inside any root (routing, not authorization). */
export async function isCanonicallyInsideAny(
  roots: readonly string[],
  candidate: string,
): Promise<boolean> {
  if (roots.length === 0) {
    return false;
  }
  const [canonicalCandidate, canonicalRoots] = await Promise.all([
    realpathViaExistingPrefix(candidate),
    Promise.all(roots.map(canonicalizeContainmentRoot)),
  ]);
  return (
    canonicalCandidate !== undefined &&
    canonicalRoots.some((root) => isPathInside(root, canonicalCandidate))
  );
}
