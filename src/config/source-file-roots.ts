import path from "node:path";
import {
  canonicalPathFromExistingAncestor,
  isUnsafeDeviceReadPath,
} from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import type { Root } from "@openclaw/fs-safe/root";
import { admitObservationRoot, observationPrefixKind } from "../infra/fs-observation-root.js";
import { isPathInside } from "../infra/path-guards.js";

export type ConfigObservationRoot = {
  authority: Root;
  /** Allowed include boundaries, not an expansion of the content reader policy. */
  boundaries: string[];
  /** Initial caller-admitted directory aliases, never arbitrary include symlinks. */
  aliases?: ReadonlyMap<string, string>;
  primary?: { source: string; target: string };
};

export type ConfigObservationRootCache = {
  roots: Map<string, Promise<Root>>;
  canonicalBoundaries: Map<string, Promise<string>>;
};

/** Pin observation authority once. Retry uses these same Roots, never replacement identities. */
export async function admitConfigObservationRoots(
  configPath: string,
  includeRoots: readonly string[],
  cache: ConfigObservationRootCache = { roots: new Map(), canonicalBoundaries: new Map() },
  primaryTarget?: string,
): Promise<ConfigObservationRoot[]> {
  const lexicalBoundaries = Array.from(
    new Set([
      path.dirname(path.resolve(configPath)),
      ...includeRoots.filter((entry) => path.isAbsolute(entry)).map((entry) => path.resolve(entry)),
    ]),
  );
  const boundaries = new Set(lexicalBoundaries);
  const aliases = new Map<string, string>();
  // A configured boundary may itself be an alias. Its canonical boundary is
  // operator-admitted; an arbitrary include symlink target is not.
  for (const boundary of lexicalBoundaries) {
    let canonical = cache.canonicalBoundaries.get(boundary);
    if (!canonical) {
      canonical = canonicalPathFromExistingAncestor(boundary);
      cache.canonicalBoundaries.set(boundary, canonical);
      const attempted = canonical;
      void canonical.catch(() => {
        if (cache.canonicalBoundaries.get(boundary) === attempted) {
          cache.canonicalBoundaries.delete(boundary);
        }
      });
    }
    // Retargeting a configured alias does not admit a new canonical boundary.
    // A new explicit boundary needs a caller admission, not an observer retry.
    const target = await canonical;
    boundaries.add(target);
    if (target !== boundary) {
      aliases.set(boundary, target);
    }
  }
  const primarySource = path.resolve(configPath);
  const target = primaryTarget ?? (await canonicalPathFromExistingAncestor(primarySource));
  const primaryBoundary = path.dirname(target);
  const admitted = new Map<string, ConfigObservationRoot>();
  for (const boundary of new Set([...boundaries, primaryBoundary])) {
    let pinned = cache.roots.get(boundary);
    if (!pinned) {
      pinned = (async () => {
        const parent = path.dirname(boundary);
        const stableParent = parent === path.parse(boundary).root ? boundary : parent;
        return await admitObservationRoot(stableParent);
      })();
      cache.roots.set(boundary, pinned);
      const attempted = pinned;
      // Only failed initial admission may retry. A successfully pinned Root is
      // retained even if another boundary fails or its pathname later changes.
      void pinned.catch(() => {
        if (cache.roots.get(boundary) === attempted) {
          cache.roots.delete(boundary);
        }
      });
    }
    const authority = await pinned;
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

export function configObservationEntries(
  admitted: ConfigObservationRoot,
  paths: ReadonlySet<string>,
): Map<string, string> {
  const entries = new Map<string, string>();
  const candidates = new Set(paths);
  for (const candidate of paths) {
    for (const [source, target] of admitted.aliases ?? []) {
      if (isPathInside(source, candidate)) {
        // A missing include has no successful-read canonical provenance yet.
        // Map only the pinned configured directory alias; descendant links
        // still stop at entry scope and never grant target read authority.
        candidates.add(path.resolve(target, path.relative(source, candidate)));
      }
    }
  }
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
    if (
      relative &&
      !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`)
    ) {
      entries.set(relative, candidate);
    }
  }
  return entries;
}

/**
 * Plan scopes and remove invalid candidates from the caller-owned entry map.
 * A rejected include beneath a link observes that link, never its unadmitted target.
 */
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
