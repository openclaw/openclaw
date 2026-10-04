import { assertNoWindowsNetworkPath, safeFileURLToPath } from "@openclaw/fs-safe/advanced";
// Attachment normalization converts message context media fields into typed
// attachment records and classifies media kind from MIME or filename.
import type { MediaKind } from "@openclaw/media-core/constants";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { RuntimeMsgContext as MsgContext } from "../auto-reply/templating.js";
import { normalizeMediaFacts, resolveMediaFactKind } from "../media/media-facts.js";
import type { MediaAttachment } from "./types.js";

/** Normalizes a local attachment path while rejecting remote file URLs and Windows UNC paths. */
export function normalizeAttachmentPath(raw?: string | null): string | undefined {
  const value = normalizeOptionalString(raw);
  if (!value) {
    return undefined;
  }
  if (/^file:/iu.test(value)) {
    try {
      return safeFileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  try {
    assertNoWindowsNetworkPath(value, "Attachment path");
  } catch {
    return undefined;
  }
  return value;
}

/** Converts ordered media facts into indexed attachment records. */
export function normalizeAttachments(ctx: MsgContext): MediaAttachment[] {
  return normalizeMediaFacts(ctx.media)
    .map((fact, index) => {
      const kind = fact.fileName ? (resolveMediaFactKind(fact) ?? fact.kind) : fact.kind;
      return {
        path: fact.path,
        url: fact.url,
        mime: fact.contentType,
        index,
        alreadyTranscribed: fact.transcribed === true,
        ...(kind ? { kind } : {}),
        ...(fact.fileName ? { fileName: fact.fileName } : {}),
        ...(fact.workspaceDir ? { workspaceDir: fact.workspaceDir } : {}),
      };
    })
    .filter((entry) => Boolean(entry.path ?? entry.url));
}

/** Classifies an attachment by authoritative kind, MIME, then canonical filename metadata. */
export function resolveAttachmentKind(attachment: MediaAttachment): Exclude<MediaKind, "sticker"> {
  const kind = resolveMediaFactKind({
    path: attachment.path,
    url: attachment.url,
    contentType: attachment.mime,
    kind: attachment.kind,
  });
  return kind === "sticker" ? "image" : kind === "document" ? "unknown" : (kind ?? "unknown");
}

/** Returns true when the attachment is classified as audio media. */
export function isAudioAttachment(attachment: MediaAttachment): boolean {
  return resolveAttachmentKind(attachment) === "audio";
}

/** Returns true when the attachment is classified as image media. */
export function isImageAttachment(attachment: MediaAttachment): boolean {
  return resolveAttachmentKind(attachment) === "image";
}
