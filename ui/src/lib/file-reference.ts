/**
 * Shared file identity and action contract used by chat, workspace and
 * artifact previews.  A reference never carries an arbitrary local path:
 * workspace/session entries are relative and artifacts are addressed by id.
 */
type FileOrigin = "chat" | "session" | "workspace" | "artifact";

export interface FileReference {
  origin: FileOrigin;
  sessionKey?: string;
  agentId?: string;
  relativePath?: string;
  artifactId?: string;
  name: string;
  mime?: string;
  size?: number;
  hash?: string;
}

export type FileAction =
  | "preview"
  | "copyFullPath"
  | "copyRelativePath"
  | "copyFilename"
  | "copyContents"
  | "download"
  | "openInEditor"
  | "revealInFileManager"
  | "openWorkspaceRoot"
  | "refresh";

// Drive-relative paths such as C:notes.txt are not workspace-relative.
const NON_RELATIVE_PATH = /^(?:[a-z]:|[\\/])/i;

/** Normalize a workspace path without ever resolving it against the host FS. */
function normalizeRelativePath(value: string): string | null {
  if (!value || value.includes("\0") || NON_RELATIVE_PATH.test(value)) {
    return null;
  }
  const parts = value.replaceAll("\\", "/").split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      return null;
    }
    normalized.push(part);
  }
  return normalized.length > 0 ? normalized.join("/") : null;
}

export function isSafeFileReference(reference: FileReference): boolean {
  if (!reference.name || reference.name.includes("\0")) {
    return false;
  }
  if (reference.origin === "artifact") {
    return typeof reference.artifactId === "string" && reference.artifactId.length > 0;
  }
  if (
    reference.origin === "session" ||
    reference.origin === "chat" ||
    reference.origin === "workspace"
  ) {
    return (
      typeof reference.sessionKey === "string" &&
      reference.sessionKey.length > 0 &&
      normalizeRelativePath(reference.relativePath ?? "") !== null
    );
  }
  return normalizeRelativePath(reference.relativePath ?? "") !== null;
}

/** Return only actions which can be handled without an arbitrary filesystem path. */
export function availableFileActions(
  reference: FileReference,
  options: { localGateway?: boolean; hasContents?: boolean } = {},
): readonly FileAction[] {
  if (!isSafeFileReference(reference)) {
    return [];
  }
  const actions: FileAction[] = ["preview", "copyFilename", "download", "refresh"];
  if (options.hasContents) {
    actions.push("copyContents");
  }
  if (reference.origin === "workspace" || reference.origin === "session") {
    actions.push("copyRelativePath", "openWorkspaceRoot");
  }
  if (options.localGateway && reference.origin !== "artifact") {
    actions.push("copyFullPath", "revealInFileManager");
  }
  return actions;
}
