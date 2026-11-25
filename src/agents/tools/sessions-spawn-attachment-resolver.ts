import { readLocalMediaFile } from "../../media/local-media-access.js";
import type {
  ResolveSubagentAttachmentReference,
  SubagentAttachmentReference,
} from "../subagents/spawn/subagent-spawn-contract.js";

/**
 * Resolves handles issued by the admitted turn's staged-media preparation.
 * The map is host-owned and is intentionally the only authority consulted;
 * callers cannot turn an arbitrary path into a sessions_spawn attachment.
 */
export function createStagedMediaAttachmentResolver(
  stagedMediaPaths: ReadonlyMap<string, string> | undefined,
): ResolveSubagentAttachmentReference | undefined {
  if (!stagedMediaPaths?.size) {
    return undefined;
  }
  return async ({ reference }: { reference: SubagentAttachmentReference }) => {
    const mediaPath = stagedMediaPaths.get(reference.id);
    if (!mediaPath) {
      return null;
    }
    const data = await readLocalMediaFile(mediaPath, "any", {
      maxBytes: reference.sizeBytes,
    });
    return { ...reference, data };
  };
}
