import path from "node:path";
import {
  canonicalPathFromExistingAncestor,
  isUnsafeDeviceReadPath,
} from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { isPathRelativeEscape } from "@openclaw/fs-safe/path";
import type { Root } from "@openclaw/fs-safe/root";
import { admitObservationRoot, observationPrefixKind } from "../infra/fs-observation-root.js";
import { isPathInside } from "../infra/path-guards.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";

type ConfigObservationRoot = {
  authority: Root;
  /** Allowed include boundaries, not an expansion of the content reader policy. */
  boundaries: string[];
  /** Initial caller-admitted directory aliases, never arbitrary include symlinks. */
  aliases?: ReadonlyMap<string, string>;
  primary?: { source: string; target: string };
};

type ConfigObservationRootCache = {
  roots: Map<string, Promise<Root>>;
  canonicalBoundaries: Map<string, Promise<string>>;
};

/** Pin observation authority once. Retry uses these same Roots, never replacement identities. */
export async function admitConfigObservationRoots(
  configPath: string,
  includeRoots: readonly string[],
  cache: ConfigObservationRootCache = { roots: new Map(), canonicalBoundaries: new Map() },
  primaryTarget?: string,
  paths: ReadonlySet<string> = new Set(),
): Promise<ConfigObservationRoot[]> {
  const primarySource = path.resolve(configPath);
  const selectedPaths = new Set([primarySource, ...paths]);
  const lexicalBoundaries = Array.from(
    new Set([
      path.dirname(path.resolve(configPath)),
      ...includeRoots.filter((entry) => path.isAbsolute(entry)).map((entry) => path.resolve(entry)),
    ]),
  );
  const boundaries = new Set(lexicalBoundaries);
  const aliases = new Map<string, string>();
  let unresolvedRootFailure: { error: unknown } | undefined;
  // Configured directory aliases admit targets; arbitrary include symlinks do not.
  for (const boundary of lexicalBoundaries) {
    const canonical = getOrCreatePromise(
      cache.canonicalBoundaries,
      boundary,
      () => canonicalPathFromExistingAncestor(boundary),
      { cacheRejections: false },
    );
    try {
      // Retargeting an alias cannot admit a new boundary on retry.
      const target = await canonical;
      boundaries.add(target);
      if (target !== boundary) {
        aliases.set(boundary, target);
      }
    } catch (error) {
      if ([...selectedPaths].some((candidate) => isPathInside(boundary, candidate))) {
        throw error;
      }
      unresolvedRootFailure ??= { error };
      boundaries.delete(boundary);
    }
  }
  const target = primaryTarget ?? (await canonicalPathFromExistingAncestor(primarySource));
  const primaryBoundary = path.dirname(target);
  const candidates = configObservationCandidates(selectedPaths, aliases);
  candidates.add(target);
  // A failed alias can hide an accepted canonical target. Preserve its error
  // unless each selected path still has a known boundary or is the primary file.
  if (
    unresolvedRootFailure &&
    [...candidates].some(
      (candidate) =>
        candidate !== target &&
        ![...boundaries].some((boundary) => isPathInside(boundary, candidate)),
    )
  ) {
    throw unresolvedRootFailure.error;
  }
  const admitted = new Map<string, ConfigObservationRoot>();
  for (const boundary of new Set([...boundaries, primaryBoundary])) {
    const stableParent = path.dirname(boundary);
    // Retry failed admission, never replace a successfully pinned Root.
    const pinned = getOrCreatePromise(
      cache.roots,
      stableParent,
      () => admitObservationRoot(stableParent),
      { cacheRejections: false },
    );
    let authority: Root;
    try {
      authority = await pinned;
    } catch (error) {
      if ([...candidates].some((candidate) => isPathInside(boundary, candidate))) {
        throw error;
      }
      continue;
    }
    let selected = admitted.get(authority.rootDir);
    if (!selected) {
      selected = { authority, boundaries: [], aliases };
      admitted.set(authority.rootDir, selected);
    }
    if (boundaries.has(boundary)) {
      selected.boundaries.push(boundary);
    }
    if (boundary === primaryBoundary) {
      selected.primary = { source: primarySource, target };
    }
  }
  return [...admitted.values()];
}

function configObservationCandidates(
  paths: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string> = new Map(),
): Set<string> {
  const candidates = new Set(paths);
  for (const candidate of paths) {
    for (const [source, target] of aliases) {
      if (isPathInside(source, candidate)) {
        // Missing includes use the configured alias, never descendant link targets.
        candidates.add(path.resolve(target, path.relative(source, candidate)));
      }
    }
  }
  return candidates;
}

export function configObservationEntries(
  admitted: ConfigObservationRoot,
  paths: ReadonlySet<string>,
): Map<string, string> {
  const entries = new Map<string, string>();
  const candidates = configObservationCandidates(paths, admitted.aliases);
  if (admitted.primary && paths.has(admitted.primary.source)) {
    candidates.add(admitted.primary.target);
  }
  for (const candidate of candidates) {
    if (
      candidate !== admitted.primary?.target &&
      !admitted.boundaries.some((boundary) => isPathInside(boundary, candidate))
    ) {
      continue;
    }
    const relative = path.relative(admitted.authority.rootDir, candidate) || ".";
    if (!isPathRelativeEscape(relative)) {
      entries.set(relative, candidate);
    }
  }
  return entries;
}

/** Rejected includes beneath links observe the link; unwatchable candidates are omitted. */
export async function configObservationScopes(
  authority: Root,
  entries: Map<string, string>,
  signal: AbortSignal,
  requiredPath?: string,
): Promise<Array<{ path: string; kind: "entry" }>> {
  const scopes = new Set<string>();
  for (const [relative, absolute] of entries) {
    let selected = relative;
    let parent = ".";
    try {
      const components = relative.split(path.sep).filter((part) => part && part !== ".");
      if (
        process.platform === "win32" &&
        components.some(
          (component) =>
            component.endsWith(".") ||
            component.endsWith(" ") ||
            isUnsafeDeviceReadPath(component, { platform: "win32" }),
        )
      ) {
        throw new FsSafeError("invalid-path", "Config watch scopes require literal Windows names");
      }
      for (const component of components) {
        signal.throwIfAborted();
        parent = path.join(parent, component);
        const kind = await observationPrefixKind(authority, parent, signal);
        if (kind === "missing") {
          break;
        }
        if (kind !== "directory") {
          selected = parent;
          break;
        }
      }
    } catch (error) {
      // Read failures retain lexical include candidates, including names the
      // observer cannot admit. Keep the primary and other includes observable.
      if (
        absolute !== requiredPath &&
        error instanceof FsSafeError &&
        error.code === "invalid-path"
      ) {
        entries.delete(relative);
        continue;
      }
      throw error;
    }
    scopes.add(selected);
  }
  return [...scopes].map((relative) => ({ path: relative, kind: "entry" }));
}
