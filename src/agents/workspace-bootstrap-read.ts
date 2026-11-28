import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import { MAX_IDENTITY_FILE_BYTES, projectIdentityMarkdownForPrompt } from "./identity-markdown.js";
import {
  DEFAULT_IDENTITY_FILENAME,
  type WorkspaceBootstrapFile,
} from "./workspace-bootstrap-policy.js";

// Model text stays bounded independently from IDENTITY.md's supported inline avatar.
export const MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES = 2 * 1024 * 1024;

export function workspaceBootstrapFileReadLimit(name?: string): number {
  return name === DEFAULT_IDENTITY_FILENAME
    ? MAX_IDENTITY_FILE_BYTES
    : MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES;
}

export async function readWorkspaceBootstrapFile(fd: number, name?: string): Promise<string> {
  return (await readFileDescriptorBounded(fd, workspaceBootstrapFileReadLimit(name))).toString(
    "utf-8",
  );
}

export function projectWorkspaceBootstrapFileForPrompt(content: string, name: string): string {
  const projected =
    name === DEFAULT_IDENTITY_FILENAME ? projectIdentityMarkdownForPrompt(content) : content;
  if (Buffer.byteLength(projected) > MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES) {
    throw new RangeError(
      `Workspace bootstrap text exceeds ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES} bytes`,
    );
  }
  return projected;
}

/** A guarded-read diagnostic is not the workspace instructions it replaced. */
export function isUnreadableWorkspaceBootstrapFile(file: WorkspaceBootstrapFile): boolean {
  return !file.missing && file.content?.startsWith("[UNREADABLE: ") === true;
}
