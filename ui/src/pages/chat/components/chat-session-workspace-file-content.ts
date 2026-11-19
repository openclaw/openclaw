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

export function readWorkspaceFileText(
  file: SessionWorkspaceGetResult["file"] | undefined,
): string | null {
  return file?.previewKind === "text" &&
    file.contentEncoding === "utf8" &&
    typeof file.content === "string"
    ? file.content
    : null;
}
