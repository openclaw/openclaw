import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import type { WorkspaceBootstrapFile } from "./workspace-bootstrap-policy.js";

// Workspace bootstrap files are model context, not arbitrary attachments. Keep every
// read path on the same bound so compaction and sandbox copies cannot bypass it.
export const MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES = 2 * 1024 * 1024;

// ignoreBOM keeps a valid leading BOM in the decoded text, matching the previous
// Buffer.toString("utf-8") reads; only malformed bytes are rejected.
const workspaceBootstrapDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Distinguishes rejected encodings from byte-limit violations for degraded-read routing. */
export class WorkspaceBootstrapEncodingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceBootstrapEncodingError";
  }
}

export function decodeWorkspaceBootstrapBytes(bytes: Buffer): string {
  try {
    return workspaceBootstrapDecoder.decode(bytes);
  } catch (error) {
    throw new WorkspaceBootstrapEncodingError("Workspace bootstrap file is not valid UTF-8.", {
      cause: error,
    });
  }
}

export async function readWorkspaceBootstrapFile(fd: number): Promise<string> {
  return decodeWorkspaceBootstrapBytes(
    await readFileDescriptorBounded(fd, MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES),
  );
}

/** A guarded-read diagnostic is not the workspace instructions it replaced. */
export function isUnreadableWorkspaceBootstrapFile(file: WorkspaceBootstrapFile): boolean {
  return !file.missing && file.content?.startsWith("[UNREADABLE: ") === true;
}
