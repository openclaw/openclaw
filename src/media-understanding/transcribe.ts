import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  MediaUnderstandingConfig,
  MediaUnderstandingModelConfig,
} from "../config/types.tools.js";
import type { MediaUnderstandingDecision, MediaUnderstandingProvider } from "./types.js";
import { requireApiKey, resolveApiKeyForProvider } from "../agents/model-auth.js";
import { DEFAULT_AUDIO_MODELS, DEFAULT_TIMEOUT_SECONDS } from "./defaults.js";
import { resolveProviderQuery } from "./provider-query.js";
import { getMediaUnderstandingProvider, normalizeMediaProviderId } from "./providers/index.js";
import {
  resolveMaxBytes,
  resolveMaxChars,
  resolvePrompt,
  resolveTimeoutMs,
  resolveModelEntries,
} from "./resolve.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";

export type CoreAudioTranscriptionResult = {
  text: string | null;
  provider?: string;
  model?: string;
  decision: MediaUnderstandingDecision;
};

const AUTO_AUDIO_KEY_PROVIDERS = ["openai", "groq", "deepgram", "google"] as const;

function trimOutput(text: string, maxChars?: number): string {
  const trimmed = text.trim();
  if (!maxChars || trimmed.length <= maxChars) {
    return trimmed;
  }
  return trimmed.slice(0, maxChars).trim();
}

async function resolveAutoAudioEntry(params: {
  cfg: OpenClawConfig;
  providerRegistry: Map<string, MediaUnderstandingProvider>;
}): Promise<MediaUnderstandingModelConfig | null> {
  for (const providerId of AUTO_AUDIO_KEY_PROVIDERS) {
    const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
    if (!provider || !provider.transcribeAudio) {
      continue;
    }
    try {
      await resolveApiKeyForProvider({ provider: providerId, cfg: params.cfg });
      return { type: "provider", provider: providerId };
    } catch {
      continue;
    }
  }
  return null;
}

async function transcribeAudioBufferWithCore(params: {
  cfg: OpenClawConfig;
  buffer: Buffer;
  mime?: string;
  fileName?: string;
}): Promise<CoreAudioTranscriptionResult> {
  const config = params.cfg.tools?.media?.audio;
  if (config?.enabled === false) {
    return {
      text: null,
      decision: { capability: "audio", outcome: "disabled", attachments: [] },
    };
  }

  const providerRegistry = buildProviderRegistry();
  let entries = resolveModelEntries({
    cfg: params.cfg,
    capability: "audio",
    config,
    providerRegistry,
  });
  if (entries.length === 0) {
    const auto = await resolveAutoAudioEntry({ cfg: params.cfg, providerRegistry });
    if (auto) {
      entries = [auto];
    }
  }

  if (entries.length === 0) {
    return {
      text: null,
      decision: { capability: "audio", outcome: "skipped", attachments: [] },
    };
  }

  const hasCliEntry = entries.some(
    (entry) => (entry.type ?? (entry.command ? "cli" : "provider")) === "cli",
  );
  if (hasCliEntry) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audio-core-"));
    const fileExt = params.fileName ? path.extname(params.fileName) : "";
    const ext = fileExt || ".wav";
    const baseName = params.fileName ? path.basename(params.fileName, fileExt) : "audio";
    const fileName = `${baseName}${ext}`;
    const filePath = path.join(tempDir, fileName);
    try {
      await fs.writeFile(filePath, params.buffer);
      const attachments = [{ path: filePath, mime: params.mime, index: 0 }];
      const cache = createMediaAttachmentCache(attachments);
      const ctx: MsgContext = {
        MediaPath: filePath,
        MediaDir: tempDir,
        MediaType: params.mime,
        MediaPaths: [filePath],
        MediaTypes: params.mime ? [params.mime] : undefined,
      };
      const result = await runCapability({
        capability: "audio",
        cfg: params.cfg,
        ctx,
        attachments: cache,
        media: attachments,
        providerRegistry,
        config,
      });
      const output = result.outputs[0];
      return {
        text: output?.text ?? null,
        provider: output?.provider,
        model: output?.model,
        decision: result.decision,
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  let lastError: string | null = null;
  let lastProvider: string | null = null;

  for (const entry of entries) {
    if ((entry.type ?? (entry.command ? "cli" : "provider")) !== "provider") {
      continue;
    }
    const providerIdRaw = entry.provider?.trim();
    if (!providerIdRaw) {
      continue;
    }
    const providerId = normalizeMediaProviderId(providerIdRaw) ?? providerIdRaw;
    const provider = getMediaUnderstandingProvider(providerId, providerRegistry);
    if (!provider?.transcribeAudio) {
      continue;
    }

    const maxBytes = resolveMaxBytes({ capability: "audio", entry, cfg: params.cfg, config });
    if (params.buffer.length > maxBytes) {
      continue;
    }

    const maxChars = resolveMaxChars({ capability: "audio", entry, cfg: params.cfg, config });
    const timeoutMs = resolveTimeoutMs(
      entry.timeoutSeconds ??
        config?.timeoutSeconds ??
        params.cfg.tools?.media?.audio?.timeoutSeconds,
      DEFAULT_TIMEOUT_SECONDS.audio,
    );
    const prompt = resolvePrompt("audio", entry.prompt ?? config?.prompt, maxChars);

    const providerConfig = params.cfg.models?.providers?.[providerId];
    const baseUrl = entry.baseUrl ?? config?.baseUrl ?? providerConfig?.baseUrl;
    const mergedHeaders = {
      ...providerConfig?.headers,
      ...config?.headers,
      ...entry.headers,
    };
    const headers = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;
    const providerQuery = resolveProviderQuery({ providerId, config, entry });
    const model = entry.model?.trim() || DEFAULT_AUDIO_MODELS[providerId] || entry.model;

    try {
      const auth = await resolveApiKeyForProvider({ provider: providerId, cfg: params.cfg });
      const apiKey = requireApiKey(auth, providerId);
      const result = await provider.transcribeAudio({
        buffer: params.buffer,
        fileName: params.fileName ?? "audio.wav",
        mime: params.mime ?? "audio/wav",
        apiKey,
        baseUrl,
        headers,
        model,
        language: entry.language ?? config?.language ?? params.cfg.tools?.media?.audio?.language,
        prompt,
        query: providerQuery,
        timeoutMs,
      });
      const text = trimOutput(result.text, maxChars);
      if (text) {
        return {
          text,
          provider: providerId,
          model: result.model ?? model,
          decision: { capability: "audio", outcome: "success", attachments: [] },
        };
      }
    } catch (err) {
      lastProvider = providerId;
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
  }

  if (lastError) {
    console.warn(
      `[media-understanding] audio transcription failed (last provider ${
        lastProvider ?? "unknown"
      }): ${lastError}`,
    );
  }

  return {
    text: null,
    decision: { capability: "audio", outcome: "skipped", attachments: [] },
  };
}

export async function transcribeAudioWithCore(params: {
  cfg: OpenClawConfig;
  filePath?: string;
  buffer?: Buffer;
  mime?: string;
  ctx?: MsgContext;
}): Promise<CoreAudioTranscriptionResult> {
  if (params.buffer) {
    return await transcribeAudioBufferWithCore({
      cfg: params.cfg,
      buffer: params.buffer,
      mime: params.mime,
      fileName: params.filePath ? path.basename(params.filePath) : undefined,
    });
  }
  if (!params.filePath) {
    return {
      text: null,
      decision: { capability: "audio", outcome: "skipped", attachments: [] },
    };
  }

  const ctx: MsgContext =
    params.ctx ??
    ({ MediaPath: params.filePath, MediaType: params.mime ?? "audio/wav" } as MsgContext);

  const media = normalizeMediaAttachments(ctx);
  const cache = createMediaAttachmentCache(media);
  const providerRegistry = buildProviderRegistry();

  try {
    const result = await runCapability({
      capability: "audio",
      cfg: params.cfg,
      ctx,
      attachments: cache,
      media,
      providerRegistry,
    });

    const output = result.outputs[0];
    return {
      text: output?.text ?? null,
      provider: output?.provider,
      model: output?.model,
      decision: result.decision,
    };
  } finally {
    await cache.cleanup();
  }
}
