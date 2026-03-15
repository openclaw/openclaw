import { logVerbose } from "../../globals.js";
import { applyMediaUnderstanding } from "../../media-understanding/apply.js";
import {
  normalizeAttachments,
  resolveAttachmentKind,
} from "../../media-understanding/attachments.js";
import { buildInboundMediaNote } from "../media-note.js";
import type { MsgContext } from "../templating.js";
import { parseInlineDirectives } from "./directive-handling.js";
import type { FollowupMediaContext, FollowupRun } from "./queue/types.js";

const MEDIA_ONLY_PLACEHOLDER = "[User sent media without caption]";
const MEDIA_REPLY_HINT_PREFIX = "To send an image back, prefer the message tool";
const LEADING_MEDIA_ATTACHED_LINE_RE = /^\[media attached(?: \d+\/\d+)?: [^\r\n]*\]$/;
const FILE_BLOCK_RE = /<file\s+name="/i;
const FILE_BLOCK_FULL_RE = /<file\s+name="[^"]*"[^>]*>[\s\S]*?<\/file>\n?/gi;

function stripExistingFileBlocks(text: string): string {
  return text.replace(FILE_BLOCK_FULL_RE, "").trim();
}

function stripLeadingMediaAttachedLines(prompt: string): string {
  const lines = prompt.split("\n");
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? "";
    if (!LEADING_MEDIA_ATTACHED_LINE_RE.test(trimmed)) {
      break;
    }
    index += 1;
  }
  return lines.slice(index).join("\n").trim();
}

function stripLeadingMediaReplyHint(prompt: string): string {
  const lines = prompt.split("\n");
  if ((lines[0] ?? "").startsWith(MEDIA_REPLY_HINT_PREFIX)) {
    return lines.slice(1).join("\n").trim();
  }
  return prompt.trim();
}

function replaceLastOccurrence(
  value: string,
  search: string,
  replacement: string,
): string | undefined {
  if (!search) {
    return undefined;
  }
  const index = value.lastIndexOf(search);
  if (index < 0) {
    return undefined;
  }
  return `${value.slice(0, index)}${replacement}${value.slice(index + search.length)}`;
}

function findFirstOccurrenceBeforeFileBlocks(value: string, search: string): number {
  if (!search) {
    return -1;
  }
  const fileBlockIndex = value.search(FILE_BLOCK_RE);
  const bodyRegion = fileBlockIndex >= 0 ? value.slice(0, fileBlockIndex) : value;
  return bodyRegion.indexOf(search);
}

function replaceFirstOccurrenceBeforeFileBlocks(
  value: string,
  search: string,
  replacement: string,
): string | undefined {
  if (!search) {
    return undefined;
  }
  const index = findFirstOccurrenceBeforeFileBlocks(value, search);
  if (index < 0) {
    return undefined;
  }
  return `${value.slice(0, index)}${replacement}${value.slice(index + search.length)}`;
}

function stripInlineDirectives(text: string | undefined): string {
  return parseInlineDirectives(text ?? "").cleaned.trim();
}

function normalizeUpdatedBody(params: { originalBody?: string; updatedBody?: string }): string {
  const updatedBody = params.updatedBody?.trim();
  if (!updatedBody) {
    return "";
  }
  const originalBody = params.originalBody?.trim();
  if (!originalBody) {
    return updatedBody;
  }

  const cleanedOriginalBody = stripInlineDirectives(originalBody);
  if (!cleanedOriginalBody) {
    return updatedBody;
  }
  if (updatedBody === originalBody) {
    return cleanedOriginalBody;
  }
  return (
    replaceLastOccurrence(updatedBody, originalBody, cleanedOriginalBody) ?? updatedBody
  ).trim();
}

function rebuildQueuedPromptWithMediaUnderstanding(params: {
  prompt: string;
  originalBody?: string;
  updatedBody?: string;
  mediaNote?: string;
}): string {
  let stripped = stripLeadingMediaAttachedLines(params.prompt);
  if (!params.mediaNote) {
    stripped = stripLeadingMediaReplyHint(stripped);
  }

  const replacementTargets = [
    params.originalBody?.trim(),
    stripInlineDirectives(params.originalBody),
    MEDIA_ONLY_PLACEHOLDER,
  ].filter(
    (value, index, list): value is string => Boolean(value) && list.indexOf(value) === index,
  );

  // Strip pre-existing file blocks from the body region when the updated body
  // contains new file blocks.  Mixed messages (audio + PDF) can arrive with
  // file extraction already applied in the primary path; without this strip
  // the old block stays in the prompt while the updated body adds a new one,
  // duplicating potentially large file payloads.
  // Scope stripping to the confirmed body segment so quoted/replied text,
  // thread history above the body, and prompts whose original body no longer
  // appears all retain any legitimate <file> blocks.
  if (params.updatedBody && FILE_BLOCK_RE.test(params.updatedBody)) {
    const bodyIdx =
      replacementTargets
        .map((target) => findFirstOccurrenceBeforeFileBlocks(stripped, target))
        .find((index) => index >= 0) ?? -1;
    if (bodyIdx >= 0) {
      stripped = stripped.slice(0, bodyIdx) + stripExistingFileBlocks(stripped.slice(bodyIdx));
    }
  }

  const updatedBody = normalizeUpdatedBody({
    originalBody: params.originalBody,
    updatedBody: params.updatedBody,
  });
  if (!updatedBody) {
    return [params.mediaNote?.trim(), stripped].filter(Boolean).join("\n").trim();
  }

  let rebuilt = stripped;
  for (const target of replacementTargets) {
    const replaced = replaceFirstOccurrenceBeforeFileBlocks(rebuilt, target, updatedBody);
    if (replaced !== undefined) {
      rebuilt = replaced;
      return [params.mediaNote?.trim(), rebuilt.trim()].filter(Boolean).join("\n").trim();
    }
  }

  rebuilt = [rebuilt, updatedBody].filter(Boolean).join("\n\n");
  return [params.mediaNote?.trim(), rebuilt.trim()].filter(Boolean).join("\n").trim();
}

function hasMediaAttachments(mediaContext: FollowupMediaContext): boolean {
  return Boolean(
    mediaContext.MediaPath?.trim() ||
    mediaContext.MediaUrl?.trim() ||
    (Array.isArray(mediaContext.MediaPaths) && mediaContext.MediaPaths.length > 0) ||
    (Array.isArray(mediaContext.MediaUrls) && mediaContext.MediaUrls.length > 0),
  );
}

function hasOnlyFileLikeAttachments(mediaContext: FollowupMediaContext): boolean {
  const attachments = normalizeAttachments(mediaContext as MsgContext);
  return (
    attachments.length > 0 &&
    attachments.every((attachment) => {
      const kind = resolveAttachmentKind(attachment);
      return kind !== "audio" && kind !== "image" && kind !== "video";
    })
  );
}

function hasAnyFileAttachments(mediaContext: FollowupMediaContext): boolean {
  return normalizeAttachments(mediaContext as MsgContext).some((attachment) => {
    const kind = resolveAttachmentKind(attachment);
    return kind !== "audio" && kind !== "image" && kind !== "video";
  });
}

function snapshotUpdatedMediaContext(params: {
  original: FollowupMediaContext;
  mediaCtx: MsgContext;
  updatedBody?: string;
  appliedFile?: boolean;
}): FollowupMediaContext {
  return {
    ...params.original,
    Body: params.updatedBody ?? params.original.Body,
    Transcript:
      typeof params.mediaCtx.Transcript === "string"
        ? params.mediaCtx.Transcript
        : params.original.Transcript,
    MediaUnderstanding: Array.isArray(params.mediaCtx.MediaUnderstanding)
      ? [...params.mediaCtx.MediaUnderstanding]
      : params.original.MediaUnderstanding,
    MediaUnderstandingDecisions: Array.isArray(params.mediaCtx.MediaUnderstandingDecisions)
      ? [...params.mediaCtx.MediaUnderstandingDecisions]
      : params.original.MediaUnderstandingDecisions,
    DeferredMediaApplied: true,
    DeferredFileBlocksExtracted:
      params.original.DeferredFileBlocksExtracted || params.appliedFile || undefined,
  };
}

export async function applyDeferredMediaUnderstandingToQueuedRun(
  queued: FollowupRun,
  params: { logLabel?: string } = {},
): Promise<void> {
  // NOTE: collect-mode and overflow-summary queue drains create synthetic
  // followup runs without mediaContext — those paths are not covered here
  // and rely on their own prompt-building logic in queue/drain.ts.
  const mediaContext = queued.mediaContext;
  if (!mediaContext || mediaContext.DeferredMediaApplied) {
    return;
  }
  if (mediaContext.MediaUnderstanding?.length) {
    mediaContext.DeferredMediaApplied = true;
    return;
  }
  if (!hasMediaAttachments(mediaContext)) {
    mediaContext.DeferredMediaApplied = true;
    return;
  }

  const resolvedOriginalBody =
    mediaContext.CommandBody ?? mediaContext.RawBody ?? mediaContext.Body;
  // Detect file extraction from the primary path via body mutation instead of
  // scanning for literal '<file name=' patterns (which false-positives on user
  // text).  Compare Body against RawBody (never mutated by the primary path's
  // media/file processing) rather than CommandBody (which differs from Body
  // when inline directives like /think were stripped).
  const referenceBody = mediaContext.RawBody ?? mediaContext.Body;
  if (
    !mediaContext.DeferredFileBlocksExtracted &&
    mediaContext.Body !== referenceBody &&
    hasAnyFileAttachments(mediaContext)
  ) {
    mediaContext.DeferredFileBlocksExtracted = true;
  }

  if (mediaContext.DeferredFileBlocksExtracted && hasOnlyFileLikeAttachments(mediaContext)) {
    mediaContext.DeferredMediaApplied = true;
    return;
  }

  try {
    const mediaCtx = {
      ...mediaContext,
      Body: resolvedOriginalBody,
      Provider:
        mediaContext.Provider ??
        queued.run.messageProvider ??
        (typeof mediaContext.OriginatingChannel === "string"
          ? mediaContext.OriginatingChannel
          : undefined),
      Surface: mediaContext.Surface,
    } as MsgContext;

    const muResult = await applyMediaUnderstanding({
      ctx: mediaCtx,
      cfg: queued.run.config,
      agentDir: queued.run.agentDir,
      activeModel: {
        provider: queued.run.provider,
        model: queued.run.model,
      },
    });

    const shouldRebuildPrompt =
      muResult.outputs.length > 0 ||
      muResult.appliedAudio ||
      muResult.appliedImage ||
      muResult.appliedVideo ||
      (muResult.appliedFile && !mediaContext.DeferredFileBlocksExtracted);

    if (shouldRebuildPrompt) {
      const newMediaNote = buildInboundMediaNote(mediaCtx);
      queued.prompt = rebuildQueuedPromptWithMediaUnderstanding({
        prompt: queued.prompt,
        originalBody: resolvedOriginalBody,
        updatedBody: mediaCtx.Body,
        mediaNote: newMediaNote,
      });
      logVerbose(
        `${params.logLabel ?? "followup"}: applied media understanding (audio=${muResult.appliedAudio}, image=${muResult.appliedImage}, video=${muResult.appliedVideo}, file=${muResult.appliedFile})`,
      );
    }

    queued.mediaContext = snapshotUpdatedMediaContext({
      original: mediaContext,
      mediaCtx,
      updatedBody: shouldRebuildPrompt ? mediaCtx.Body : undefined,
      appliedFile: muResult.appliedFile,
    });
  } catch (err) {
    mediaContext.DeferredMediaApplied = true;
    logVerbose(
      `${params.logLabel ?? "followup"}: media understanding failed, proceeding with raw content: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
