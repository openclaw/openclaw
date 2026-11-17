import { realpath } from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "../utils.js";

export function normalizeWorkspaceDir(workspaceDir?: string): string | null {
  const trimmed = workspaceDir?.trim();
  if (!trimmed) {
    return null;
  }
  const expanded = trimmed.startsWith("~") ? resolveUserPath(trimmed) : trimmed;
  const resolved = path.resolve(expanded);
  // Refuse filesystem roots as "workspace" (too broad; almost always a bug).
  if (resolved === path.parse(resolved).root) {
    return null;
  }
  return resolved;
}

export function resolveWorkspaceRoot(workspaceDir?: string): string {
  return normalizeWorkspaceDir(workspaceDir) ?? process.cwd();
}

/** Preserve exact matches; resolve distinct spellings to their current shared root. */
export async function resolveMatchingWorkspaceRoot(
  left: string,
  right: string,
): Promise<string | undefined> {
  if (left === right) {
    return left;
  }
  try {
    const [leftRoot, rightRoot] = await Promise.all([realpath(left), realpath(right)]);
    return leftRoot === rightRoot ? leftRoot : undefined;
  } catch {
    // Missing or unreadable paths cannot establish a shared physical root.
    return undefined;
  }
}
