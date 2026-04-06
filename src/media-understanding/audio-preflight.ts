import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { isAudioAttachment } from "./attachments.js";
import { runAudioTranscription } from "./audio-transcription-runner.js";
import {
  type ActiveMediaModel,
  normalizeMediaAttachments,
  resolveMediaAttachmentLocalRoots,
} from "./runner.js";
import type { MediaUnderstandingProvider } from "./types.js";

/**
 * Transcribes the first audio attachment BEFORE mention checking.
 * This allows voice notes to be processed in group chats with requireMention: true.
 * Returns the transcript metadata or undefined if transcription fails or no audio is found.
 */
export async function transcribeFirstAudioResult(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
}): Promise<{ transcript?: string; attachmentIndex?: number }> {
  const { ctx, cfg } = params;

  // Check if audio transcription is enabled in config
  const audioConfig = cfg.tools?.media?.audio;
  if (audioConfig?.enabled === false) {
    return {};
  }

  const attachments = normalizeMediaAttachments(ctx);
  if (!attachments || attachments.length === 0) {
    return {};
  }

  // Find first audio attachment
  const firstAudio = attachments.find(
    (att) => att && isAudioAttachment(att) && !att.alreadyTranscribed,
  );

  if (!firstAudio) {
    return {};
  }

  if (shouldLogVerbose()) {
    logVerbose(`audio-preflight: transcribing attachment ${firstAudio.index} for mention check`);
  }

  try {
    const { transcript, attachmentIndex } = await runAudioTranscription({
      ctx,
      cfg,
      attachments,
      agentDir: params.agentDir,
      providers: params.providers,
      activeModel: params.activeModel,
      localPathRoots: resolveMediaAttachmentLocalRoots({ cfg, ctx }),
    });
    if (!transcript) {
      return {};
    }

    const transcribedAttachment =
      typeof attachmentIndex === "number"
        ? attachments.find((attachment) => attachment.index === attachmentIndex)
        : firstAudio;
    if (transcribedAttachment) {
      transcribedAttachment.alreadyTranscribed = true;
    }

    if (shouldLogVerbose()) {
      logVerbose(
        `audio-preflight: transcribed ${transcript.length} chars from attachment ${transcribedAttachment?.index ?? firstAudio.index}`,
      );
    }

    return {
      transcript,
      attachmentIndex: transcribedAttachment?.index,
    };
  } catch (err) {
    // Log but don't throw - let the message proceed with text-only mention check
    if (shouldLogVerbose()) {
      logVerbose(`audio-preflight: transcription failed: ${String(err)}`);
    }
    return {};
  }
}

export async function transcribeFirstAudio(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
}): Promise<string | undefined> {
  return (await transcribeFirstAudioResult(params)).transcript;
}
