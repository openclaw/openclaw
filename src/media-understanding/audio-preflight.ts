import type { ActiveMediaModel } from "../../packages/media-understanding-common/src/active-model.js";
// Audio preflight transcribes voice notes before mention checks and optionally
// echoes the transcript back to the source chat.
import type { RuntimeMsgContext as MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { normalizeMediaFacts } from "../media/media-facts.js";
import { isAudioAttachment } from "./attachments.js";
import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  resolveMediaAttachmentLocalRoots,
  runCapability,
} from "./runner.js";
import type { MediaUnderstandingProvider } from "./types.js";

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

  const audioConfig = cfg.tools?.media?.audio;
  if (audioConfig?.enabled === false) {
    return undefined;
  }

  const firstAudio = normalizeMediaAttachments(ctx).find(
    (att) => isAudioAttachment(att) && !att.alreadyTranscribed,
  );

  if (!firstAudio) {
    return undefined;
  }

  if (shouldLogVerbose()) {
    logVerbose(`audio-preflight: transcribing attachment ${firstAudio.index} for mention check`);
  }

  try {
    const media = [firstAudio];
    const { agentDir, providers, activeModel } = params;
    const localPathRoots = resolveMediaAttachmentLocalRoots({ cfg, ctx });
    const providerRegistry = buildProviderRegistry(providers, cfg);
    const cache = createMediaAttachmentCache(media, {
      localPathRoots,
      ssrfPolicy: cfg.tools?.web?.fetch?.ssrfPolicy,
    });
    let transcript: string | undefined;
    try {
      const result = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        agentDir,
        providerRegistry,
        config: cfg.tools?.media?.audio,
        activeModel,
      });
      transcript = result.outputs
        .find((entry) => entry.kind === "audio.transcription")
        ?.text?.trim();
    } finally {
      await cache.cleanup();
    }
    if (!transcript) {
      return undefined;
    }

    if (audioConfig?.echoTranscript) {
      await sendTranscriptEcho({
        ctx,
        cfg,
        transcript,
        format: audioConfig.echoFormat ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT,
      });
    }

    // Persist transcription state on the matching fact so later normalization
    // cannot shift or lose it through a parallel index list.
    const facts = normalizeMediaFacts(ctx.media);
    const transcribedFact = facts[firstAudio.index];
    if (transcribedFact) {
      facts[firstAudio.index] = { ...transcribedFact, transcribed: true };
      ctx.media = facts;
    }

    if (shouldLogVerbose()) {
      logVerbose(
        `audio-preflight: transcribed ${transcript.length} chars from attachment ${firstAudio.index}`,
      );
    }

    return transcript;
  } catch (err) {
    // Preflight cannot block message handling; mention checks can still run on text-only input.
    if (shouldLogVerbose()) {
      logVerbose(`audio-preflight: transcription failed: ${String(err)}`);
    }
    return undefined;
  }
}
