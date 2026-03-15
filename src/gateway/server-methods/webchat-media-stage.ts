import fs from "node:fs/promises";
import path from "node:path";
import { buildMediaPayload, type MediaPayload } from "../../channels/plugins/media-payload.js";
import { extensionForMime } from "../../media/mime.js";
import { ensureMediaDir } from "../../media/store.js";
import type { ChatImageContent } from "../chat-attachments.js";

const MEDIA_FILE_MODE = 0o644;

/**
 * Sanitize runId to prevent path traversal attacks.
 * Only allows alphanumeric characters, hyphens, and underscores.
 */
function sanitizeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

type StageWebchatMediaLog = {
  warn: (message: string) => void;
};

export async function stageWebchatImageAttachments(params: {
  images: ChatImageContent[];
  runId: string;
  log?: StageWebchatMediaLog;
}): Promise<MediaPayload | undefined> {
  if (params.images.length === 0) {
    return undefined;
  }

  const mediaDir = await ensureMediaDir();
  const inboundDir = path.join(mediaDir, "inbound");
  await fs.mkdir(inboundDir, { recursive: true, mode: 0o700 });

  const staged: Array<{ contentType?: string; path: string }> = [];
  const safeRunId = sanitizeRunId(params.runId);
  for (const [index, image] of params.images.entries()) {
    try {
      const ext = extensionForMime(image.mimeType) ?? ".bin";
      const filePath = path.join(inboundDir, `webchat-${safeRunId}-${index + 1}${ext}`);
      const bytes = Buffer.from(image.data, "base64");
      await fs.writeFile(filePath, bytes, { mode: MEDIA_FILE_MODE });
      staged.push({ path: filePath, contentType: image.mimeType });
    } catch (err) {
      params.log?.warn(`failed to stage webchat image ${index + 1}: ${String(err)}`);
    }
  }

  if (staged.length === 0) {
    return undefined;
  }

  return buildMediaPayload(staged, {
    preserveMediaTypeCardinality: true,
  });
}
