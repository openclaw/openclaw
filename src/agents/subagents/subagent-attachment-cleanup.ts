/** Removes host-owned subagent attachment artifacts by generated identity. */
import { FsSafeError, root } from "../../infra/fs-safe.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveSubagentSessionAttachmentRootDir } from "./subagent-attachment-paths.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function removeSubagentAttachmentTree(
  rootDir: string,
  attachmentId: string,
): Promise<void> {
  if (!UUID_RE.test(attachmentId)) {
    throw new Error("invalid subagent attachment identity");
  }
  try {
    await (await root(rootDir)).remove(attachmentId, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof FsSafeError && error.code === "not-found")) {
      throw error;
    }
  }
}

export async function cleanupMaterializedSubagentAttachments(params: {
  childSessionKey: string;
  attachmentId: string;
}): Promise<void> {
  const rootDir = resolveSubagentSessionAttachmentRootDir({
    agentId: resolveAgentIdFromSessionKey(params.childSessionKey),
    childSessionKey: params.childSessionKey,
  });
  await removeSubagentAttachmentTree(rootDir, params.attachmentId);
}
