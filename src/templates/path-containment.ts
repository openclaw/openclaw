import { relative, sep } from "node:path";
import { resolvePathPrefix } from "@openclaw/fs-safe/advanced";
import { isPathRelativeEscape } from "@openclaw/fs-safe/path";

/** Resolve physical parents without collapsing an unreachable missing suffix. */
export async function resolveTemplateLocalPath(value: string): Promise<string> {
  const { existingPath, unresolvedSegments } = await resolvePathPrefix(value);
  if (unresolvedSegments.length === 0) {
    return existingPath;
  }
  const separator = existingPath.endsWith(sep) ? "" : sep;
  return `${existingPath}${separator}${unresolvedSegments.join(sep)}`;
}

export function templateContainedRelativePath(root: string, target: string): string | undefined {
  const child = relative(root, target);
  // Template file actions require a strict descendant, never the root itself.
  return child !== "" && !isPathRelativeEscape(child) ? child : undefined;
}
