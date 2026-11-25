import crypto from "node:crypto";
import path from "node:path";
import { basenameFromAnyPath } from "@openclaw/media-core/file-name";
import { sniffImageMimeType } from "../../image-generation/image-assets.js";
import { readLocalMediaFile } from "../../media/local-media-access.js";
import { getDefaultMediaLocalRoots } from "../../media/local-roots.js";
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
  options?: { workspaceDir?: string },
): ResolveSubagentAttachmentReference | undefined {
  if (!stagedMediaPaths?.size && generatedAttachmentRegistry.size === 0) {
    return undefined;
  }
  return async ({
    reference,
    requesterSessionKey,
  }: {
    reference: SubagentAttachmentReference;
    requesterSessionKey?: string;
  }) => {
    const generated = generatedAttachmentRegistry.get(reference.id);
    if (
      generated &&
      generated.expiresAt > Date.now() &&
      (!generated.requesterSessionKey || generated.requesterSessionKey === requesterSessionKey)
    ) {
      const data = await readLocalMediaFile(generated.path, getDefaultMediaLocalRoots(), {
        maxBytes: reference.sizeBytes,
      });
      const detectedMimeType = sniffImageMimeType(data, "").mimeType;
      if (!detectedMimeType.startsWith("image/")) return null;
      return {
        ...reference,
        name: generated.name,
        mimeType: detectedMimeType,
        data,
      };
    }
    const mediaPath = stagedMediaPaths?.get(reference.id);
    if (!mediaPath) {
      return null;
    }
    const resolvedPath = options?.workspaceDir && !path.isAbsolute(mediaPath)
      ? path.resolve(options.workspaceDir, mediaPath)
      : mediaPath;
    const roots = options?.workspaceDir
      ? [...getDefaultMediaLocalRoots(), options.workspaceDir]
      : getDefaultMediaLocalRoots();
    const data = await readLocalMediaFile(resolvedPath, roots, {
      maxBytes: reference.sizeBytes,
    });
    const detectedMimeType = sniffImageMimeType(data, "").mimeType;
    if (!detectedMimeType.startsWith("image/")) return null;
    return {
      ...reference,
      name: basenameFromAnyPath(resolvedPath),
      mimeType: detectedMimeType,
      data,
    };
  };
}

type GeneratedAttachmentEntry = {
  path: string;
  name: string;
  mimeType: string;
  requesterSessionKey?: string;
  expiresAt: number;
};

const generatedAttachmentRegistry = new Map<string, GeneratedAttachmentEntry>();

export function registerGeneratedAttachment(params: {
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  requesterSessionKey?: string;
}): SubagentAttachmentReference {
  for (const [id, entry] of generatedAttachmentRegistry) {
    if (entry.expiresAt <= Date.now()) generatedAttachmentRegistry.delete(id);
  }
  const data = crypto.randomUUID();
  const reference = {
    id: `generated-${data}`,
    name: params.name,
    mimeType: params.mimeType,
    sizeBytes: params.sizeBytes,
    sha256: params.sha256,
  };
  generatedAttachmentRegistry.set(reference.id, { ...params, expiresAt: Date.now() + 15 * 60_000 });
  return reference;
}
