import type { ActiveMediaModel } from "../../packages/media-understanding-common/src/active-model.js";
import { formatAudioTranscripts } from "../../packages/media-understanding-common/src/format.js";
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

type AudioPreflightParams = {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  assertCurrent?: () => void;
  agentDir?: string;
  workspaceDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
};

/**
 * Transcribes the first audio attachment BEFORE mention checking.
 * This allows voice notes to be processed in group chats with requireMention: true.
 * Returns the transcript or undefined if transcription fails or no audio is found.
 */
export async function transcribeFirstAudio(
  params: AudioPreflightParams,
): Promise<string | undefined> {
  return transcribeAudio(params, true);
}

/** Transcribes the configured audio selection before an internal user turn is staged. */
export async function transcribeAudioAttachments(
  params: AudioPreflightParams,
): Promise<string | undefined> {
  return transcribeAudio(params, false);
}

async function transcribeAudio(
  params: AudioPreflightParams,
  firstOnly: boolean,
): Promise<string | undefined> {
  const { ctx, cfg } = params;

  const audioConfig = cfg.tools?.media?.audio;
  if (audioConfig?.enabled === false) {
    return undefined;
  }

  const attachments = normalizeMediaAttachments(ctx);
  const firstAudio = attachments.find((att) => isAudioAttachment(att) && !att.alreadyTranscribed);

  if (!firstAudio) {
    return undefined;
  }

  if (shouldLogVerbose()) {
    logVerbose(
      firstOnly
        ? `audio-preflight: transcribing attachment ${firstAudio.index} for mention check`
        : "audio-preflight: transcribing configured audio selection",
    );
  }

  try {
    const media = firstOnly ? [firstAudio] : attachments;
    const { agentDir, providers, activeModel } = params;
    const localPathRoots = resolveMediaAttachmentLocalRoots({ cfg, ctx });
    const providerRegistry = buildProviderRegistry(providers, cfg);
    const cache = createMediaAttachmentCache(media, {
      localPathRoots,
      ssrfPolicy: cfg.tools?.web?.fetch?.ssrfPolicy,
    });
    let result: Awaited<ReturnType<typeof runCapability>>;
    try {
      result = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        agentDir,
        workspaceDir: params.workspaceDir,
        assertCurrent: params.assertCurrent,
        providerRegistry,
        config: cfg.tools?.media?.audio,
        activeModel,
      });
    } finally {
      await cache.cleanup();
    }
    const audioOutputs = result.outputs.filter(
      (entry) => entry.kind === "audio.transcription" && entry.text.trim(),
    );
    const transcript = formatAudioTranscripts(audioOutputs).trim();
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
    for (const output of audioOutputs) {
      const index = firstOnly ? firstAudio.index : output.attachmentIndex;
      const fact = facts[index];
      if (fact) {
        facts[index] = { ...fact, transcribed: true };
      }
    }
    ctx.media = facts;
    if (!firstOnly) {
      // Retain both selected and dropped indexes: consuming a successful result
      // must not give a later pass a fresh attachment-selection budget.
      ctx.MediaUnderstandingDecisions = [
        ...(ctx.MediaUnderstandingDecisions ?? []),
        result.decision,
      ];
    }

    if (shouldLogVerbose()) {
      logVerbose(`audio-preflight: transcribed ${transcript.length} chars`);
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
