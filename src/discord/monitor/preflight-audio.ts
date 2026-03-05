import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";

type DiscordAudioAttachment = {
  content_type?: string;
  url?: string;
};

function collectAudioAttachments(
  attachments: DiscordAudioAttachment[] | undefined,
): DiscordAudioAttachment[] {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.filter((att) => att.content_type?.startsWith("audio/"));
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
  abortSignal?: AbortSignal;
}): Promise<{
  hasAudioAttachment: boolean;
  hasTypedText: boolean;
  transcript?: string;
}> {
  const audioAttachments = collectAudioAttachments(params.message.attachments);
  const hasAudioAttachment = audioAttachments.length > 0;
  const hasTypedText = Boolean(params.message.content?.trim());
  const needsPreflightTranscription =
    !params.isDirectMessage &&
    params.shouldRequireMention &&
    hasAudioAttachment &&
    // `baseText` includes media placeholders; gate on typed text only.
    !hasTypedText &&
    params.mentionRegexes.length > 0;

  let transcript: string | undefined;
  if (needsPreflightTranscription) {
    if (params.abortSignal?.aborted) {
      return {
        hasAudioAttachment,
        hasTypedText,
      };
    }
    try {
      const { transcribeFirstAudio } = await import("../../media-understanding/audio-preflight.js");
      if (params.abortSignal?.aborted) {
        return {
          hasAudioAttachment,
          hasTypedText,
        };
      }
      const audioUrls = audioAttachments
        .map((att) => att.url)
        .filter((url): url is string => typeof url === "string" && url.length > 0);
      if (audioUrls.length > 0) {
        const transcriptCtx = {
          MediaUrls: audioUrls,
          MediaTypes: audioAttachments
            .map((att) => att.content_type)
            .filter((contentType): contentType is string => Boolean(contentType)),
        };
        const transcriptionPromise = transcribeFirstAudio({
          ctx: transcriptCtx,
          cfg: params.cfg,
          agentDir: undefined,
        });
        // Race against abort so a slow transcription does not hold up the
        // channel queue when the listener has already timed out (issue #36017).
        if (params.abortSignal && !params.abortSignal.aborted) {
          const abortPromise = new Promise<undefined>((resolve) => {
            params.abortSignal!.addEventListener("abort", () => resolve(undefined), { once: true });
          });
          transcript = await Promise.race([transcriptionPromise, abortPromise]);
        } else {
          transcript = await transcriptionPromise;
        }
        if (params.abortSignal?.aborted) {
          transcript = undefined;
        }
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
