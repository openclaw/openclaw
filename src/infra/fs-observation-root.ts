import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root, type Root } from "@openclaw/fs-safe/root";

/** Probe a caller-selected prefix without following links or comparing entry names. */
export async function observationPrefixKind(
  authority: Root,
  relative: string,
  signal: AbortSignal,
): Promise<"directory" | "symlink" | "other" | "missing"> {
  const entries = authority.entries("./" + relative, { symlinks: "reject", maxEntries: 1, signal });
  try {
    // The filesystem owns case/short-name lookup. Enumerating a parent and
    // comparing names lexically loses aliases on case-insensitive volumes.
    await entries.next();
    return "directory";
  } catch (error) {
    if (error instanceof FsSafeError) {
      if (error.code === "symlink") {
        return "symlink";
      }
      if (error.code === "not-file") {
        return "other";
      }
      if (error.code === "not-found") {
        return "missing";
      }
    }
    throw error;
  } finally {
    // Do not lose descriptor-close failures when a prefix is classified.
    await entries.return?.();
  }
}

/**
 * Admit an existing prefix of a caller-selected stable boundary, stopping before
 * a symbolic entry. Callers separately admit trusted canonical targets. This is
 * initial source admission only, never a watcher recovery or recursive scanner.
 */
export async function admitObservationRoot(boundary: string): Promise<Root> {
  const absolute = path.resolve(boundary);
  let ancestor = path.parse(absolute).root;
  for (const component of path.relative(ancestor, absolute).split(path.sep).filter(Boolean)) {
    const candidate = path.join(ancestor, component);
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        break;
      }
      ancestor = candidate;
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        (error.code !== "ENOENT" && error.code !== "ENOTDIR")
      ) {
        throw error;
      }
      break;
    }
  }
  return await root(ancestor, { symlinks: "reject" });
}
