import path from "node:path";
import type { MediaAttachment } from "../../packages/media-understanding-common/src/types.js";
import type { RuntimeMsgContext as MsgContext, TemplateContext } from "../auto-reply/templating.js";

export function cliTemplateContext(
  params: { ctx: MsgContext; attachment: MediaAttachment },
  {
    mediaPath,
    outputDir,
    outputBase,
    prompt,
    language,
    maxChars,
  }: {
    mediaPath: string;
    outputDir: string;
    outputBase: string;
    prompt: string;
    language?: string;
    maxChars?: number;
  },
): TemplateContext & Record<string, unknown> {
  const { ctx } = params;
  const templCtx: TemplateContext & Record<string, unknown> = {
    ...ctx,
    AttachmentPath: mediaPath,
    AttachmentUrl: params.attachment.url ?? params.attachment.path ?? mediaPath,
    AttachmentContentType: params.attachment.mime,
    AttachmentDir: path.dirname(mediaPath),
    AttachmentIndex: params.attachment.index,
    MediaPath: mediaPath,
    MediaUrl: params.attachment.url ?? params.attachment.path ?? mediaPath,
    MediaType: params.attachment.mime,
    MediaDir: path.dirname(mediaPath),
    OutputDir: outputDir,
    OutputBase: outputBase,
    Prompt: prompt,
    ...(language ? { Language: language } : {}),
    MaxChars: maxChars,
  };
  for (const key of [
    "MediaPaths",
    "MediaUrls",
    "MediaTypes",
    "MediaWorkspaceDir",
    "MediaTranscribedIndexes",
    "MediaStaged",
  ]) {
    delete templCtx[key];
  }

  return templCtx;
}
