import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import type { MediaUnderstandingProvider } from "./types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { isAudioAttachment } from "./attachments.js";
import {
  type ActiveMediaModel,
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";

/**
 * Transcribes the first audio attachment BEFORE mention checking.
 * This allows voice notes to be processed in group chats with requireMention: true.
 * Returns the transcript or undefined if transcription fails or no audio is found.
 */
export async function transcribeFirstAudio(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
}): Promise<string | undefined> {
  const { ctx, cfg } = params;

  // Check if audio transcription is enabled in config
  const audioConfig = cfg.tools?.media?.audio;
  if (!audioConfig || audioConfig.enabled === false) {
    return undefined;
  }

  const attachments = normalizeMediaAttachments(ctx);
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  // Find first audio attachment
  const firstAudio = attachments.find(
    (att) => att && isAudioAttachment(att) && !att.alreadyTranscribed,
  );

  if (!firstAudio) {
    return undefined;
  }

  if (shouldLogVerbose()) {
    logVerbose(`audio-preflight: transcribing attachment ${firstAudio.index} for mention check`);
  }

  const providerRegistry = buildProviderRegistry(params.providers);
  const cache = createMediaAttachmentCache(attachments);

  try {
    const result = await runCapability({
      capability: "audio",
      cfg,
      ctx,
      attachments: cache,
      media: attachments,
      agentDir: params.agentDir,
      providerRegistry,
      config: audioConfig,
      activeModel: params.activeModel,
    });

    if (!result || result.outputs.length === 0) {
      return undefined;
    }

    // Extract transcript from first audio output
    const audioOutput = result.outputs.find((output) => output.kind === "audio.transcription");
    if (!audioOutput || !audioOutput.text) {
      return undefined;
    }

    // Mark this attachment as transcribed to avoid double-processing
    firstAudio.alreadyTranscribed = true;

    if (shouldLogVerbose()) {
      logVerbose(
        `audio-preflight: transcribed ${audioOutput.text.length} chars from attachment ${firstAudio.index}`,
      );
    }

    return audioOutput.text;
  } catch (err) {
    // Log but don't throw - let the message proceed with text-only mention check
    if (shouldLogVerbose()) {
      logVerbose(`audio-preflight: transcription failed: ${String(err)}`);
    }
    return undefined;
  } finally {
    await cache.cleanup();
  }
}
