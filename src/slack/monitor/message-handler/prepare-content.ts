import { logVerbose } from "../../../globals.js";
import type { SlackFile, SlackMessageEvent } from "../../types.js";
import { type SlackFileContentIssueReason, resolveSlackFileContent } from "../file-content.js";
import {
  MAX_SLACK_MEDIA_FILES,
  resolveSlackAttachmentContent,
  resolveSlackMedia,
  type SlackMediaResult,
  type SlackThreadStarter,
} from "../media.js";

export type SlackResolvedMessageContent = {
  rawBody: string;
  effectiveDirectMedia: SlackMediaResult[] | null;
};

function formatSlackFileIssue(reason: SlackFileContentIssueReason): string {
  switch (reason) {
    case "permission":
      return "permission denied (missing scope or auth)";
    case "size_exceeded":
      return "size exceeds limit";
    case "unsupported_format":
      return "unsupported format";
    case "download_failed":
    default:
      return "download failed";
  }
}

function filterInheritedParentFiles(params: {
  files: SlackFile[] | undefined;
  isThreadReply: boolean;
  threadStarter: SlackThreadStarter | null;
}): SlackFile[] | undefined {
  const { files, isThreadReply, threadStarter } = params;
  if (!isThreadReply || !files?.length) {
    return files;
  }
  if (!threadStarter?.files?.length) {
    return files;
  }
  const starterFileIds = new Set(threadStarter.files.map((file) => file.id));
  const filtered = files.filter((file) => !file.id || !starterFileIds.has(file.id));
  if (filtered.length < files.length) {
    logVerbose(
      `slack: filtered ${files.length - filtered.length} inherited parent file(s) from thread reply`,
    );
  }
  return filtered.length > 0 ? filtered : undefined;
}

export async function resolveSlackMessageContent(params: {
  message: SlackMessageEvent;
  isThreadReply: boolean;
  threadStarter: SlackThreadStarter | null;
  isBotMessage: boolean;
  botToken: string;
  mediaMaxBytes: number;
}): Promise<SlackResolvedMessageContent | null> {
  const ownFiles = filterInheritedParentFiles({
    files: params.message.files,
    isThreadReply: params.isThreadReply,
    threadStarter: params.threadStarter,
  });

  const media = await resolveSlackMedia({
    files: ownFiles,
    token: params.botToken,
    maxBytes: params.mediaMaxBytes,
  });

  const attachmentContent = await resolveSlackAttachmentContent({
    attachments: params.message.attachments,
    token: params.botToken,
    maxBytes: params.mediaMaxBytes,
  });
  const fileContent = await resolveSlackFileContent({
    files: ownFiles,
    token: params.botToken,
    maxBytes: params.mediaMaxBytes,
  });

  const mergedMedia = [...(media ?? []), ...(attachmentContent?.media ?? [])];
  const effectiveDirectMedia = mergedMedia.length > 0 ? mergedMedia : null;
  const mediaPlaceholder = effectiveDirectMedia
    ? effectiveDirectMedia.map((item) => item.placeholder).join(" ")
    : undefined;
  const extractedFileContent = fileContent.snippets
    .map((snippet) => {
      const truncatedNotice = snippet.truncated ? "\n[truncated]" : "";
      return `[Slack file content: ${snippet.fileName}]\n${snippet.text}${truncatedNotice}`;
    })
    .join("\n\n");
  const fileIssueSummary = fileContent.issues
    .map((issue) => `[Slack file skipped: ${issue.fileName}] ${formatSlackFileIssue(issue.reason)}`)
    .join("\n");

  const fallbackFiles = ownFiles ?? [];
  const fileOnlyFallback =
    !mediaPlaceholder && !extractedFileContent && !fileIssueSummary && fallbackFiles.length > 0
      ? fallbackFiles
          .slice(0, MAX_SLACK_MEDIA_FILES)
          .map((file) => file.name?.trim() || "file")
          .join(", ")
      : undefined;
  const fileOnlyPlaceholder = fileOnlyFallback ? `[Slack file: ${fileOnlyFallback}]` : undefined;

  const botAttachmentText =
    params.isBotMessage && !attachmentContent?.text
      ? (params.message.attachments ?? [])
          .map((attachment) => attachment.text?.trim() || attachment.fallback?.trim())
          .filter(Boolean)
          .join("\n")
      : undefined;

  const rawBody =
    [
      (params.message.text ?? "").trim(),
      attachmentContent?.text,
      botAttachmentText,
      extractedFileContent,
      fileIssueSummary,
      mediaPlaceholder,
      fileOnlyPlaceholder,
    ]
      .filter(Boolean)
      .join("\n") || "";
  if (!rawBody) {
    return null;
  }

  return {
    rawBody,
    effectiveDirectMedia,
  };
}
