import path from "node:path";
import { parseInboundMediaUri } from "../../media/media-reference.js";
import { MEDIA_MAX_BYTES, readMediaBuffer } from "../../media/store.js";

// A message realistically carries a handful of images; a corrupt transcript must
// not turn rewind into a bulk media read.
const EDITOR_MEDIA_REF_LIMIT = 10;

export async function resolveEditorMediaAttachments(
  refs: Array<{ path: string; contentType: string }> | undefined,
): Promise<Array<{ mimeType: string; data: string }>> {
  if (!refs) {
    return [];
  }
  const seen = new Set<string>();
  const attachments: Array<{ mimeType: string; data: string }> = [];
  for (const ref of refs) {
    // Transcript references are untrusted hints; only an inbound id is read through the
    // media store (its traversal guards and byte cap stay authoritative), so
    // dedupe on that resolved id — path aliases must not repeat the same read.
    let id: string;
    try {
      id = parseInboundMediaUri(ref.path)?.id ?? path.basename(ref.path);
    } catch {
      // A corrupt URI is only a failed attachment hint, never a failed history cut.
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (seen.size > EDITOR_MEDIA_REF_LIMIT) {
      break;
    }
    try {
      const media = await readMediaBuffer(id, "inbound", MEDIA_MAX_BYTES);
      attachments.push({ mimeType: ref.contentType, data: media.buffer.toString("base64") });
    } catch {
      // Skipped refs (missing file, oversized, guard rejection) never fail the cut.
    }
  }
  return attachments;
}
