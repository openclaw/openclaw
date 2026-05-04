import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { buildInboundMediaNote } from "../media-note.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { appendUntrustedContext } from "./untrusted-context.js";

const REPLY_MEDIA_HINT =
  "To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg (spaces ok, quote if needed) or a safe relative path like MEDIA:./image.jpg. Absolute and ~ paths only work when they stay inside your allowed file-read boundary; host file:// URLs are blocked. Keep caption in the text body.";

function joinNonEmpty(separator: string, ...values: Array<string | undefined>): string {
  let out = "";
  for (const value of values) {
    if (!value) {
      continue;
    }
    out = out ? `${out}${separator}${value}` : value;
  }
  return out;
}

export function buildReplyPromptBodies(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  effectiveBaseBody: string;
  prefixedBody: string;
  transcriptBody?: string;
  threadContextNote?: string;
  systemEventBlocks?: string[];
}): {
  mediaNote?: string;
  mediaReplyHint?: string;
  prefixedCommandBody: string;
  queuedBody: string;
  transcriptCommandBody: string;
} {
  let combinedEventsBlock = "";
  for (const block of params.systemEventBlocks ?? []) {
    if (block) {
      combinedEventsBlock = combinedEventsBlock ? `${combinedEventsBlock}\n${block}` : block;
    }
  }
  const prependEvents = (body: string) =>
    combinedEventsBlock ? `${combinedEventsBlock}\n\n${body}` : body;
  const bodyWithEvents = prependEvents(params.effectiveBaseBody);
  const prefixedBodyWithEvents = appendUntrustedContext(
    prependEvents(params.prefixedBody),
    params.sessionCtx.UntrustedContext,
  );
  const prefixedBody = joinNonEmpty("\n\n", params.threadContextNote, prefixedBodyWithEvents);
  const queueBodyBase = joinNonEmpty("\n\n", params.threadContextNote, bodyWithEvents);
  const mediaNote = buildInboundMediaNote(params.ctx);
  const mediaReplyHint = mediaNote ? REPLY_MEDIA_HINT : undefined;
  const queuedBodyRaw = mediaNote
    ? joinNonEmpty("\n", mediaNote, mediaReplyHint, queueBodyBase).trim()
    : queueBodyBase;
  const prefixedCommandBodyRaw = mediaNote
    ? joinNonEmpty("\n", mediaNote, mediaReplyHint, prefixedBody).trim()
    : prefixedBody;
  const transcriptBody = params.transcriptBody ?? params.effectiveBaseBody;
  const transcriptCommandBodyRaw = mediaNote
    ? joinNonEmpty("\n", mediaNote, transcriptBody).trim()
    : transcriptBody;
  return {
    mediaNote,
    mediaReplyHint,
    prefixedCommandBody: annotateInterSessionPromptText(
      prefixedCommandBodyRaw,
      params.sessionCtx.InputProvenance,
    ),
    queuedBody: annotateInterSessionPromptText(queuedBodyRaw, params.sessionCtx.InputProvenance),
    transcriptCommandBody: annotateInterSessionPromptText(
      transcriptCommandBodyRaw,
      params.sessionCtx.InputProvenance,
    ),
  };
}
