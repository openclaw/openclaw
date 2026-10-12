// Public file-oriented media-understanding runtime for image, audio, video, and
// structured extraction calls outside normal channel message handling.
import path from "node:path";
import { kindFromMime, mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { resolveAgentDir, resolveDefaultAgentDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.js";
import { DEFAULT_MAX_BYTES } from "./defaults.constants.js";
import {
  normalizeImageDescriptionInput,
  optimizeImageDescriptionInput,
} from "./image-input-normalize.js";
import { describeImageWithModel } from "./image-runtime.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
  normalizeMediaProviderId,
} from "./provider-registry.js";
import { resolveMaxBytes, resolveMediaRuntimeTimeoutMs, resolveModelEntries } from "./resolve.js";
import {
  findDecisionReason,
  normalizeDecisionReason,
  type MediaRequestOverrides,
} from "./runner.entries.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";
import type {
  DescribePreparedImageWithModelParams,
  DescribeImageFileParams,
  DescribeImageFileWithModelParams,
  PrepareImageDescriptionInputParams,
  DescribeVideoFileParams,
  ExtractStructuredWithModelParams,
  RunMediaUnderstandingFileParams,
  RunMediaUnderstandingFileResult,
  TranscribeAudioFileParams,
} from "./runtime-types.js";
import type { MediaUnderstandingCapability, MediaUnderstandingOutput } from "./types.js";
export type {
  DescribePreparedImageWithModelParams,
  DescribeImageFileParams,
  DescribeImageFileWithModelParams,
  PreparedImageDescriptionInput,
  PrepareImageDescriptionInputParams,
  DescribeVideoFileParams,
  ExtractStructuredWithModelParams,
  RunMediaUnderstandingFileParams,
  RunMediaUnderstandingFileResult,
  TranscribeAudioFileParams,
} from "./runtime-types.js";

const KIND_BY_CAPABILITY: Record<MediaUnderstandingCapability, MediaUnderstandingOutput["kind"]> = {
  audio: "audio.transcription",
  image: "image.description",
  video: "video.description",
};

function buildFileContext(
  params: Pick<
    RunMediaUnderstandingFileParams,
    "filePath" | "mediaUrl" | "mime" | "capability" | "scopeContext"
  >,
) {
  // Runtime file calls reuse message-context media plumbing so scope, local roots, and
  // remote URL handling stay identical to normal channel-triggered media understanding.
  const scopeFields = {
    ...(params.scopeContext?.sessionKey ? { SessionKey: params.scopeContext.sessionKey } : {}),
    ...(params.scopeContext?.channel
      ? { Provider: params.scopeContext.channel, Surface: params.scopeContext.channel }
      : {}),
    ...(params.scopeContext?.chatType ? { ChatType: params.scopeContext.chatType } : {}),
  };
  const remoteRef =
    params.mediaUrl ??
    (isRemoteMediaReference(params.filePath) ? params.filePath.trim() : undefined);
  const extensionMime = remoteRef ? mimeTypeFromFilePath(remoteRef) : undefined;
  const extensionKind = kindFromMime(extensionMime);
  const mediaType =
    params.mime ??
    (remoteRef && extensionKind === params.capability ? `${params.capability}/*` : extensionMime) ??
    (remoteRef ? `${params.capability}/*` : undefined);
  return {
    media: [
      remoteRef
        ? { url: remoteRef, contentType: mediaType }
        : { path: params.filePath, contentType: mediaType },
    ],
    ...scopeFields,
  };
}

function isRemoteMediaReference(value: string): boolean {
  return hasHttpUrlPrefix(value.trim());
}

function concreteMime(mime: string | undefined): string | undefined {
  const normalized = mime?.trim();
  if (!normalized || normalized.endsWith("/*")) {
    return undefined;
  }
  return normalized;
}

function resolveFileLocalRoots(filePath: string): string[] | undefined {
  return isRemoteMediaReference(filePath) ? undefined : [path.dirname(filePath)];
}

/** Runs media understanding for one local file or remote URL and returns the first matching output. */
export async function runMediaUnderstandingFile(
  params: RunMediaUnderstandingFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  return runFile(params, { prompt: params.prompt?.trim() || undefined });
}

async function runFile(
  params: RunMediaUnderstandingFileParams,
  request: MediaRequestOverrides,
): Promise<RunMediaUnderstandingFileResult> {
  const { cfg } = params;
  const requestTimeoutSeconds =
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? Math.ceil(params.timeoutMs / 1000)
      : undefined;
  const ctx = buildFileContext(params);
  const attachments = normalizeMediaAttachments(ctx);
  const decisionBase = {
    capability: params.capability,
    attachments: [],
    attachmentProcessing: Object.fromEntries(
      attachments.map(({ index }) => [index, "omitted" as const]),
    ),
    ...(params.capability === "image" ? { nativeVisionActive: false } : {}),
  };
  if (attachments.length === 0) {
    return {
      text: undefined,
      decision: {
        ...decisionBase,
        outcome: "no-attachment",
        attachmentDispositions: {},
      },
    };
  }
  const config = {
    ...cfg.tools?.media?.[params.capability],
    ...(request.prompt ? { prompt: request.prompt } : {}),
    ...(request.language ? { language: request.language } : {}),
    ...(requestTimeoutSeconds !== undefined ? { timeoutSeconds: requestTimeoutSeconds } : {}),
  };
  if (config?.enabled === false) {
    return {
      text: undefined,
      provider: undefined,
      model: undefined,
      output: undefined,
      decision: {
        ...decisionBase,
        outcome: "disabled",
        attachmentDispositions: Object.fromEntries(
          attachments.map((attachment) => [
            attachment.index,
            { kind: "capability-disabled" as const },
          ]),
        ),
      },
    };
  }
  const providerRegistry = buildProviderRegistry(undefined, cfg);
  const agentDir =
    params.agentDir ?? (params.agentId ? resolveAgentDir(cfg, params.agentId) : undefined);
  const cache = createMediaAttachmentCache(attachments, {
    localPathRoots: params.mediaUrl ? undefined : resolveFileLocalRoots(params.filePath),
    ssrfPolicy: cfg.tools?.web?.fetch?.ssrfPolicy,
  });

  try {
    const result = await runCapability({
      capability: params.capability,
      cfg,
      ctx,
      attachments: cache,
      media: attachments,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(agentDir ? { agentDir } : {}),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      providerRegistry,
      config,
      activeModel: params.activeModel,
      request,
    });
    if (result.outputs.length === 0 && result.decision.outcome === "failed") {
      throw new Error(
        normalizeDecisionReason(findDecisionReason(result.decision, "failed")) ??
          `${params.capability} understanding failed`,
      );
    }
    const output = result.outputs.find(
      (entry) => entry.kind === KIND_BY_CAPABILITY[params.capability],
    );
    const text = output?.text?.trim();
    return {
      text: text || undefined,
      provider: output?.provider,
      model: output?.model,
      output,
      decision: result.decision,
    };
  } finally {
    await cache.cleanup();
  }
}

export async function describeImageFile(
  params: DescribeImageFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  return await runMediaUnderstandingFile({ ...params, capability: "image" });
}

/** Reads and normalizes image input once before explicit-model fallback attempts. */
export async function prepareImageDescriptionInput(params: PrepareImageDescriptionInputParams) {
  const timeoutMs = resolveMediaRuntimeTimeoutMs(params.timeoutMs);
  const input = { ...params, timeoutMs };
  const attachments = normalizeMediaAttachments(
    buildFileContext({ ...input, capability: "image" }),
  );
  const cache = createMediaAttachmentCache(attachments, {
    localPathRoots: input.mediaUrl ? undefined : resolveFileLocalRoots(input.filePath),
    ssrfPolicy: input.cfg.tools?.web?.fetch?.ssrfPolicy,
  });
  let image: { buffer: Buffer; fileName: string; mime?: string };
  try {
    const media = await cache.getBuffer({
      attachmentIndex: 0,
      maxBytes: DEFAULT_MAX_BYTES.image,
      timeoutMs,
    });
    image = {
      buffer: media.buffer,
      fileName: media.fileName,
      // Capture the cache MIME and caller fallback before releasing its temporary files.
      mime: media.mime ?? concreteMime(input.mime),
    };
  } finally {
    await cache.cleanup();
  }
  const normalizedImage = await normalizeImageDescriptionInput({
    buffer: image.buffer,
    fileName: image.fileName,
    mime: image.mime,
    maxBytes: DEFAULT_MAX_BYTES.image,
  });
  return {
    buffer: normalizedImage.buffer,
    fileName: image.fileName,
    mime: normalizedImage.mime,
  };
}

export async function describePreparedImageWithModel(params: DescribePreparedImageWithModelParams) {
  const timeoutMs = resolveMediaRuntimeTimeoutMs(params.timeoutMs);
  const providerRegistry = buildProviderRegistry(undefined, params.cfg);
  const provider = providerRegistry.get(normalizeMediaProviderId(params.provider));
  const describeImage = provider?.describeImage ?? describeImageWithModel;
  const agentDir =
    params.agentDir ??
    (params.agentId
      ? resolveAgentDir(params.cfg, params.agentId)
      : resolveDefaultAgentDir(params.cfg));
  const image = await optimizeImageDescriptionInput({
    ...params.image,
    maxBytes: DEFAULT_MAX_BYTES.image,
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    agentDir,
    workspaceDir: params.workspaceDir,
  });
  return await describeImage({
    buffer: image.buffer,
    fileName: image.fileName ?? params.image.fileName,
    mime: image.mime,
    provider: params.provider,
    model: params.model,
    prompt: params.prompt,
    maxTokens: params.maxTokens,
    timeoutMs,
    cfg: params.cfg,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    agentDir,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
}

/** Describes one image with an explicit provider/model, bypassing configured media model selection. */
export async function describeImageFileWithModel(params: DescribeImageFileWithModelParams) {
  const image = await prepareImageDescriptionInput(params);
  return await describePreparedImageWithModel({
    ...params,
    image,
  });
}

export async function extractStructuredWithModel(params: ExtractStructuredWithModelParams) {
  const timeoutMs = resolveMediaRuntimeTimeoutMs(params.timeoutMs);
  if (!params.input.some((entry) => entry.type === "image")) {
    throw new Error("Structured extraction requires at least one image input.");
  }
  const provider = getMediaUnderstandingProvider(
    params.provider,
    buildMediaUnderstandingRegistry(undefined, params.cfg),
  );
  if (!provider?.extractStructured) {
    throw new Error(`Provider does not support structured extraction: ${params.provider}`);
  }
  return await provider.extractStructured({
    input: params.input,
    instructions: params.instructions,
    schemaName: params.schemaName,
    jsonSchema: params.jsonSchema,
    jsonMode: params.jsonMode,
    provider: params.provider,
    model: params.model,
    profile: params.profile,
    preferredProfile: params.preferredProfile,
    authStore: params.authStore,
    timeoutMs,
    cfg: params.cfg,
    agentDir: params.agentDir ?? "",
  });
}

export async function describeVideoFile(
  params: DescribeVideoFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  return await runMediaUnderstandingFile({ ...params, capability: "video" });
}

/** Prepares the largest input that any configured transcription fallback can accept. */
export async function resolveAudioInputBudget(params: {
  cfg: OpenClawConfig;
}): Promise<{ enabled: false } | { enabled: true; maxBytes: number }> {
  const { cfg } = params;
  const config = cfg.tools?.media?.audio;
  if (config?.enabled === false) {
    return { enabled: false };
  }
  const capability = "audio";
  const entries = resolveModelEntries({
    cfg,
    capability,
    config,
    providerRegistry: buildProviderRegistry(undefined, cfg),
  }).map(({ entry }) => entry);
  // Auto-detected provider and CLI entries inherit the capability limit.
  const candidates = entries.length > 0 ? entries : [{}];
  return {
    enabled: true,
    maxBytes: Math.max(
      ...candidates.map((entry) => resolveMaxBytes({ cfg, capability, config, entry })),
    ),
  };
}

export async function transcribeAudioFile(
  params: TranscribeAudioFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  return runFile(
    { ...params, capability: "audio" },
    {
      prompt: params.prompt?.trim() || params.prompt || undefined,
      language: params.language || undefined,
    },
  );
}
