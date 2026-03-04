import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { isAudioFileName } from "../../media/mime.js";

type DiscordAudioAttachment = {
  content_type?: string;
  url?: string;
  filename?: string;
};

function collectAudioAttachments(
  attachments: DiscordAudioAttachment[] | undefined,
): DiscordAudioAttachment[] {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.filter(
    (att) =>
      att.content_type?.startsWith("audio/") ||
      // Fallback: detect audio by filename extension for voice messages
      // Discord voice messages may lack content_type but have .ogg/.opus extension
      isAudioFileName(att.filename),
  );
}

const MEDIA_PLACEHOLDER_RE = /\u003cmedia:(?:document|voice)\u003e/gi;

function hasMeaningfulText(content: string | undefined): boolean {
  if (!content) {
    return false;
  }
  // Remove media placeholders and check if any real text remains
  const withoutPlaceholders = content.replace(MEDIA_PLACEHOLDER_RE, "").trim();
  return withoutPlaceholders.length > 0;
}

export async function resolveDiscordPreflightAudioMentionContext(params: {
  message: {
    attachments?: DiscordAudioAttachment[];
    content?: string;
  };
  isDirectMessage: boolean;
  shouldRequireMention: boolean;
  mentionRegexes: RegExp[];
  cfg: OpenClawConfig;
}): Promise<{
  hasAudioAttachment: boolean;
  hasTypedText: boolean;
  transcript?: string;
}> {
  const audioAttachments = collectAudioAttachments(params.message.attachments);
  const hasAudioAttachment = audioAttachments.length > 0;
  // Treat messages with only media placeholders as having no typed text
  const hasTypedText = hasMeaningfulText(params.message.content);
  const needsPreflightTranscription =
    !params.isDirectMessage &&
    params.shouldRequireMention &&
    hasAudioAttachment &&
    // `baseText` includes media placeholders; gate on typed text only.
    !hasTypedText &&
    params.mentionRegexes.length > 0;

  let transcript: string | undefined;
  if (needsPreflightTranscription) {
    try {
      const { transcribeFirstAudio } = await import("../../media-understanding/audio-preflight.js");
      // Filter entries with valid URLs while preserving positional alignment for MediaTypes
      const audioEntries = audioAttachments.filter(
        (att): att is DiscordAudioAttachment & { url: string } =>
          typeof att.url === "string" && att.url.length > 0,
      );
      const audioUrls = audioEntries.map((att) => att.url);
      // Keep undefined slots to maintain positional alignment with audioUrls
      // resolveAttachmentKind falls back to URL-extension detection when MIME is empty
      const audioMediaTypes = audioEntries.map((att) => att.content_type ?? "");

      if (audioUrls.length > 0) {
        transcript = await transcribeFirstAudio({
          ctx: {
            MediaUrls: audioUrls,
            MediaTypes: audioMediaTypes,
          },
          cfg: params.cfg,
          agentDir: undefined,
        });
      }
    } catch (err) {
      logVerbose(`discord: audio preflight transcription failed: ${String(err)}`);
    }
  }

  return {
    hasAudioAttachment,
    hasTypedText,
    transcript,
  };
}
