import type { ClawdbotConfig } from "../config/config.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { applyTemplate } from "../auto-reply/templating.js";
import { requireApiKey, resolveApiKeyForProvider } from "../agents/model-auth.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { runExec } from "../process/exec.js";
import type {
  MediaUnderstandingConfig,
  MediaUnderstandingModelConfig,
} from "../config/types.tools.js";
import { MediaAttachmentCache, normalizeAttachments, selectAttachments } from "./attachments.js";
import {
  CLI_OUTPUT_MAX_BUFFER,
  DEFAULT_AUDIO_MODELS,
  DEFAULT_TIMEOUT_SECONDS,
} from "./defaults.js";
import { isMediaUnderstandingSkipError, MediaUnderstandingSkipError } from "./errors.js";
import {
  resolveEntriesWithActiveFallback,
  resolveMaxBytes,
  resolveMaxChars,
  resolvePrompt,
  resolveScopeDecision,
  resolveTimeoutMs,
} from "./resolve.js";
import type {
  MediaAttachment,
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingModelDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
  normalizeMediaProviderId,
} from "./providers/index.js";
import { describeImageWithModel } from "./providers/image.js";
import { estimateBase64Size, resolveVideoMaxBase64Bytes } from "./video.js";

const AUTO_AUDIO_PROVIDERS = ["openai", "groq", "deepgram"] as const;

export type ActiveMediaModel = {
  provider: string;
  model?: string;
};

type ProviderRegistry = Map<string, MediaUnderstandingProvider>;

export type RunCapabilityResult = {
  outputs: MediaUnderstandingOutput[];
  decision: MediaUnderstandingDecision;
};

export function buildProviderRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
): ProviderRegistry {
  return buildMediaUnderstandingRegistry(overrides);
}

export function normalizeMediaAttachments(ctx: MsgContext): MediaAttachment[] {
  return normalizeAttachments(ctx);
}

export function createMediaAttachmentCache(attachments: MediaAttachment[]): MediaAttachmentCache {
  return new MediaAttachmentCache(attachments);
}

async function resolveAutoAudioEntries(params: {
  cfg: ClawdbotConfig;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
}): Promise<MediaUnderstandingModelConfig[]> {
  const entries: MediaUnderstandingModelConfig[] = [];
  for (const providerId of AUTO_AUDIO_PROVIDERS) {
    const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
    if (!provider?.transcribeAudio) continue;
    try {
      await resolveApiKeyForProvider({
        provider: providerId,
        cfg: params.cfg,
        agentDir: params.agentDir,
      });
      entries.push({ type: "provider", provider: providerId });
    } catch {
      continue;
    }
  }
  return entries;
}

function trimOutput(text: string, maxChars?: number): string {
  const trimmed = text.trim();
  if (!maxChars || trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).trim();
}

type ProviderQuery = Record<string, string | number | boolean>;

function normalizeProviderQuery(
  options?: Record<string, string | number | boolean>,
): ProviderQuery | undefined {
  if (!options) return undefined;
  const query: ProviderQuery = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    query[key] = value;
  }
  return Object.keys(query).length > 0 ? query : undefined;
}

function buildDeepgramCompatQuery(options?: {
  detectLanguage?: boolean;
  punctuate?: boolean;
  smartFormat?: boolean;
}): ProviderQuery | undefined {
  if (!options) return undefined;
  const query: ProviderQuery = {};
  if (typeof options.detectLanguage === "boolean") query.detect_language = options.detectLanguage;
  if (typeof options.punctuate === "boolean") query.punctuate = options.punctuate;
  if (typeof options.smartFormat === "boolean") query.smart_format = options.smartFormat;
  return Object.keys(query).length > 0 ? query : undefined;
}

function normalizeDeepgramQueryKeys(query: ProviderQuery): ProviderQuery {
  const normalized = { ...query };
  if ("detectLanguage" in normalized) {
    normalized.detect_language = normalized.detectLanguage as boolean;
    delete normalized.detectLanguage;
  }
  if ("smartFormat" in normalized) {
    normalized.smart_format = normalized.smartFormat as boolean;
    delete normalized.smartFormat;
  }
  return normalized;
}

function resolveProviderQuery(params: {
  providerId: string;
  config?: MediaUnderstandingConfig;
  entry: MediaUnderstandingModelConfig;
}): ProviderQuery | undefined {
  const { providerId, config, entry } = params;
  const mergedOptions = normalizeProviderQuery({
    ...config?.providerOptions?.[providerId],
    ...entry.providerOptions?.[providerId],
  });
  if (providerId !== "deepgram") {
    return mergedOptions;
  }
  let query = normalizeDeepgramQueryKeys(mergedOptions ?? {});
  const compat = buildDeepgramCompatQuery({ ...config?.deepgram, ...entry.deepgram });
  for (const [key, value] of Object.entries(compat ?? {})) {
    if (query[key] === undefined) {
      query[key] = value;
    }
  }
  return Object.keys(query).length > 0 ? query : undefined;
}

function buildModelDecision(params: {
  entry: MediaUnderstandingModelConfig;
  entryType: "provider" | "cli";
  outcome: MediaUnderstandingModelDecision["outcome"];
  reason?: string;
}): MediaUnderstandingModelDecision {
  if (params.entryType === "cli") {
    const command = params.entry.command?.trim();
    return {
      type: "cli",
      provider: command ?? "cli",
      model: params.entry.model ?? command,
      outcome: params.outcome,
      reason: params.reason,
    };
  }
  const providerIdRaw = params.entry.provider?.trim();
  const providerId = providerIdRaw ? normalizeMediaProviderId(providerIdRaw) : undefined;
  return {
    type: "provider",
    provider: providerId ?? providerIdRaw,
    model: params.entry.model,
    outcome: params.outcome,
    reason: params.reason,
  };
}

function formatDecisionSummary(decision: MediaUnderstandingDecision): string {
  const total = decision.attachments.length;
  const success = decision.attachments.filter(
    (entry) => entry.chosen?.outcome === "success",
  ).length;
  const chosen = decision.attachments.find((entry) => entry.chosen)?.chosen;
  const provider = chosen?.provider?.trim();
  const model = chosen?.model?.trim();
  const modelLabel = provider ? (model ? `${provider}/${model}` : provider) : undefined;
  const reason = decision.attachments
    .flatMap((entry) => entry.attempts.map((attempt) => attempt.reason).filter(Boolean))
    .find(Boolean);
  const shortReason = reason ? reason.split(":")[0]?.trim() : undefined;
  const countLabel = total > 0 ? ` (${success}/${total})` : "";
  const viaLabel = modelLabel ? ` via ${modelLabel}` : "";
  const reasonLabel = shortReason ? ` reason=${shortReason}` : "";
  return `${decision.capability}: ${decision.outcome}${countLabel}${viaLabel}${reasonLabel}`;
}

async function runProviderEntry(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: ClawdbotConfig;
  ctx: MsgContext;
  attachmentIndex: number;
  cache: MediaAttachmentCache;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  config?: MediaUnderstandingConfig;
}): Promise<MediaUnderstandingOutput | null> {
  const { entry, capability, cfg } = params;
  const providerIdRaw = entry.provider?.trim();
  if (!providerIdRaw) {
    throw new Error(`Provider entry missing provider for ${capability}`);
  }
  const providerId = normalizeMediaProviderId(providerIdRaw);
  const maxBytes = resolveMaxBytes({ capability, entry, cfg, config: params.config });
  const maxChars = resolveMaxChars({ capability, entry, cfg, config: params.config });
  const timeoutMs = resolveTimeoutMs(
    entry.timeoutSeconds ??
      params.config?.timeoutSeconds ??
      cfg.tools?.media?.[capability]?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS[capability],
  );
  const prompt = resolvePrompt(
    capability,
    entry.prompt ?? params.config?.prompt ?? cfg.tools?.media?.[capability]?.prompt,
    maxChars,
  );

  if (capability === "image") {
    if (!params.agentDir) {
      throw new Error("Image understanding requires agentDir");
    }
    const modelId = entry.model?.trim();
    if (!modelId) {
      throw new Error("Image understanding requires model id");
    }
    const media = await params.cache.getBuffer({
      attachmentIndex: params.attachmentIndex,
      maxBytes,
      timeoutMs,
    });
    const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
    const result = provider?.describeImage
      ? await provider.describeImage({
          buffer: media.buffer,
          fileName: media.fileName,
          mime: media.mime,
          model: modelId,
          provider: providerId,
          prompt,
          timeoutMs,
          profile: entry.profile,
          preferredProfile: entry.preferredProfile,
          agentDir: params.agentDir,
          cfg: params.cfg,
        })
      : await describeImageWithModel({
          buffer: media.buffer,
          fileName: media.fileName,
          mime: media.mime,
          model: modelId,
          provider: providerId,
          prompt,
          timeoutMs,
          profile: entry.profile,
          preferredProfile: entry.preferredProfile,
          agentDir: params.agentDir,
          cfg: params.cfg,
        });
    return {
      kind: "image.description",
      attachmentIndex: params.attachmentIndex,
      text: trimOutput(result.text, maxChars),
      provider: providerId,
      model: result.model ?? modelId,
    };
  }

  const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
  if (!provider) {
    throw new Error(`Media provider not available: ${providerId}`);
  }

  if (capability === "audio") {
    if (!provider.transcribeAudio) {
      throw new Error(`Audio transcription provider "${providerId}" not available.`);
    }
    const media = await params.cache.getBuffer({
      attachmentIndex: params.attachmentIndex,
      maxBytes,
      timeoutMs,
    });
    const auth = await resolveApiKeyForProvider({
      provider: providerId,
      cfg,
      profileId: entry.profile,
      preferredProfile: entry.preferredProfile,
      agentDir: params.agentDir,
    });
    const apiKey = requireApiKey(auth, providerId);
    const providerConfig = cfg.models?.providers?.[providerId];
    const baseUrl = entry.baseUrl ?? params.config?.baseUrl ?? providerConfig?.baseUrl;
    const mergedHeaders = {
      ...providerConfig?.headers,
      ...params.config?.headers,
      ...entry.headers,
    };
    const headers = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;
    const providerQuery = resolveProviderQuery({
      providerId,
      config: params.config,
      entry,
    });
    const model = entry.model?.trim() || DEFAULT_AUDIO_MODELS[providerId] || entry.model;
    const result = await provider.transcribeAudio({
      buffer: media.buffer,
      fileName: media.fileName,
      mime: media.mime,
      apiKey,
      baseUrl,
      headers,
      model,
      language: entry.language ?? params.config?.language ?? cfg.tools?.media?.audio?.language,
      prompt,
      query: providerQuery,
      timeoutMs,
    });
    return {
      kind: "audio.transcription",
      attachmentIndex: params.attachmentIndex,
      text: trimOutput(result.text, maxChars),
      provider: providerId,
      model: result.model ?? model,
    };
  }

  if (!provider.describeVideo) {
    throw new Error(`Video understanding provider "${providerId}" not available.`);
  }
  const media = await params.cache.getBuffer({
    attachmentIndex: params.attachmentIndex,
    maxBytes,
    timeoutMs,
  });
  const estimatedBase64Bytes = estimateBase64Size(media.size);
  const maxBase64Bytes = resolveVideoMaxBase64Bytes(maxBytes);
  if (estimatedBase64Bytes > maxBase64Bytes) {
    throw new MediaUnderstandingSkipError(
      "maxBytes",
      `Video attachment ${params.attachmentIndex + 1} base64 payload ${estimatedBase64Bytes} exceeds ${maxBase64Bytes}`,
    );
  }
  const auth = await resolveApiKeyForProvider({
    provider: providerId,
    cfg,
    profileId: entry.profile,
    preferredProfile: entry.preferredProfile,
    agentDir: params.agentDir,
  });
  const apiKey = requireApiKey(auth, providerId);
  const providerConfig = cfg.models?.providers?.[providerId];
  const result = await provider.describeVideo({
    buffer: media.buffer,
    fileName: media.fileName,
    mime: media.mime,
    apiKey,
    baseUrl: providerConfig?.baseUrl,
    headers: providerConfig?.headers,
    model: entry.model,
    prompt,
    timeoutMs,
  });
  return {
    kind: "video.description",
    attachmentIndex: params.attachmentIndex,
    text: trimOutput(result.text, maxChars),
    provider: providerId,
    model: result.model ?? entry.model,
  };
}

async function runCliEntry(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: ClawdbotConfig;
  ctx: MsgContext;
  attachmentIndex: number;
  cache: MediaAttachmentCache;
  config?: MediaUnderstandingConfig;
}): Promise<MediaUnderstandingOutput | null> {
  const { entry, capability, cfg, ctx } = params;
  const command = entry.command?.trim();
  const args = entry.args ?? [];
  if (!command) {
    throw new Error(`CLI entry missing command for ${capability}`);
  }
  const maxBytes = resolveMaxBytes({ capability, entry, cfg, config: params.config });
  const maxChars = resolveMaxChars({ capability, entry, cfg, config: params.config });
  const timeoutMs = resolveTimeoutMs(
    entry.timeoutSeconds ??
      params.config?.timeoutSeconds ??
      cfg.tools?.media?.[capability]?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS[capability],
  );
  const prompt = resolvePrompt(
    capability,
    entry.prompt ?? params.config?.prompt ?? cfg.tools?.media?.[capability]?.prompt,
    maxChars,
  );
  const pathResult = await params.cache.getPath({
    attachmentIndex: params.attachmentIndex,
    maxBytes,
    timeoutMs,
  });

  const templCtx: MsgContext = {
    ...ctx,
    MediaPath: pathResult.path,
    Prompt: prompt,
    MaxChars: maxChars,
  };
  const argv = [command, ...args].map((part, index) =>
    index === 0 ? part : applyTemplate(part, templCtx),
  );
  if (shouldLogVerbose()) {
    logVerbose(`Media understanding via CLI: ${argv.join(" ")}`);
  }
  const { stdout } = await runExec(argv[0], argv.slice(1), {
    timeoutMs,
    maxBuffer: CLI_OUTPUT_MAX_BUFFER,
  });
  const text = trimOutput(stdout, maxChars);
  if (!text) return null;
  return {
    kind: capability === "audio" ? "audio.transcription" : `${capability}.description`,
    attachmentIndex: params.attachmentIndex,
    text,
    provider: "cli",
    model: command,
  };
}

async function runAttachmentEntries(params: {
  capability: MediaUnderstandingCapability;
  cfg: ClawdbotConfig;
  ctx: MsgContext;
  attachmentIndex: number;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  cache: MediaAttachmentCache;
  entries: MediaUnderstandingModelConfig[];
  config?: MediaUnderstandingConfig;
}): Promise<{
  output: MediaUnderstandingOutput | null;
  attempts: MediaUnderstandingModelDecision[];
}> {
  const { entries, capability } = params;
  const attempts: MediaUnderstandingModelDecision[] = [];
  for (const entry of entries) {
    const entryType = entry.type ?? (entry.command ? "cli" : "provider");
    try {
      const result =
        entryType === "cli"
          ? await runCliEntry({
              capability,
              entry,
              cfg: params.cfg,
              ctx: params.ctx,
              attachmentIndex: params.attachmentIndex,
              cache: params.cache,
              config: params.config,
            })
          : await runProviderEntry({
              capability,
              entry,
              cfg: params.cfg,
              ctx: params.ctx,
              attachmentIndex: params.attachmentIndex,
              cache: params.cache,
              agentDir: params.agentDir,
              providerRegistry: params.providerRegistry,
              config: params.config,
            });
      if (result) {
        const decision = buildModelDecision({ entry, entryType, outcome: "success" });
        if (result.provider) decision.provider = result.provider;
        if (result.model) decision.model = result.model;
        attempts.push(decision);
        return { output: result, attempts };
      }
      attempts.push(
        buildModelDecision({ entry, entryType, outcome: "skipped", reason: "empty output" }),
      );
    } catch (err) {
      if (isMediaUnderstandingSkipError(err)) {
        attempts.push(
          buildModelDecision({
            entry,
            entryType,
            outcome: "skipped",
            reason: `${err.reason}: ${err.message}`,
          }),
        );
        if (shouldLogVerbose()) {
          logVerbose(`Skipping ${capability} model due to ${err.reason}: ${err.message}`);
        }
        continue;
      }
      attempts.push(
        buildModelDecision({
          entry,
          entryType,
          outcome: "failed",
          reason: String(err),
        }),
      );
      if (shouldLogVerbose()) {
        logVerbose(`${capability} understanding failed: ${String(err)}`);
      }
    }
  }

  return { output: null, attempts };
}

export async function runCapability(params: {
  capability: MediaUnderstandingCapability;
  cfg: ClawdbotConfig;
  ctx: MsgContext;
  attachments: MediaAttachmentCache;
  media: MediaAttachment[];
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  config?: MediaUnderstandingConfig;
  activeModel?: ActiveMediaModel;
}): Promise<RunCapabilityResult> {
  const { capability, cfg, ctx } = params;
  const config = params.config ?? cfg.tools?.media?.[capability];
  if (config?.enabled === false) {
    return {
      outputs: [],
      decision: { capability, outcome: "disabled", attachments: [] },
    };
  }

  const attachmentPolicy = config?.attachments;
  const selected = selectAttachments({
    capability,
    attachments: params.media,
    policy: attachmentPolicy,
  });
  if (selected.length === 0) {
    return {
      outputs: [],
      decision: { capability, outcome: "no-attachment", attachments: [] },
    };
  }

  const scopeDecision = resolveScopeDecision({ scope: config?.scope, ctx });
  if (scopeDecision === "deny") {
    if (shouldLogVerbose()) {
      logVerbose(`${capability} understanding disabled by scope policy.`);
    }
    return {
      outputs: [],
      decision: {
        capability,
        outcome: "scope-deny",
        attachments: selected.map((item) => ({ attachmentIndex: item.index, attempts: [] })),
      },
    };
  }

  const entries = resolveEntriesWithActiveFallback({
    cfg,
    capability,
    config,
    providerRegistry: params.providerRegistry,
    activeModel: params.activeModel,
  });
  let resolvedEntries = entries;
  if (resolvedEntries.length === 0 && capability === "audio") {
    resolvedEntries = await resolveAutoAudioEntries({
      cfg,
      agentDir: params.agentDir,
      providerRegistry: params.providerRegistry,
    });
  }
  if (resolvedEntries.length === 0) {
    return {
      outputs: [],
      decision: {
        capability,
        outcome: "skipped",
        attachments: selected.map((item) => ({ attachmentIndex: item.index, attempts: [] })),
      },
    };
  }

  const outputs: MediaUnderstandingOutput[] = [];
  const attachmentDecisions: MediaUnderstandingDecision["attachments"] = [];
  for (const attachment of selected) {
    const { output, attempts } = await runAttachmentEntries({
      capability,
      cfg,
      ctx,
      attachmentIndex: attachment.index,
      agentDir: params.agentDir,
      providerRegistry: params.providerRegistry,
      cache: params.attachments,
      entries: resolvedEntries,
      config,
    });
    if (output) outputs.push(output);
    attachmentDecisions.push({
      attachmentIndex: attachment.index,
      attempts,
      chosen: attempts.find((attempt) => attempt.outcome === "success"),
    });
  }
  const decision: MediaUnderstandingDecision = {
    capability,
    outcome: outputs.length > 0 ? "success" : "skipped",
    attachments: attachmentDecisions,
  };
  if (shouldLogVerbose()) {
    logVerbose(`Media understanding ${formatDecisionSummary(decision)}`);
  }
  return {
    outputs,
    decision,
  };
}
