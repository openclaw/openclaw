import { pathDisplayName } from "../../lib/path-display.ts";

export function parentFolderDisplayName(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separator < 0) {
    return undefined;
  }
  const parent = separator === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, separator);
  return pathDisplayName(parent) || undefined;
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}

function comparableAbsolutePath(value: string): string | null {
  if (!isAbsolutePath(value)) {
    return null;
  }
  const path = value.trim().replaceAll("\\", "/");
  const windows = /^[A-Za-z]:\//u.test(path) || path.startsWith("//");
  const parts: string[] = [];
  const floor = /^[A-Za-z]:\//u.test(path) ? 1 : path.startsWith("//") ? 2 : 0;
  for (const part of path.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length > floor) {
        parts.pop();
      }
      continue;
    }
    parts.push(part);
  }
  const prefix = path.startsWith("//") ? "//" : path.startsWith("/") ? "/" : "";
  const normalized = `${prefix}${parts.join("/")}`.replace(/\/+$/u, "") || "/";
  return windows ? normalized.toLowerCase() : normalized;
}

export function sameAbsolutePath(a: string, b: string): boolean {
  const path = comparableAbsolutePath(a);
  return path !== null && path === comparableAbsolutePath(b);
}

/** Client-side affordance check; the Gateway remains the realpath authority. */
export function isKnownWorkspacePath(
  workspaceRoots: readonly string[],
  candidate: string,
): boolean {
  const target = comparableAbsolutePath(candidate);
  return (
    target !== null &&
    workspaceRoots.some((workspace) => {
      const root = comparableAbsolutePath(workspace);
      return (
        root !== null && (target === root || target.startsWith(root === "/" ? root : `${root}/`))
      );
    })
  );
}
