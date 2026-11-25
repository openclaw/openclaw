/** Removes host-owned subagent attachment artifacts by generated identity. */
import { FsSafeError, root } from "../../infra/fs-safe.js";
import { resolveSubagentChildAgentId } from "./registry/subagent-child-owner-match.js";
import { resolveSubagentSessionAttachmentRootDir } from "./subagent-attachment-paths.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function removeSubagentAttachmentTree(
  rootDir: string,
  attachmentId: string,
  assertBeforeMutation?: () => void,
): Promise<void> {
  if (!UUID_RE.test(attachmentId)) {
    throw new Error("invalid subagent attachment identity");
  }
  assertBeforeMutation?.();
  try {
    await (
      await root(rootDir)
    ).remove(attachmentId, {
      recursive: true,
      force: true,
      ...(assertBeforeMutation ? { assertBeforeMutation } : {}),
    });
  } catch (error) {
    if (!(error instanceof FsSafeError && error.code === "not-found")) {
      throw error;
    }
  }
}

export async function cleanupMaterializedSubagentAttachments(params: {
  childSessionKey: string;
  childAgentId?: string;
  attachmentId: string;
  isCurrent?: () => boolean;
}): Promise<void> {
  const agentId = resolveSubagentChildAgentId(params);
  if (!agentId) {
    throw new Error("Subagent attachment owner is unresolved; attachments remain retained.");
  }
  const rootDir = resolveSubagentSessionAttachmentRootDir({
    agentId,
    childSessionKey: params.childSessionKey,
  });
  const isCurrent = params.isCurrent;
  await removeSubagentAttachmentTree(
    rootDir,
    params.attachmentId,
    isCurrent
      ? () => {
          if (!isCurrent()) {
            throw new Error("subagent attachment cleanup owner is no longer current");
          }
        }
      : undefined,
  );
}
