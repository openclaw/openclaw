import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import type { WorkspaceBootstrapFile } from "./workspace-bootstrap-policy.js";

// Workspace bootstrap files are model context, not arbitrary attachments. Keep every
// read path on the same bound so compaction and sandbox copies cannot bypass it.
export const MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Prefix of the row `loadWorkspaceBootstrapFiles` injects when a guarded read fails. The producer
 * keeps its own copy because workspace.ts is over its line cap; the diagnostics tests pin both sides.
 */
const WORKSPACE_BOOTSTRAP_UNREADABLE_PREFIX = "[UNREADABLE: ";

export async function readWorkspaceBootstrapFile(fd: number): Promise<string> {
  return (await readFileDescriptorBounded(fd, MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES)).toString(
    "utf-8",
  );
}

/**
 * Whether this bootstrap file reached the prompt as a read-failure diagnostic instead of its
 * contents. The file stays present so the model sees why, but nothing it documents was delivered.
 */
export function isUnreadableWorkspaceBootstrapFile(file: WorkspaceBootstrapFile): boolean {
  return (
    !file.missing &&
    typeof file.content === "string" &&
    file.content.startsWith(WORKSPACE_BOOTSTRAP_UNREADABLE_PREFIX)
  );
}
