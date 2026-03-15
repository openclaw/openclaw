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

  const updatedBody = normalizeUpdatedBody({
    originalBody: params.originalBody,
    updatedBody: params.updatedBody,
  });
  if (!updatedBody) {
    return [params.mediaNote?.trim(), stripped].filter(Boolean).join("\n").trim();
  }

  const replacementTargets = [
    params.originalBody?.trim(),
    stripInlineDirectives(params.originalBody),
    MEDIA_ONLY_PLACEHOLDER,
  ].filter(
    (value, index, list): value is string => Boolean(value) && list.indexOf(value) === index,
  );

  let rebuilt = stripped;
  for (const target of replacementTargets) {
    const replaced = replaceLastOccurrence(rebuilt, target, updatedBody);
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

function snapshotUpdatedMediaContext(params: {
  original: FollowupMediaContext;
  mediaCtx: MsgContext;
  updatedBody?: string;
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
  };
}

export async function applyDeferredMediaUnderstandingToQueuedRun(
  queued: FollowupRun,
  params: { logLabel?: string } = {},
): Promise<void> {
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
  const bodyAlreadyHasFileBlock =
    FILE_BLOCK_RE.test(resolvedOriginalBody ?? "") || FILE_BLOCK_RE.test(mediaContext.Body ?? "");

  if (bodyAlreadyHasFileBlock && hasOnlyFileLikeAttachments(mediaContext)) {
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
      (muResult.appliedFile && !bodyAlreadyHasFileBlock);

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
    });
  } catch (err) {
    logVerbose(
      `${params.logLabel ?? "followup"}: media understanding failed, proceeding with raw content: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
