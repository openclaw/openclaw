import { buildOutboundMediaLoadOptions, type OutboundMediaAccess } from "./load-options.js";
import { saveMediaBuffer } from "./store.js";
import { loadWebMedia } from "./web-media.js";

export async function resolveOutboundAttachmentFromUrl(
  mediaUrl: string,
  maxBytes: number,
  options?: {
    mediaAccess?: OutboundMediaAccess;
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
    hostReadAllowedMimes?: readonly string[];
    hostReadMimePolicy?: "extend" | "override";
  },
): Promise<{ path: string; contentType?: string }> {
  const media = await loadWebMedia(mediaUrl, {
    ...buildOutboundMediaLoadOptions({
      maxBytes,
      mediaAccess: options?.mediaAccess,
      mediaLocalRoots: options?.localRoots,
      mediaReadFile: options?.readFile,
      hostReadAllowedMimes: options?.hostReadAllowedMimes,
      hostReadMimePolicy: options?.hostReadMimePolicy,
    }),
    // Auto-reply paths are the injection-protection target: model output may
    // contain attacker-controlled paths. The MIME allowlist limits blast radius
    // if a malicious path slips past the path-level guard. Explicit send-tool
    // calls do NOT set this flag — the path-level guard (localRoots) is the
    // appropriate boundary there.
    hostReadCapability: true,
  });
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType ?? undefined,
    "outbound",
    maxBytes,
    media.fileName,
  );
  return { path: saved.path, contentType: saved.contentType };
}
