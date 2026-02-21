import type { OpenClawConfig } from "../config/config.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";

/**
 * Transcribe an audio file using the configured media-understanding provider.
 *
 * Reads provider/model/apiKey from `tools.media.audio` in the openclaw config,
 * falling back through configured models until one succeeds.
 *
 * This is the runtime-exposed entry point for external plugins (e.g. marmot)
 * that need STT without importing internal media-understanding modules directly.
 */
export async function transcribeAudioFile(params: {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  mime?: string;
}): Promise<{ text: string | undefined }> {
  const ctx = {
    MediaPath: params.filePath,
    MediaType: params.mime ?? "audio/wav",
  };
  const attachments = normalizeMediaAttachments(ctx);
  if (attachments.length === 0) {
    return { text: undefined };
  }
  const cache = createMediaAttachmentCache(attachments);
  const providerRegistry = buildProviderRegistry();
  try {
    const result = await runCapability({
      capability: "audio",
      cfg: params.cfg,
      ctx,
      attachments: cache,
      media: attachments,
      agentDir: params.agentDir,
      providerRegistry,
      config: params.cfg.tools?.media?.audio,
    });
    const output = result.outputs.find((entry) => entry.kind === "audio.transcription");
    const text = output?.text?.trim();
    return { text: text || undefined };
  } finally {
    await cache.cleanup();
  }
}
