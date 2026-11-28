import type { SessionWorkspaceGetResult } from "../../../api/types.ts";

export function workspaceBrowserFilePath(root: string | undefined, filePath: string): string {
  if (!root || /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(filePath)) {
    return filePath;
  }
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  const relative = filePath.replace(/^[\\/]+/, "").replaceAll(/[\\/]/g, separator);
  return base ? `${base}${separator}${relative}` : `${separator}${relative}`;
}

/**
 * The path to hand to the clipboard for a catalog file. "workspace"-origin
 * paths are relative to the workspace root, so they are joined with it;
 * "session"-origin paths are session-cwd-relative and cannot be resolved to
 * an absolute location from here.
 */
export function workspaceFileCopyPath(
  root: string | undefined,
  origin: "session" | "workspace",
  filePath: string,
): string {
  return origin === "workspace" ? workspaceBrowserFilePath(root, filePath) : filePath;
}

export function readWorkspaceFileText(
  file: SessionWorkspaceGetResult["file"] | undefined,
): string | null {
  return file?.previewKind === "text" &&
    file.contentEncoding === "utf8" &&
    typeof file.content === "string"
    ? file.content
    : null;
}
