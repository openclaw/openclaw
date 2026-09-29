// Media-understanding entry execution handles provider/CLI attempts, auth
// rotation, output extraction, and decision summaries.
import fs from "node:fs/promises";
import path from "node:path";
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { expectDefined } from "@openclaw/normalization-core";
import { ok, type Result } from "@openclaw/normalization-core/result";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { MediaUnderstandingSkipError } from "../../packages/media-understanding-common/src/errors.js";
import { extractGeminiResponse } from "../../packages/media-understanding-common/src/output-extract.js";
import { normalizeMediaExecutionProviderId } from "../../packages/media-understanding-common/src/provider-id.js";
import {
  estimateBase64Size,
  resolveVideoMaxBase64Bytes,
} from "../../packages/media-understanding-common/src/video.js";
import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../agents/api-key-rotation.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
import {
  mergeModelProviderRequestOverrides,
  sanitizeConfiguredModelProviderRequest,
  sanitizeConfiguredProviderRequest,
} from "../agents/provider-request-config.js";
import type { RuntimeMsgContext as MsgContext, TemplateContext } from "../auto-reply/templating.js";
import { applyTemplate } from "../auto-reply/templating.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.js";
import type {
  MediaUnderstandingConfig,
  MediaUnderstandingModelConfig,
} from "../config/types.tools.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { hasErrnoCode } from "../infra/errors.js";
import { writeExternalFileWithinRoot } from "../infra/fs-safe.js";
import { resolveProxyFetchFromEnv } from "../infra/net/proxy-fetch.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { ImageOptimizationLimitError } from "../media/image-optimization-error.js";
import { runFfmpeg } from "../media/media-services.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalProviderCatalogEntries,
} from "../plugins/official-external-plugin-catalog.js";
import { resolveOfficialExternalPluginRepairHint } from "../plugins/official-external-plugin-repair-hints.js";
import { runExec } from "../process/exec.js";
import { providerOperationRetryConfig } from "../provider-runtime/operation-retry.js";
import { assertSecretOwnerAvailable } from "../secrets/runtime-degraded-state.js";
import { assertRuntimeMediaRequestSecretOwnerAvailable } from "../secrets/runtime-media-secret-owner.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { MediaAttachmentCache } from "./attachments.js";
import { CLI_OUTPUT_MAX_BUFFER, MIN_AUDIO_FILE_BYTES } from "./defaults.constants.js";
import {
  normalizeImageDescriptionInput,
  optimizeImageDescriptionInput,
} from "./image-input-normalize.js";
import { describeImageWithModel } from "./image-runtime.js";
import {
  recordLocalAudioBackendObservation,
  resolveRequestedLocalAudioBackend,
} from "./local-audio.js";
import { resolveOpenAiAudioAuthModelApi } from "./openai-audio-api.js";
import { getMediaUnderstandingProvider, normalizeMediaProviderId } from "./provider-registry.js";
import { resolveCliModelEntry, resolveEntryRunOptions } from "./resolve.js";
import { isTranscriptArtifactText } from "./transcription-text.js";
import type {
  AudioTranscriptionResult,
  AudioTranscriptionRequest,
  MediaAttachment,
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingModelDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";

type ProviderRegistry = Map<string, MediaUnderstandingProvider>;
const loadModelAuth = createLazyRuntimeModule(async () => await import("../agents/model-auth.js"));

function sanitizeProviderHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      continue;
    }
    // Intentionally preserve marker-shaped values here. This path handles
    // explicit config/runtime provider headers, where literal values may
    // legitimately match marker patterns; discovered models.json entries are
    // sanitized separately in the model registry path.
    next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function trimOutput(text: string, maxChars?: number): string {
  const trimmed = text.trim();
  if (!maxChars || trimmed.length <= maxChars) {
    return trimmed;
  }
  return truncateUtf16Safe(trimmed, maxChars).trim();
}

function extractSherpaOnnxText(raw: string): { matched: boolean; text: string } {
  const noMatch = { matched: false, text: "" };
  const tryParse = (value: string): { matched: boolean; text: string } => {
    const trimmed = value.trim();
    if (!trimmed) {
      return noMatch;
    }
    const head = trimmed[0];
    if (head !== "{" && head !== '"') {
      return noMatch;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") {
        return tryParse(parsed);
      }
      if (parsed && typeof parsed === "object") {
        const text = (parsed as { text?: unknown }).text;
        if (typeof text === "string") {
          return { matched: true, text: text.trim() };
        }
      }
    } catch {}
    return noMatch;
  };

  const direct = tryParse(raw);
  if (direct.matched) {
    return direct;
  }

  const lines = normalizeStringEntries(raw.split("\n"));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = tryParse(lines[i] ?? "");
    if (parsed.matched) {
      return parsed;
    }
  }
  return noMatch;
}

function commandBase(command: string): string {
  return path.parse(command).name;
}

function isAntigravityCliCommand(command: string): boolean {
  const commandId = commandBase(command);
  return commandId === "agy" || commandId === "antigravity";
}

function findArgValue(args: string[], keys: string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (keys.includes(arg)) {
      const value = args[index + 1];
      if (value) {
        return value;
      }
    }
    for (const key of keys) {
      const prefix = `${key}=`;
      if (arg.startsWith(prefix)) {
        const value = arg.slice(prefix.length);
        if (value) {
          return value;
        }
      }
    }
  }
  return undefined;
}

function hasArg(args: string[], keys: string[]): boolean {
  return args.some((arg) => keys.includes(arg));
}

function resolveWhisperOutputPath(args: string[], mediaPath: string): string | null {
  const outputDir = findArgValue(args, ["--output_dir", "-o"]);
  if (!outputDir) {
    return null;
  }
  const outputFormat = findArgValue(args, ["--output_format", "-f"]) ?? "all";
  if (outputFormat !== "txt" && outputFormat !== "all") {
    return null;
  }
  return path.join(outputDir, `${path.parse(mediaPath).name}.txt`);
}

function resolveWhisperCppOutputPath(args: string[]): string | null {
  if (!hasArg(args, ["-otxt", "--output-txt"])) {
    return null;
  }
  const outputBase = findArgValue(args, ["-of", "--output-file"]);
  if (!outputBase) {
    return null;
  }
  return `${outputBase}.txt`;
}

function resolveParakeetOutputPath(args: string[], mediaPath: string): string | null {
  const outputDir = findArgValue(args, ["--output-dir"]);
  const outputFormat =
    findArgValue(args, ["--output-format"]) ?? (process.env.PARAKEET_OUTPUT_FORMAT || "srt");
  const outputTemplate =
    findArgValue(args, ["--output-template"]) ??
    (process.env.PARAKEET_OUTPUT_TEMPLATE || "{filename}");
  if (
    !outputDir ||
    (outputFormat !== "txt" && outputFormat !== "all") ||
    outputTemplate !== "{filename}"
  ) {
    return null;
  }
  return path.join(outputDir, `${path.parse(mediaPath).name}.txt`);
}

async function readCliTranscriptFile(filePath: string): Promise<string> {
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

async function resolveCliOutput(params: {
  command: string;
  args: string[];
  stdout: string;
  mediaPath: string;
}): Promise<string> {
  const commandId = commandBase(params.command);
  const fileOutput =
    commandId === "whisper-cli"
      ? resolveWhisperCppOutputPath(params.args)
      : commandId === "whisper"
        ? resolveWhisperOutputPath(params.args, params.mediaPath)
        : commandId === "parakeet-mlx"
          ? resolveParakeetOutputPath(params.args, params.mediaPath)
          : null;
  if (fileOutput) {
    // A known file-output contract is authoritative: falling back would expose
    // progress/status stdout as user speech when transcription is empty or missing.
    return await readCliTranscriptFile(fileOutput);
  }

  if (commandId === "gemini") {
    const response = extractGeminiResponse(params.stdout);
    if (response) {
      return response;
    }
  }

  if (commandId === "sherpa-onnx-offline") {
    const response = extractSherpaOnnxText(params.stdout);
    if (response.matched) {
      return response.text;
    }
  }

  return params.stdout.trim();
}

async function resolveCliMediaPath(params: {
  capability: MediaUnderstandingCapability;
  command: string;
  mediaPath: string;
  outputDir: string;
}): Promise<string> {
  const commandId = commandBase(params.command);
  if (params.capability !== "audio" || commandId !== "whisper-cli") {
    return params.mediaPath;
  }

  const ext = normalizeLowercaseStringOrEmpty(path.extname(params.mediaPath));
  if (ext === ".wav") {
    return params.mediaPath;
  }

  const wavPath = path.join(params.outputDir, `${path.parse(params.mediaPath).name}.wav`);
  await fs.mkdir(params.outputDir, { recursive: true });
  await writeExternalFileWithinRoot({
    rootDir: params.outputDir,
    path: path.basename(wavPath),
    write: async (outputPath) => {
      await runFfmpeg([
        "-y",
        "-i",
        params.mediaPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        outputPath,
      ]);
    },
  });
  return wavPath;
}

type ProviderQuery = Record<string, string | number | boolean>;

function resolveProviderQuery(params: {
  providerId: string;
  config?: MediaUnderstandingConfig;
  entry: MediaUnderstandingModelConfig;
}): ProviderQuery | undefined {
  const { providerId, config, entry } = params;
  const query: ProviderQuery = {};
  for (const [key, value] of Object.entries({
    ...config?.providerOptions?.[providerId],
    ...entry.providerOptions?.[providerId],
  })) {
    if (value !== undefined) {
      // Preserve assignment semantics for prototype-named query keys.
      query[key] = value;
    }
  }
  if (providerId === "deepgram") {
    for (const [input, output] of [
      ["detectLanguage", "detect_language"],
      ["smartFormat", "smart_format"],
    ] as const) {
      const value = query[input];
      if (value !== undefined) {
        query[output] = value;
        delete query[input];
      }
    }
  }
  return Object.keys(query).length > 0 ? query : undefined;
}

/** Builds the normalized decision record for one provider or CLI model attempt. */
export function buildModelDecision(params: {
  entry: MediaUnderstandingModelConfig;
  entryType: "provider" | "cli";
  outcome: MediaUnderstandingModelDecision["outcome"];
  reason?: string;
}): MediaUnderstandingModelDecision {
  if (params.entryType === "cli") {
    const command = params.entry.command?.trim();
    const requestedBackend = command
      ? resolveRequestedLocalAudioBackend({
          command,
          args: params.entry.args ?? [],
        })
      : undefined;
    return {
      type: "cli",
      provider: command ?? "cli",
      model: params.entry.model ?? command,
      ...(requestedBackend ? { requestedBackend } : {}),
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

export type MediaRequestOverrides = {
  prompt?: string;
  language?: string;
};

type ProviderExecutionAuth =
  | {
      kind: "api-key";
      apiKeys: string[];
      source?: string;
    }
  | {
      kind: "none";
      source: string;
    };

function executeProviderRequest<T>(
  provider: string,
  auth: ProviderExecutionAuth,
  execute: (auth: Pick<AudioTranscriptionRequest, "apiKey" | "auth">) => Promise<T>,
): Promise<T> {
  return auth.kind === "api-key"
    ? executeWithApiKeyRotation({
        provider,
        apiKeys: auth.apiKeys,
        transientRetry: providerOperationRetryConfig("read"),
        execute: (apiKey) =>
          execute({
            apiKey,
            auth: { kind: "api-key", apiKey, source: auth.source },
          }),
      })
    : execute({
        apiKey: CUSTOM_LOCAL_AUTH_MARKER,
        auth: { kind: "none", source: auth.source ?? `provider:${provider}` },
      });
}

async function resolveProviderExecutionAuth(params: {
  capability: MediaUnderstandingCapability;
  providerId: string;
  provider?: MediaUnderstandingProvider;
  cfg: OpenClawConfig;
  entry: MediaUnderstandingModelConfig;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<ProviderExecutionAuth> {
  const apiKeyAuth = (apiKey: string, source?: string): ProviderExecutionAuth => ({
    kind: "api-key",
    apiKeys: collectProviderApiKeysForExecution({
      provider: params.providerId,
      primaryApiKey: apiKey,
    }),
    source,
  });
  const providerConfig = findNormalizedProviderValue(
    params.cfg.models?.providers,
    params.providerId,
  );
  const literalApiKey = normalizeNullableString(
    params.cfg.models?.providers?.[params.providerId]?.apiKey,
  );
  if (literalApiKey) {
    return apiKeyAuth(literalApiKey, `models.providers.${params.providerId}.apiKey`);
  }
  const resolveMediaProviderAuth = (): ProviderExecutionAuth | undefined => {
    const context = {
      config: params.cfg,
      provider: params.providerId,
      providerConfig,
    };
    const providerAuth = params.provider?.resolveAuth?.(context);
    if (providerAuth?.kind === "none") {
      return providerAuth;
    }
    const keyAuth = providerAuth ?? params.provider?.resolveSyntheticAuth?.(context);
    const apiKey = keyAuth?.apiKey.trim();
    return apiKey ? apiKeyAuth(apiKey, keyAuth?.source) : undefined;
  };
  const { isProviderAuthError, requireApiKey, resolveApiKeyForProviderCore } =
    await loadModelAuth();
  try {
    const auth = await resolveApiKeyForProviderCore({
      provider: params.providerId,
      cfg: params.cfg,
      profileId: params.entry.profile,
      preferredProfile: params.entry.preferredProfile,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      modelApi: resolveOpenAiAudioAuthModelApi({
        capability: params.capability,
        providerId: params.providerId,
      }),
    });
    return apiKeyAuth(requireApiKey(auth, params.providerId), auth.source);
  } catch (err) {
    if (
      !isProviderAuthError(err, "missing-provider-auth") &&
      !isProviderAuthError(err, "missing-api-key")
    ) {
      throw err;
    }
    const mediaAuth = resolveMediaProviderAuth();
    if (mediaAuth) {
      return mediaAuth;
    }
    throw err;
  }
}

function resolveProviderRequestContext(params: {
  providerId: string;
  cfg: OpenClawConfig;
  entry: MediaUnderstandingModelConfig;
  config?: MediaUnderstandingConfig;
}) {
  const providerConfig = findNormalizedProviderValue(
    params.cfg.models?.providers,
    params.providerId,
  );
  const baseUrl = params.entry.baseUrl ?? params.config?.baseUrl ?? providerConfig?.baseUrl;
  const mergedHeaders = {
    ...sanitizeProviderHeaders(providerConfig?.headers as Record<string, unknown> | undefined),
    ...sanitizeProviderHeaders(params.config?.headers as Record<string, unknown> | undefined),
    ...sanitizeProviderHeaders(params.entry.headers as Record<string, unknown> | undefined),
  };
  const headers = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;
  const request = mergeModelProviderRequestOverrides(
    sanitizeConfiguredModelProviderRequest(providerConfig?.request),
    sanitizeConfiguredProviderRequest(params.config?.request),
    sanitizeConfiguredProviderRequest(params.entry.request),
  );
  return { baseUrl, headers, request };
}

/** Formats a compact operator-facing summary of a media-understanding decision. */
export function formatDecisionSummary(decision: MediaUnderstandingDecision): string {
  const attachments = Array.isArray(decision.attachments) ? decision.attachments : [];
  const total = attachments.length;
  const success = attachments.filter((entry) => entry?.chosen?.outcome === "success").length;
  const chosen = attachments.find((entry) => entry?.chosen)?.chosen;
  const provider = typeof chosen?.provider === "string" ? chosen.provider.trim() : undefined;
  const model = typeof chosen?.model === "string" ? chosen.model.trim() : undefined;
  const modelLabel = provider
    ? model && model !== provider
      ? `${provider}/${model}`
      : provider
    : undefined;
  const backendLabel = chosen?.observedBackend
    ? ` observed=${chosen.observedBackend}`
    : chosen?.requestedBackend
      ? ` requested=${chosen.requestedBackend}`
      : "";
  const reason = findDecisionReason(decision, decision.outcome === "failed" ? "failed" : undefined);
  const shortReason = summarizeDecisionReason(reason);
  const countLabel = total > 0 ? ` (${success}/${total})` : "";
  const viaLabel = modelLabel ? ` via ${modelLabel}${backendLabel}` : "";
  const reasonLabel = shortReason ? ` reason=${shortReason}` : "";
  return `${decision.capability}: ${decision.outcome}${countLabel}${viaLabel}${reasonLabel}`;
}

/** Returns the first non-empty attempt reason, optionally filtered by outcome. */
export function findDecisionReason(
  decision: MediaUnderstandingDecision,
  outcome?: MediaUnderstandingModelDecision["outcome"],
): string | undefined {
  const attachments = Array.isArray(decision.attachments) ? decision.attachments : [];
  for (const attachment of attachments) {
    const attempts = Array.isArray(attachment?.attempts) ? attachment.attempts : [];
    for (const attempt of attempts) {
      if (outcome && attempt.outcome !== outcome) {
        continue;
      }
      if (typeof attempt.reason !== "string" || attempt.reason.trim().length === 0) {
        continue;
      }
      return attempt.reason;
    }
  }
  return undefined;
}

/** Trims provider/runtime error prefixes into a stable human-readable reason. */
export function normalizeDecisionReason(reason?: string): string | undefined {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/^Error:\s*/i, "").trim();
  return normalized || undefined;
}

/** Produces the short reason token used in status and decision summary output. */
export function summarizeDecisionReason(reason?: string): string | undefined {
  const normalized = normalizeDecisionReason(reason);
  if (!normalized) {
    return undefined;
  }
  return normalized.split(":")[0]?.trim() || undefined;
}

function assertMinAudioSize(params: { size: number; attachmentIndex: number }): void {
  if (params.size >= MIN_AUDIO_FILE_BYTES) {
    return;
  }
  throw new MediaUnderstandingSkipError(
    "tooSmall",
    `Audio attachment ${params.attachmentIndex + 1} is too small (${params.size} bytes, minimum ${MIN_AUDIO_FILE_BYTES})`,
  );
}

function formatMissingProviderHint(providerId: string): string {
  const trimmed = providerId.trim();
  if (!trimmed) {
    return "";
  }
  // Channel-only and non-media providers must not receive media-plugin install hints.
  const providerEntry = listOfficialExternalProviderCatalogEntries().find((entry) => {
    const manifest = getOfficialExternalPluginCatalogManifest(entry);
    const mediaProviders = manifest?.contracts?.mediaUnderstandingProviders ?? [];
    return mediaProviders.some((mediaId) => mediaId === trimmed);
  });
  if (!providerEntry) {
    return "";
  }
  const catalogHint = resolveOfficialExternalPluginRepairHint(trimmed);
  if (!catalogHint) {
    return "";
  }
  return ` Install the official external plugin with: ${formatCliCommand(catalogHint.installCommand)}, then run ${formatCliCommand("openclaw plugins registry --refresh")} and stop and start the gateway service, or run ${formatCliCommand(catalogHint.doctorFixCommand)} to repair automatically.`;
}

/** Executes one provider-backed media-understanding entry for one attachment. */
export async function runProviderEntry(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: OpenClawConfig;
  ctx: MsgContext;
  attachmentIndex: number;
  cache: MediaAttachmentCache;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  providerRegistry: ProviderRegistry;
  config?: MediaUnderstandingConfig;
  secretOwnerId?: string;
  request?: MediaRequestOverrides;
}): Promise<Result<MediaUnderstandingOutput | null, unknown>> {
  const { entry, capability, cfg } = params;
  const providerIdRaw = entry.provider?.trim();
  if (!providerIdRaw) {
    throw new Error(`Provider entry missing provider for ${capability}`);
  }
  const providerId = normalizeMediaProviderId(providerIdRaw);
  const requestProviderId = normalizeMediaExecutionProviderId(providerIdRaw);
  assertRuntimeMediaRequestSecretOwnerAvailable({ capability, entry });
  if (params.secretOwnerId) {
    assertSecretOwnerAvailable("capability", params.secretOwnerId);
  }
  const { maxBytes, maxChars, timeoutMs, prompt, hasConfiguredPrompt } = resolveEntryRunOptions({
    capability,
    entry,
    cfg,
    config: params.config,
  });

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
    const normalizedMedia = await normalizeImageDescriptionInput({
      buffer: media.buffer,
      fileName: media.fileName,
      mime: media.mime,
      maxBytes,
    });
    let optimizedMedia: Awaited<ReturnType<typeof optimizeImageDescriptionInput>>;
    try {
      optimizedMedia = await optimizeImageDescriptionInput({
        ...normalizedMedia,
        fileName: media.fileName,
        maxBytes,
        cfg,
        provider: requestProviderId,
        model: modelId,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
      });
    } catch (error) {
      if (error instanceof ImageOptimizationLimitError) {
        throw new MediaUnderstandingSkipError(
          "maxBytes",
          `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${error.maxBytes}`,
        );
      }
      throw error;
    }
    const provider = getMediaUnderstandingProvider(requestProviderId, params.providerRegistry);
    const imageInput = {
      buffer: optimizedMedia.buffer,
      fileName: optimizedMedia.fileName ?? media.fileName,
      mime: optimizedMedia.mime,
      model: modelId,
      provider: requestProviderId,
      prompt: params.request?.prompt ?? prompt,
      timeoutMs,
      profile: entry.profile,
      preferredProfile: entry.preferredProfile,
      agentId: params.agentId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
    };
    const describeImage = provider?.describeImage ?? describeImageWithModel;
    const result = await describeImage(imageInput);
    return ok({
      kind: "image.description",
      attachmentIndex: params.attachmentIndex,
      text: trimOutput(result.text, maxChars),
      provider: requestProviderId,
      model: result.model ?? modelId,
    });
  }

  const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
  if (!provider) {
    throw new Error(
      `Media provider not available: ${providerId}${formatMissingProviderHint(providerId)}`,
    );
  }

  // Resolve proxy-aware fetch from env vars (HTTPS_PROXY, HTTP_PROXY, etc.)
  // so provider HTTP calls are routed through the proxy when configured.
  const fetchFn = resolveProxyFetchFromEnv();

  if (capability === "audio") {
    if (!provider.transcribeAudio && !provider.transcribeAudioWithContext) {
      throw new Error(`Audio transcription provider "${providerId}" not available.`);
    }
    const media = await params.cache.getBuffer({
      attachmentIndex: params.attachmentIndex,
      maxBytes,
      timeoutMs,
    });
    assertMinAudioSize({ size: media.size, attachmentIndex: params.attachmentIndex });
    const audioLanguage = params.request?.language ?? entry.language ?? params.config?.language;
    // STT prompts are spelling/context hints; injected instructions can be echoed on silence.
    const audioPrompt = params.request?.prompt ?? (hasConfiguredPrompt ? prompt : undefined);
    const transport = resolveProviderRequestContext({
      providerId,
      cfg,
      entry,
      config: params.config,
    });
    const providerQuery = resolveProviderQuery({
      providerId,
      config: params.config,
      entry,
    });
    const model =
      entry.model?.trim() ||
      (await import("./defaults.js")).resolveDefaultMediaModel({
        cfg,
        providerId,
        capability: "audio",
        workspaceDir: params.workspaceDir,
      }) ||
      entry.model;
    const input = {
      buffer: media.buffer,
      fileName: media.fileName,
      mime: media.mime,
      ...transport,
      model,
      language: audioLanguage,
      prompt: audioPrompt,
      query: providerQuery,
      timeoutMs,
      fetchFn,
    };
    let result: AudioTranscriptionResult;
    if (provider.transcribeAudioWithContext) {
      const attempt = await provider.transcribeAudioWithContext({
        ...input,
        cfg,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        profile: entry.profile,
        preferredProfile: entry.preferredProfile,
      });
      if (!attempt.ok) {
        return attempt;
      }
      result = attempt.value;
    } else {
      const transcribeAudio = expectDefined(
        provider.transcribeAudio,
        "audio transcription callback",
      );
      const auth = await resolveProviderExecutionAuth({
        capability,
        providerId,
        provider,
        cfg,
        entry,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
      });
      result = await executeProviderRequest(providerId, auth, (requestAuth) =>
        transcribeAudio({ ...input, ...requestAuth }),
      );
    }
    if (isTranscriptArtifactText(result.text)) {
      return ok(null);
    }
    return ok({
      kind: "audio.transcription",
      attachmentIndex: params.attachmentIndex,
      text: trimOutput(result.text, maxChars),
      provider: providerId,
      model: result.model ?? model,
    });
  }

  if (!provider.describeVideo) {
    throw new Error(`Video understanding provider "${providerId}" not available.`);
  }
  const describeVideo = provider.describeVideo;
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
  const auth = await resolveProviderExecutionAuth({
    capability,
    providerId,
    provider,
    cfg,
    entry,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  const { baseUrl, headers, request } = resolveProviderRequestContext({
    providerId,
    cfg,
    entry,
    config: params.config,
  });
  const model =
    entry.model?.trim() ||
    (await import("./defaults.js")).resolveDefaultMediaModel({
      cfg,
      providerId,
      capability: "video",
      workspaceDir: params.workspaceDir,
      providerRegistry: params.providerRegistry,
    }) ||
    entry.model;
  const result = await executeProviderRequest(providerId, auth, (requestAuth) =>
    describeVideo({
      buffer: media.buffer,
      fileName: media.fileName,
      mime: media.mime,
      ...requestAuth,
      baseUrl,
      headers,
      request,
      model,
      prompt,
      timeoutMs,
      fetchFn,
    }),
  );
  return ok({
    kind: "video.description",
    attachmentIndex: params.attachmentIndex,
    text: trimOutput(result.text, maxChars),
    provider: providerId,
    model: result.model ?? model,
  });
}

/** Executes one CLI-backed media-understanding entry for one attachment. */
export async function runCliEntry(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: OpenClawConfig;
  ctx: MsgContext;
  attachment: MediaAttachment;
  cache: MediaAttachmentCache;
  config?: MediaUnderstandingConfig;
  request?: MediaRequestOverrides;
}): Promise<MediaUnderstandingOutput | null> {
  const { entry, capability, cfg, ctx } = params;
  const attachmentIndex = params.attachment.index;
  const cli = resolveCliModelEntry(entry);
  if (!cli.ok) {
    throw cli.error;
  }
  const { command, args } = cli.value;
  const language = params.request?.language ?? entry.language ?? params.config?.language;
  const { maxBytes, maxChars, timeoutMs, prompt } = resolveEntryRunOptions({
    capability,
    entry,
    cfg,
    config: params.config,
  });
  const attachmentPath = await params.cache.getPath({
    attachmentIndex,
    maxBytes,
    timeoutMs,
  });
  if (capability === "audio") {
    const stat = await fs.stat(attachmentPath);
    assertMinAudioSize({ size: stat.size, attachmentIndex });
  }
  const outputDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-media-cli-"),
  );
  try {
    const mediaPath = await resolveCliMediaPath({
      capability,
      command,
      mediaPath: attachmentPath,
      outputDir,
    });
    const outputBase = path.join(outputDir, path.parse(mediaPath).name);

    const templCtx: TemplateContext & Record<string, unknown> = {
      ...ctx,
      AttachmentPath: mediaPath,
      AttachmentUrl: params.attachment.url ?? params.attachment.path ?? mediaPath,
      AttachmentContentType: params.attachment.mime,
      AttachmentDir: path.dirname(mediaPath),
      AttachmentIndex: params.attachment.index,
      MediaPath: mediaPath,
      MediaUrl: params.attachment.url ?? params.attachment.path ?? mediaPath,
      MediaType: params.attachment.mime,
      MediaDir: path.dirname(mediaPath),
      OutputDir: outputDir,
      OutputBase: outputBase,
      Prompt: params.request?.prompt ?? prompt,
      ...(capability === "audio" && language ? { Language: language } : {}),
      MaxChars: maxChars,
    };
    for (const key of [
      "MediaPaths",
      "MediaUrls",
      "MediaTypes",
      "MediaWorkspaceDir",
      "MediaTranscribedIndexes",
      "MediaStaged",
    ]) {
      delete templCtx[key];
    }
    const argv = [command, ...args].map((part, index) =>
      index === 0 ? part : applyTemplate(part, templCtx),
    );
    if (shouldLogVerbose()) {
      logVerbose(`Media understanding via CLI: ${argv.join(" ")}`);
    }
    const { stdout, stderr } = await runExec(
      expectDefined(argv[0], "argv entry at 0"),
      argv.slice(1),
      {
        timeoutMs,
        maxBuffer: CLI_OUTPUT_MAX_BUFFER,
        cwd: isAntigravityCliCommand(command) ? path.dirname(mediaPath) : undefined,
      },
    );
    const requestedBackend =
      capability === "audio"
        ? resolveRequestedLocalAudioBackend({
            command,
            args: argv.slice(1),
          })
        : undefined;
    const observedBackend =
      capability === "audio"
        ? recordLocalAudioBackendObservation({
            command,
            args: argv.slice(1),
            output: `${stderr ?? ""}\n${stdout}`,
          })
        : undefined;
    const resolved = await resolveCliOutput({
      command,
      args: argv.slice(1),
      stdout,
      mediaPath,
    });
    const text = trimOutput(resolved, maxChars);
    if (!text || (capability === "audio" && isTranscriptArtifactText(resolved))) {
      return null;
    }
    return {
      kind: capability === "audio" ? "audio.transcription" : `${capability}.description`,
      attachmentIndex,
      text,
      provider: capability === "audio" ? commandBase(command) : "cli",
      model: command,
      ...(requestedBackend ? { requestedBackend } : {}),
      ...(observedBackend ? { observedBackend } : {}),
    };
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
