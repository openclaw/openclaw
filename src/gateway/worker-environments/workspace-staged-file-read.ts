import { readWorkspaceFileBytesWithLimit } from "./workspace-actual-manifest.js";
import { MAX_RECONCILIATION_FILE_BYTES } from "./workspace-manifest.js";

export async function readCappedStagedFile(source: string): Promise<Buffer> {
  const snapshot = await readWorkspaceFileBytesWithLimit(source, MAX_RECONCILIATION_FILE_BYTES);
  if (snapshot.type !== "file") {
    throw new Error("Cloud workspace staged result exceeds its byte limit");
  }
  return snapshot.content;
}
