/** Builds compact prompt notes for inbound media attachments. */
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getMediaDir } from "../media/store.js";
import type { MsgContext } from "./templating.js";

function stripDarwinPrivatePrefix(value: string): string {
  return value.startsWith("/private/var/") ? value.slice("/private".length) : value;
}

/**
 * MIME types (or prefixes) whose inbound attachments the runtime either inlines
 * (image -> vision, audio -> transcript) or resolves through a dedicated
 * claim-check tool that understands `media://inbound/<id>` (e.g. the PDF tool,
 * native image injection). For these, the stable `media://inbound/` URI is the
 * correct prompt-visible reference and the raw host path is intentionally hidden.
 */
function inboundTypeHasManagedConsumer(type: string | undefined): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(type);
  if (!normalized) {
    // Unknown type: fall back to the safe legacy URI form rather than leaking a path.
    return true;
  }
  return (
    normalized.startsWith("image/") ||
    normalized.startsWith("audio/") ||
    normalized.startsWith("video/") ||
    normalized === "application/pdf"
  );
}

/**
 * Resolves an inbound attachment reference for prompt rendering.
 *
 * Inlined / tool-backed media (image, audio, video, PDF) keeps the stable
 * `media://inbound/<basename>` URI so prompts do not leak host-specific temp
 * paths and the downstream claim-check resolvers keep working.
 *
 * Binary documents (application/pdf aside) have no binary-aware inliner or tool
 * consumer -- e.g. application/zip, application/octet-stream, arbitrary file
 * types. The generic `media://` resolver decodes bytes as text/image, so it
 * cannot make these usable. They previously received only the opaque
 * `media://inbound/<id>` URI plus a bare `<media:document>` placeholder, leaving
 * a shell-capable agent unable to pass the file to OS tools. Restoring prior
 * behavior, those types render the guarded absolute path (already proven to live
 * inside the inbound dir) so the agent can read the file directly. Restores
 * direct access for zips and other non-PDF documents.
 */
function normalizeManagedInboundMediaRef(value: string, type?: string): string {
  if (!path.isAbsolute(value)) {
    return value;
  }
  const mediaDir = stripDarwinPrivatePrefix(path.resolve(getMediaDir()));
  const candidate = stripDarwinPrivatePrefix(path.resolve(value));
  const inboundDir = path.join(mediaDir, "inbound");
  const relativeToInbound = path.relative(inboundDir, candidate);
  // Only managed inbound media (path resolves inside the inbound dir) is eligible
  // for rewriting; anything else is returned untouched.
  if (
    !relativeToInbound ||
    relativeToInbound.startsWith("..") ||
    path.isAbsolute(relativeToInbound)
  ) {
    return value;
  }
  // Binary documents have no binary-aware inliner/tool consumer: hand the agent
  // the real, readable absolute path (guarded to be inside the inbound dir above).
  if (!inboundTypeHasManagedConsumer(type)) {
    return candidate;
  }
  // Inlined / tool-backed media gets a stable URI so prompts do not leak
  // host-specific temp paths and claim-check resolvers keep matching.
  return `media://inbound/${path.basename(candidate)}`;
}

function sanitizeInlineMediaNoteValue(value: string | undefined, type?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }
  return normalizeManagedInboundMediaRef(trimmed, type)
    .replace(/[\p{Cc}\]]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatMediaAttachedLine(params: {
  path: string;
  url?: string;
  type?: string;
  index?: number;
  total?: number;
}): string {
  const prefix =
    typeof params.index === "number" && typeof params.total === "number"
      ? `[media attached ${params.index}/${params.total}: `
      : "[media attached: ";
  const pathValue = sanitizeInlineMediaNoteValue(params.path, params.type);
  const typeRaw = sanitizeInlineMediaNoteValue(params.type);
  const typePart = typeRaw ? ` (${typeRaw})` : "";
  // Normalize the URL with the same type so a mirrored inbound path (Telegram
  // album media) still collapses against the rendered path form (#47587).
  const urlRaw = sanitizeInlineMediaNoteValue(params.url, params.type);
  // When the channel mirrors the local path into MediaUrl (Telegram album
  // media is the canonical case), rendering ` | ${url}` adds no information
  // and clutters the prompt with `path | path` duplication (issue #47587).
  const urlPart = urlRaw && urlRaw !== pathValue ? ` | ${urlRaw}` : "";
  return `${prefix}${pathValue}${typePart}${urlPart}]`;
}

// Common audio file extensions for transcription detection
const AUDIO_EXTENSIONS = new Set([
  ".ogg",
  ".opus",
  ".mp3",
  ".m4a",
  ".wav",
  ".webm",
  ".flac",
  ".aac",
  ".wma",
  ".aiff",
  ".alac",
  ".oga",
]);

function isAudioPath(pathLocal: string | undefined): boolean {
  if (!pathLocal) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(pathLocal);
  for (const ext of AUDIO_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

function isValidAttachmentIndex(index: number, attachmentCount: number): boolean {
  return Number.isSafeInteger(index) && index >= 0 && index < attachmentCount;
}

function collectTranscribedAudioAttachmentIndices(
  ctx: MsgContext,
  attachmentCount: number,
): Set<number> {
  // Only audio transcription should suppress the raw attachment in prompt notes.
  // Image/video descriptions are lossy derived context, so the original attachment
  // must stay available to multimodal models and downstream tools.
  const transcribedAudioIndices = new Set<number>();
  if (Array.isArray(ctx.MediaUnderstanding)) {
    for (const output of ctx.MediaUnderstanding) {
      if (
        output.kind === "audio.transcription" &&
        isValidAttachmentIndex(output.attachmentIndex, attachmentCount)
      ) {
        transcribedAudioIndices.add(output.attachmentIndex);
      }
    }
  }
  if (Array.isArray(ctx.MediaUnderstandingDecisions)) {
    for (const decision of ctx.MediaUnderstandingDecisions) {
      if (decision.capability !== "audio" || decision.outcome !== "success") {
        continue;
      }
      for (const attachment of decision.attachments) {
        if (
          attachment.chosen?.outcome === "success" &&
          isValidAttachmentIndex(attachment.attachmentIndex, attachmentCount)
        ) {
          transcribedAudioIndices.add(attachment.attachmentIndex);
        }
      }
    }
  }
  return transcribedAudioIndices;
}

/** Formats a prompt-visible media attachment note, omitting audio already represented by transcript. */
export function buildInboundMediaNote(ctx: MsgContext): string | undefined {
  // Attachment indices follow MediaPaths/MediaUrls ordering as supplied by the channel.
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const paths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : ctx.MediaPath?.trim()
        ? [ctx.MediaPath.trim()]
        : [];
  if (paths.length === 0) {
    return undefined;
  }

  const transcribedAudioIndices = collectTranscribedAudioAttachmentIndices(ctx, paths.length);

  const urls =
    Array.isArray(ctx.MediaUrls) && ctx.MediaUrls.length === paths.length
      ? ctx.MediaUrls
      : undefined;
  const types =
    Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length === paths.length
      ? ctx.MediaTypes
      : undefined;
  const hasTranscript = Boolean(ctx.Transcript?.trim());
  // Transcript alone does not identify an attachment index; only use it as a fallback
  // when there is a single attachment to avoid stripping unrelated audio files.
  const canStripSingleAttachmentByTranscript = hasTranscript && paths.length === 1;

  const entries = paths
    .map((entry, index) => ({
      path: entry ?? "",
      type: types?.[index] ?? ctx.MediaType,
      url: urls?.[index] ?? ctx.MediaUrl,
      index,
    }))
    .filter((entry) => {
      // Strip audio attachments when transcription succeeded - the transcript is already
      // available in the context, raw audio binary would only waste tokens (issue #4197)
      // Note: Only trust MIME type from per-entry types array, not fallback ctx.MediaType
      // which could misclassify non-audio attachments (greptile review feedback)
      const hasPerEntryType = types !== undefined;
      const isAudioByMime =
        hasPerEntryType && normalizeLowercaseStringOrEmpty(entry.type).startsWith("audio/");
      const isAudioEntry = isAudioPath(entry.path) || isAudioByMime;
      if (!isAudioEntry) {
        return true;
      }
      if (
        transcribedAudioIndices.has(entry.index) ||
        (canStripSingleAttachmentByTranscript && entry.index === 0)
      ) {
        return false;
      }
      return true;
    });
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    return formatMediaAttachedLine({
      path: entries[0]?.path ?? "",
      type: entries[0]?.type,
      url: entries[0]?.url,
    });
  }

  const count = entries.length;
  const lines: string[] = [`[media attached: ${count} files]`];
  for (const [idx, entry] of entries.entries()) {
    lines.push(
      formatMediaAttachedLine({
        path: entry.path,
        index: idx + 1,
        total: count,
        type: entry.type,
        url: entry.url,
      }),
    );
  }
  return lines.join("\n");
}
