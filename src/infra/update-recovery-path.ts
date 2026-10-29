import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";

export function canonicalEntryPath(value: string): string {
  const absolute = path.resolve(value);
  return path.join(
    resolvePathViaExistingAncestorSync(path.dirname(absolute)),
    path.basename(absolute),
  );
}

/** Resolve only the symlinks recorded in a sealed capture, without consulting live state. */
export function resolveCapturedRegistryPath(
  value: string,
  links: ReadonlyMap<string, string>,
  directories: ReadonlySet<string>,
): string {
  const root = path.parse(value).root;
  if (!root) {
    throw new Error("Captured registry paths must be absolute");
  }
  const split = (text: string) =>
    (path.sep === "\\" ? text.replaceAll("/", "\\") : text).split(path.sep);
  let current = root;
  const parts = split(value.slice(root.length)).toReversed();
  let followed = 0;
  while (parts.length > 0) {
    const part = parts.pop()!;
    if (!part || part === "." || part === "..") {
      if (
        (part === ".." || parts.length === 0) &&
        current !== path.parse(current).root &&
        !directories.has(current)
      ) {
        throw new Error("Captured registry traversal requires a recorded directory");
      }
      if (part === "..") {
        current = path.dirname(current);
      }
      continue;
    }
    current = path.join(current, part);
    const target = links.get(current);
    if (target === undefined) {
      continue;
    }
    if (++followed > 40) {
      throw new Error("Captured registry symlink chain is cyclic or too deep");
    }
    const targetRoot = path.parse(target).root;
    current = targetRoot || path.dirname(current);
    parts.push(...split(target.slice(targetRoot.length)).toReversed());
  }
  return current;
}
