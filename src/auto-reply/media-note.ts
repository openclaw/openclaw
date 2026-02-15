import type { MsgContext } from "./templating.js";

function formatMediaLine(params: {
  path: string;
  url?: string;
  type?: string;
  index?: number;
  total?: number;
  suppressed?: boolean;
}): string {
  if (params.suppressed) {
    return `[media source: ${params.path}]`;
  }
  const prefix =
    typeof params.index === "number" && typeof params.total === "number"
      ? `[media attached ${params.index}/${params.total}: `
      : "[media attached: ";
  const typePart = params.type?.trim() ? ` (${params.type.trim()})` : "";
  const urlRaw = params.url?.trim();
  const urlPart = urlRaw ? ` | ${urlRaw}` : "";
  return `${prefix}${params.path}${typePart}${urlPart}]`;
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

function isAudioPath(path: string | undefined): boolean {
  if (!path) {
    return false;
  }
  const lower = path.toLowerCase();
  for (const ext of AUDIO_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

export function buildInboundMediaNote(ctx: MsgContext): string | undefined {
  // Attachment indices follow MediaPaths/MediaUrls ordering as supplied by the channel.
  const suppressed = new Set<number>();
  const transcribedAudioIndices = new Set<number>();
  if (Array.isArray(ctx.MediaUnderstanding)) {
    for (const output of ctx.MediaUnderstanding) {
      suppressed.add(output.attachmentIndex);
      if (output.kind === "audio.transcription") {
        transcribedAudioIndices.add(output.attachmentIndex);
      }
    }
  }
  if (Array.isArray(ctx.MediaUnderstandingDecisions)) {
    for (const decision of ctx.MediaUnderstandingDecisions) {
      if (decision.outcome !== "success") {
        continue;
      }
      for (const attachment of decision.attachments) {
        if (attachment.chosen?.outcome === "success") {
          suppressed.add(attachment.attachmentIndex);
          if (decision.capability === "audio") {
            transcribedAudioIndices.add(attachment.attachmentIndex);
          }
        }
      }
    }
  }
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

  const allEntries = paths.map((entry, index) => ({
    path: entry ?? "",
    type: types?.[index] ?? ctx.MediaType,
    url: urls?.[index] ?? ctx.MediaUrl,
    index,
    suppressed: suppressed.has(index),
  }));
  if (allEntries.length === 0) {
    return undefined;
  }

  const unsuppressed = allEntries.filter((e) => {
    if (e.suppressed) {
      return false;
    }
    // Strip audio attachments when transcription succeeded - the transcript is already
    // available in the context, raw audio binary would only waste tokens (issue #4197)
    // Note: Only trust MIME type from per-entry types array, not fallback ctx.MediaType
    // which could misclassify non-audio attachments (greptile review feedback)
    const hasPerEntryType = types !== undefined;
    const isAudioByMime = hasPerEntryType && e.type?.toLowerCase().startsWith("audio/");
    const isAudioEntry = isAudioPath(e.path) || isAudioByMime;
    if (isAudioEntry) {
      if (
        transcribedAudioIndices.has(e.index) ||
        (canStripSingleAttachmentByTranscript && e.index === 0)
      ) {
        return false;
      }
    }
    return true;
  });
  // Emit [media source: ...] for suppressed entries (preserves file paths for image tool),
  // but not for transcribed audio (transcript already covers it).
  const suppressedEntries = allEntries.filter(
    (e) => e.suppressed && !transcribedAudioIndices.has(e.index),
  );

  if (unsuppressed.length === 0 && suppressedEntries.length === 0) {
    return undefined;
  }

  const lines: string[] = [];

  if (unsuppressed.length === 1 && suppressedEntries.length === 0) {
    return formatMediaLine({
      path: unsuppressed[0]?.path ?? "",
      type: unsuppressed[0]?.type,
      url: unsuppressed[0]?.url,
    });
  }

  if (unsuppressed.length > 0) {
    if (unsuppressed.length > 1) {
      lines.push(`[media attached: ${unsuppressed.length} files]`);
    }
    for (const [idx, entry] of unsuppressed.entries()) {
      lines.push(
        formatMediaLine({
          path: entry.path,
          index: unsuppressed.length > 1 ? idx + 1 : undefined,
          total: unsuppressed.length > 1 ? unsuppressed.length : undefined,
          type: entry.type,
          url: entry.url,
        }),
      );
    }
  }

  for (const entry of suppressedEntries) {
    lines.push(formatMediaLine({ path: entry.path, suppressed: true }));
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}
