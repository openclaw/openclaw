import type { ClawdbotConfig } from "../config/config.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { applyTemplate } from "../auto-reply/templating.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
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
  extractMediaUserText,
  formatAudioTranscripts,
  formatMediaUnderstandingBody,
} from "./format.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
  normalizeMediaProviderId,
} from "./providers/index.js";
import { describeImageWithModel } from "./providers/image.js";
import {
  resolveCapabilityConfig,
  inferProviderCapabilities,
  resolveConcurrency,
  resolveMaxBytes,
  resolveMaxChars,
  resolveModelEntries,
  resolvePrompt,
  resolveScopeDecision,
  resolveTimeoutMs,
} from "./resolve.js";
import type {
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingModelDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";
import { runWithConcurrency } from "./concurrency.js";
import { estimateBase64Size, resolveVideoMaxBase64Bytes } from "./video.js";

export type ApplyMediaUnderstandingResult = {
  outputs: MediaUnderstandingOutput[];
  decisions: MediaUnderstandingDecision[];
  appliedImage: boolean;
  appliedAudio: boolean;
  appliedVideo: boolean;
};

const CAPABILITY_ORDER: MediaUnderstandingCapability[] = ["image", "audio", "video"];

type ActiveMediaModel = {
  provider: string;
  model?: string;
};

function trimOutput(text: string, maxChars?: number): string {
  const trimmed = text.trim();
  if (!maxChars || trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).trim();
}

function resolveEntriesWithActiveFallback(params: {
  cfg: ClawdbotConfig;
  capability: MediaUnderstandingCapability;
  config?: MediaUnderstandingConfig;
  activeModel?: ActiveMediaModel;
}): MediaUnderstandingModelConfig[] {
  const entries = resolveModelEntries({
    cfg: params.cfg,
    capability: params.capability,
    config: params.config,
  });
  if (entries.length > 0) return entries;
  if (params.config?.enabled !== true) return entries;
  const activeProvider = params.activeModel?.provider?.trim();
  if (!activeProvider) return entries;
  const capabilities = inferProviderCapabilities(activeProvider);
  if (!capabilities || !capabilities.includes(params.capability)) return entries;
  return [
    {
      type: "provider",
      provider: activeProvider,
      model: params.activeModel?.model,
    },
  ];
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

async function runProviderEntry(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: ClawdbotConfig;
  ctx: MsgContext;
  attachmentIndex: number;
  cache: MediaAttachmentCache;
  agentDir?: string;
  providerRegistry: Map<string, MediaUnderstandingProvider>;
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
    const key = await resolveApiKeyForProvider({
      provider: providerId,
      cfg,
      profileId: entry.profile,
      preferredProfile: entry.preferredProfile,
      agentDir: params.agentDir,
    });
    const providerConfig = cfg.models?.providers?.[providerId];
    const model = entry.model?.trim() || DEFAULT_AUDIO_MODELS[providerId] || entry.model;
    const result = await provider.transcribeAudio({
      buffer: media.buffer,
      fileName: media.fileName,
      mime: media.mime,
      apiKey: key.apiKey,
      baseUrl: providerConfig?.baseUrl,
      headers: providerConfig?.headers,
      model,
      language: entry.language ?? params.config?.language ?? cfg.tools?.media?.audio?.language,
      prompt,
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
  const key = await resolveApiKeyForProvider({
    provider: providerId,
    cfg,
    profileId: entry.profile,
    preferredProfile: entry.preferredProfile,
    agentDir: params.agentDir,
  });
  const providerConfig = cfg.models?.providers?.[providerId];
  const result = await provider.describeVideo({
    buffer: media.buffer,
    fileName: media.fileName,
    mime: media.mime,
    apiKey: key.apiKey,
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
  providerRegistry: Map<string, MediaUnderstandingProvider>;
  cache: MediaAttachmentCache;
  entries: MediaUnderstandingModelConfig[];
  config?: MediaUnderstandingConfig;
}): Promise<{ output: MediaUnderstandingOutput | null; attempts: MediaUnderstandingModelDecision[] }> {
  const { entries, capability } = params;
  const attempts: MediaUnderstandingModelDecision[] = [];
  for (const entry of entries) {
    try {
      const entryType = entry.type ?? (entry.command ? "cli" : "provider");
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
            entryType: entry.type ?? (entry.command ? "cli" : "provider"),
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
          entryType: entry.type ?? (entry.command ? "cli" : "provider"),
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

async function runCapability(params: {
  capability: MediaUnderstandingCapability;
  cfg: ClawdbotConfig;
  ctx: MsgContext;
  attachments: MediaAttachmentCache;
  media: ReturnType<typeof normalizeAttachments>;
  agentDir?: string;
  providerRegistry: Map<string, MediaUnderstandingProvider>;
  config?: MediaUnderstandingConfig;
  activeModel?: ActiveMediaModel;
}): Promise<{ outputs: MediaUnderstandingOutput[]; decision: MediaUnderstandingDecision }> {
  const { capability, cfg, ctx } = params;
  const config = params.config ?? resolveCapabilityConfig(cfg, capability);
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
    activeModel: params.activeModel,
  });
  if (entries.length === 0) {
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
      entries,
      config,
    });
    if (output) outputs.push(output);
    attachmentDecisions.push({
      attachmentIndex: attachment.index,
      attempts,
      chosen: attempts.find((attempt) => attempt.outcome === "success"),
    });
  }
  return {
    outputs,
    decision: {
      capability,
      outcome: outputs.length > 0 ? "success" : "skipped",
      attachments: attachmentDecisions,
    },
  };
}

export async function applyMediaUnderstanding(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
}): Promise<ApplyMediaUnderstandingResult> {
  const { ctx, cfg } = params;
  const commandCandidates = [ctx.CommandBody, ctx.RawBody, ctx.Body];
  const originalUserText =
    commandCandidates
      .map((value) => extractMediaUserText(value))
      .find((value) => value && value.trim()) ?? undefined;

  const attachments = normalizeAttachments(ctx);
  const providerRegistry = buildMediaUnderstandingRegistry(params.providers);
  const cache = new MediaAttachmentCache(attachments);

  try {
    const tasks = CAPABILITY_ORDER.map((capability) => async () => {
      const config = resolveCapabilityConfig(cfg, capability);
      return await runCapability({
        capability,
        cfg,
        ctx,
        attachments: cache,
        media: attachments,
        agentDir: params.agentDir,
        providerRegistry,
        config,
        activeModel: params.activeModel,
      });
    });

    const results = await runWithConcurrency(tasks, resolveConcurrency(cfg));
    const outputs: MediaUnderstandingOutput[] = [];
    const decisions: MediaUnderstandingDecision[] = [];
    for (const [index] of CAPABILITY_ORDER.entries()) {
      const entry = results[index];
      if (!entry) continue;
      if (Array.isArray(entry.outputs)) {
        for (const output of entry.outputs) {
          outputs.push(output);
        }
      }
      if (entry.decision) {
        decisions.push(entry.decision);
      }
    }

    if (decisions.length > 0) {
      ctx.MediaUnderstandingDecisions = [
        ...(ctx.MediaUnderstandingDecisions ?? []),
        ...decisions,
      ];
    }

    if (outputs.length > 0) {
      ctx.Body = formatMediaUnderstandingBody({ body: ctx.Body, outputs });
      const audioOutputs = outputs.filter((output) => output.kind === "audio.transcription");
      if (audioOutputs.length > 0) {
        const transcript = formatAudioTranscripts(audioOutputs);
        ctx.Transcript = transcript;
        if (originalUserText) {
          ctx.CommandBody = originalUserText;
          ctx.RawBody = originalUserText;
        } else {
          ctx.CommandBody = transcript;
          ctx.RawBody = transcript;
        }
      } else if (originalUserText) {
        ctx.CommandBody = originalUserText;
        ctx.RawBody = originalUserText;
      }
      ctx.MediaUnderstanding = [...(ctx.MediaUnderstanding ?? []), ...outputs];
      finalizeInboundContext(ctx, { forceBodyForAgent: true, forceBodyForCommands: true });
    }

    return {
      outputs,
      decisions,
      appliedImage: outputs.some((output) => output.kind === "image.description"),
      appliedAudio: outputs.some((output) => output.kind === "audio.transcription"),
      appliedVideo: outputs.some((output) => output.kind === "video.description"),
    };
  } finally {
    await cache.cleanup();
  }
}
