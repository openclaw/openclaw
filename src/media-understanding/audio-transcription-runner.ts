// Audio transcription runner executes the configured media-understanding audio
// pipeline and extracts the first transcript output.
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ActiveMediaModel } from "./active-model.types.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";
import type {
  MediaAttachment,
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";

/** Runs the configured audio-understanding pipeline and returns the first transcript output. */
export async function runAudioTranscription(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  attachments?: MediaAttachment[];
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
  localPathRoots?: readonly string[];
}): Promise<{
  transcript: string | undefined;
  attachments: MediaAttachment[];
  output?: MediaUnderstandingOutput;
  decision?: MediaUnderstandingDecision;
}> {
  const attachments = params.attachments ?? normalizeMediaAttachments(params.ctx);
  if (attachments.length === 0) {
    return { transcript: undefined, attachments };
  }

  const providerRegistry = buildProviderRegistry(params.providers, params.cfg);
  const cache = createMediaAttachmentCache(attachments, {
    ...(params.localPathRoots ? { localPathRoots: params.localPathRoots } : {}),
    ssrfPolicy: params.cfg.tools?.web?.fetch?.ssrfPolicy,
  });

  try {
    const result = await runCapability({
      capability: "audio",
      cfg: params.cfg,
      ctx: params.ctx,
      attachments: cache,
      media: attachments,
      agentDir: params.agentDir,
      providerRegistry,
      config: params.cfg.tools?.media?.audio,
      activeModel: params.activeModel,
    });
    const output = result.outputs.find(
      (entry): entry is MediaUnderstandingOutput => entry.kind === "audio.transcription",
    );
    const transcript = output?.text?.trim();
    return { transcript: transcript || undefined, attachments, output, decision: result.decision };
  } finally {
    await cache.cleanup();
  }
}
