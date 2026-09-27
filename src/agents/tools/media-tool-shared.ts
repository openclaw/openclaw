import path from "node:path";
import { safeFileURLToPath } from "@openclaw/fs-safe/advanced";
import { normalizeInboundPathRoots } from "@openclaw/media-core/inbound-path-policy";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  findCapabilityProviderById,
  resolveCapabilityModelRefForProviders,
  type CapabilityModelRef,
} from "../../../packages/media-generation-core/src/capability-model-ref.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { resolveChannelInboundAttachmentRootsForChannel } from "../../media/channel-inbound-roots.js";
import { getDefaultLocalRootsCore } from "../../media/local-media-access.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
} from "../../media/media-reference.js";
import type { WebMediaResult } from "../../media/web-media.js";
import {
  listAvailableManifestContractValues,
  loadManifestContractSnapshot,
} from "../../plugins/manifest-contract-eligibility.js";
import { resolveUserPath } from "../../utils.js";
import { buildTimeoutAbortSignal } from "../../utils/fetch-timeout.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
  type SandboxedBridgeMediaPathConfig,
} from "../sandbox-media-paths.js";
import type { ToolFsPolicy } from "../tool-fs-policy.js";
import { normalizeWorkspaceDir } from "../workspace-dir.js";
import {
  ToolInputError,
  readPositiveIntegerParam,
  readStringArrayParam,
  readToolStringParam,
} from "./common.js";
import type { decodeDataUrl } from "./image-tool.helpers.js";
import {
  getCurrentCapabilityMetadataSnapshot,
  hasSnapshotCapabilityAvailability,
} from "./manifest-capability-availability.js";
import {
  buildToolModelConfigFromCandidates,
  coerceToolModelConfig,
  hasProviderAuthForTool,
  hasToolModelConfig,
  resolveDefaultModelRef,
  type ToolModelConfig,
} from "./model-config.helpers.js";

type TextToolAttempt = {
  provider: string;
  model: string;
  error: string;
};

type TextToolResult = {
  text: string;
  provider: string;
  model: string;
  attempts: TextToolAttempt[];
};

type ParseGenerationModelRef = (raw: string | undefined) => CapabilityModelRef | null;

type TaskRunDetailHandle = {
  taskId: string;
  runId: string;
};

export const REMOTE_MEDIA_READ_IDLE_TIMEOUT_MS = 120_000;

export function readGenerationTimeoutMs(args: Record<string, unknown>): number | undefined {
  return readPositiveIntegerParam(args, "timeoutMs", {
    message: "timeoutMs must be a positive integer in milliseconds.",
  });
}

type CapabilityProvider = {
  id: string;
  aliases?: string[];
  defaultModel?: string;
  models?: readonly string[];
  isConfigured?: (ctx: { cfg?: OpenClawConfig; agentDir?: string }) => boolean;
};

type CapabilityProviderSource = CapabilityProvider[] | (() => CapabilityProvider[]);

type GenerationCapabilityProviderKey =
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders";

export function isCapabilityProviderConfigured<T extends CapabilityProvider>(params: {
  providers: T[];
  provider?: T;
  providerId?: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): boolean {
  const provider =
    params.provider ??
    findCapabilityProviderById({
      providers: params.providers,
      providerId: params.providerId,
      normalizeProviderId,
    });
  if (!provider) {
    return params.providerId
      ? hasProviderAuthForTool({
          provider: params.providerId,
          cfg: params.cfg,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          authStore: params.authStore,
        })
      : false;
  }
  if (provider.isConfigured) {
    return provider.isConfigured({
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
  }
  return hasProviderAuthForTool({
    provider: provider.id,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    authStore: params.authStore,
  });
}

export function createCapabilityProviderRuntimeDeps<T extends CapabilityProvider>(
  providers: readonly T[] | undefined,
) {
  const prepared = providers ? [...providers] : undefined;
  return prepared
    ? {
        getProvider: (providerId?: string) =>
          findCapabilityProviderById({ providers: prepared, providerId, normalizeProviderId }),
        listProviders: () => prepared,
      }
    : undefined;
}

export function resolveSelectedCapabilityProvider<T extends CapabilityProvider>(params: {
  providers: T[];
  modelConfig: ToolModelConfig;
  modelOverride?: string;
  parseModelRef: ParseGenerationModelRef;
}): T | undefined {
  const selectedRef =
    resolveCapabilityModelRefForProviders({
      providers: params.providers,
      raw: params.modelOverride,
      parseModelRef: params.parseModelRef,
      normalizeProviderId,
    }) ??
    resolveCapabilityModelRefForProviders({
      providers: params.providers,
      raw: params.modelConfig.primary,
      parseModelRef: params.parseModelRef,
      normalizeProviderId,
    });
  if (!selectedRef) {
    return undefined;
  }
  return findCapabilityProviderById({
    providers: params.providers,
    providerId: selectedRef.provider,
    normalizeProviderId,
  });
}

function resolveCapabilityModelCandidatesForTool(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  providers: CapabilityProvider[];
}): string[] {
  const providerDefaults = new Map<string, { ref: string; aliases: string[] }>();
  for (const provider of params.providers) {
    const providerId = provider.id.trim();
    const modelId = provider.defaultModel?.trim();
    if (
      !providerId ||
      !modelId ||
      providerDefaults.has(providerId) ||
      !isCapabilityProviderConfigured({
        providers: params.providers,
        provider,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        authStore: params.authStore,
      })
    ) {
      continue;
    }
    const aliases = (provider.aliases ?? []).flatMap((alias) => {
      const normalized = normalizeProviderId(alias);
      return normalized ? [normalized] : [];
    });
    providerDefaults.set(providerId, { ref: `${providerId}/${modelId}`, aliases });
  }

  const primaryProvider = resolveDefaultModelRef(params.cfg).provider;
  const normalizedPrimaryProvider = normalizeProviderId(primaryProvider);
  const providerIds = [...providerDefaults.keys()].toSorted();
  const matchesPrimaryProvider = (providerId: string): boolean => {
    const entry = providerDefaults.get(providerId);
    return (
      normalizeProviderId(providerId) === normalizedPrimaryProvider ||
      (entry?.aliases ?? []).includes(normalizedPrimaryProvider)
    );
  };
  const orderedProviders = [
    ...providerIds.filter(matchesPrimaryProvider),
    ...providerIds.filter((providerId) => !matchesPrimaryProvider(providerId)),
  ];
  const orderedRefs: string[] = [];
  const seen = new Set<string>();
  for (const providerId of orderedProviders) {
    const entry = providerDefaults.get(providerId);
    if (!entry || seen.has(entry.ref)) {
      continue;
    }
    seen.add(entry.ref);
    orderedRefs.push(entry.ref);
  }
  return orderedRefs;
}

/**
 * Builds the model config for a generation tool from explicit config first, then configured
 * provider defaults ordered around the agent's primary provider.
 */
export function resolveCapabilityModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelConfig?: AgentModelConfig;
  modelOverride?: string;
  providers: CapabilityProviderSource;
}): ToolModelConfig | null {
  const configured = coerceToolModelConfig(params.modelConfig);
  const modelOverride = normalizeOptionalString(params.modelOverride);
  const explicit = modelOverride ? { ...configured, primary: modelOverride } : configured;
  if (hasToolModelConfig(explicit)) {
    return explicit;
  }
  const providers = typeof params.providers === "function" ? params.providers() : params.providers;
  return buildToolModelConfigFromCandidates({
    explicit,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    authStore: params.authStore,
    candidates: resolveCapabilityModelCandidatesForTool({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      authStore: params.authStore,
      providers,
    }),
    isProviderConfigured: (providerId) =>
      isCapabilityProviderConfigured({
        providers,
        providerId,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        authStore: params.authStore,
      }),
  });
}

export function hasExplicitMediaModel(modelConfig?: AgentModelConfig): boolean {
  return hasToolModelConfig(coerceToolModelConfig(modelConfig));
}

export function hasGenerationToolAvailability(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  modelConfig?: AgentModelConfig;
  providers?: CapabilityProvider[] | (() => CapabilityProvider[]);
  providerKey: GenerationCapabilityProviderKey;
}): boolean {
  if (params.cfg?.plugins?.enabled === false) {
    return false;
  }
  if (hasToolModelConfig(coerceToolModelConfig(params.modelConfig))) {
    return true;
  }
  const providers = typeof params.providers === "function" ? params.providers() : params.providers;
  if (providers) {
    return providers.some((provider) =>
      isCapabilityProviderConfigured({
        providers,
        provider,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        authStore: params.authStore,
      }),
    );
  }
  const snapshot =
    getCurrentCapabilityMetadataSnapshot({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
    }) ??
    loadManifestContractSnapshot({
      config: params.cfg,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    });
  if (
    hasSnapshotCapabilityAvailability({
      snapshot,
      key: params.providerKey,
      config: params.cfg,
      authStore: params.authStore,
    })
  ) {
    return true;
  }
  return listAvailableManifestContractValues({
    snapshot,
    contract: params.providerKey,
    config: params.cfg,
  }).some((providerId) =>
    hasProviderAuthForTool({
      provider: providerId,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      authStore: params.authStore,
    }),
  );
}

export function resolveGenerateAction(
  args: Record<string, unknown>,
): "generate" | "status" | "list" {
  const action = normalizeOptionalLowercaseString(readToolStringParam(args, "action"));
  switch (action) {
    case undefined:
    case "generate":
      return "generate";
    case "status":
      return "status";
    case "list":
      return "list";
    default:
      throw new ToolInputError('action must be "generate", "status", or "list"');
  }
}

/**
 * Normalizes singular/plural media references, preserving positions when requested.
 */
export function normalizeMediaReferenceInputs(params: {
  args: Record<string, unknown>;
  singularKey: string;
  pluralKey: string;
  maxCount: number;
  label: string;
  dedupe?: boolean;
}): string[] {
  const single = readToolStringParam(params.args, params.singularKey);
  const multiple = readStringArrayParam(params.args, params.pluralKey);
  const deduped = normalizeMediaReferenceList(
    [...(single ? [single] : []), ...(multiple ?? [])],
    params.dedupe,
  );
  if (deduped.length > params.maxCount) {
    throw new ToolInputError(
      `Too many ${params.label}: ${deduped.length} provided, maximum is ${params.maxCount}.`,
    );
  }
  return deduped;
}

// Keep the first spelling, but treat optional @ prefixes as the same reference.
export function normalizeMediaReferenceList(candidates: string[], dedupe = true): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const key = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
    if (!key || (dedupe && seen.has(key))) {
      continue;
    }
    seen.add(key);
    deduped.push(trimmed);
  }
  return deduped;
}

export function buildMediaReferenceDetails<T extends { rewrittenFrom?: string }>(params: {
  entries: readonly T[];
  singleKey: string;
  pluralKey: string;
  getResolvedInput: (entry: T) => string | undefined;
  singleRewriteKey?: string;
}): Record<string, unknown> {
  if (params.entries.length === 1) {
    const entry = params.entries[0];
    if (!entry) {
      return {};
    }
    const rewriteKey = params.singleRewriteKey ?? "rewrittenFrom";
    return {
      [params.singleKey]: params.getResolvedInput(entry),
      ...(entry.rewrittenFrom ? { [rewriteKey]: entry.rewrittenFrom } : {}),
    };
  }
  if (params.entries.length > 1) {
    return {
      [params.pluralKey]: params.entries.map((entry) => ({
        [params.singleKey]: params.getResolvedInput(entry),
        ...(entry.rewrittenFrom ? { rewrittenFrom: entry.rewrittenFrom } : {}),
      })),
    };
  }
  return {};
}

export function buildTaskRunDetails(
  handle: TaskRunDetailHandle | null | undefined,
): Record<string, unknown> {
  return handle
    ? {
        task: {
          taskId: handle.taskId,
          runId: handle.runId,
        },
      }
    : {};
}

export async function resolveMediaToolReferenceAccess(params: {
  input: string;
  isDataUrl: boolean;
  workspaceDir?: string;
  cwd?: string;
  fsPolicy?: ToolFsPolicy;
  sandbox?: SandboxedBridgeMediaPathConfig | null;
}): Promise<{ resolvedPath: string | null; localRoots: string[]; rewrittenFrom?: string }> {
  const root = normalizeWorkspaceDir(
    params.sandbox?.root ?? params.fsPolicy?.root ?? params.cwd ?? params.workspaceDir,
  );
  const cwd = normalizeWorkspaceDir(params.cwd) ?? root;
  const workspaceRoots = root ? [root] : [];
  const workspaceOnly = params.fsPolicy?.workspaceOnly ?? params.sandbox?.workspaceOnly === true;
  const reference = classifyMediaReferenceSource(params.input);
  const resolveHostPath = () => {
    if (reference.isFileUrl) {
      return safeFileURLToPath(params.input);
    }
    if (reference.isHttpUrl || reference.isMediaStoreUrl || reference.looksLikeWindowsDrivePath) {
      return params.input;
    }
    if (params.input.startsWith("~")) {
      return resolveUserPath(params.input);
    }
    return cwd ? path.resolve(cwd, params.input) : params.input;
  };
  const pathInfo: { resolved: string; rewrittenFrom?: string } = params.isDataUrl
    ? { resolved: "" }
    : params.sandbox
      ? await resolveSandboxedBridgeMediaPath({
          sandbox: params.sandbox,
          mediaPath: params.input,
          inboundFallbackDir: "media/inbound",
        })
      : { resolved: resolveHostPath() };
  return {
    resolvedPath: params.isDataUrl ? null : pathInfo.resolved,
    localRoots: uniqueStrings([
      ...(workspaceOnly ? workspaceRoots : [...getDefaultLocalRootsCore(), ...workspaceRoots]),
      ...(params.fsPolicy?.readOnlyRoots ?? []),
    ]),
    ...(pathInfo.rewrittenFrom ? { rewrittenFrom: pathInfo.rewrittenFrom } : {}),
  };
}

type LoadedToolReferenceMedia = WebMediaResult | ReturnType<typeof decodeDataUrl>;

export type LoadedMediaToolReference<T> = {
  source: T;
  resolvedInput: string;
  rewrittenFrom?: string;
};

export type MediaToolSandbox = Pick<
  SandboxedBridgeMediaPathConfig,
  "root" | "bridge" | "stagedMediaPaths" | "readOnlyResourceMounts"
>;

export function resolveMediaToolSandboxConfig(
  sandbox: MediaToolSandbox | null | undefined,
  workspaceOnly: boolean | undefined,
): SandboxedBridgeMediaPathConfig | null {
  if (!sandbox) {
    return null;
  }
  const root = sandbox.root.trim();
  return root ? { ...sandbox, root, workspaceOnly: workspaceOnly === true } : null;
}

/** Loads generation references while retaining each tool's distinct transport and sandbox policy. */
export async function loadMediaToolReferences<T>(params: {
  inputs: string[];
  toolName: "image_generate" | "video_generate" | "music_generate";
  expectedKind: "image" | "video" | "audio";
  sandbox: SandboxedBridgeMediaPathConfig | null;
  workspaceDir?: string;
  cwd?: string;
  fsPolicy?: ToolFsPolicy;
  maxBytes: number;
  ssrfPolicy?: SsrFPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
  mapMedia: (media: LoadedToolReferenceMedia) => T;
  mapRemote?: (url: string) => T;
}): Promise<LoadedMediaToolReference<T>[]> {
  const loaded: LoadedMediaToolReference<T>[] = [];
  for (const rawInput of params.inputs) {
    params.signal?.throwIfAborted();
    const input = normalizeMediaReferenceSource(rawInput.trim().replace(/^@\s*/, ""));
    if (!input) {
      throw new ToolInputError(`${params.expectedKind} required (empty string in array)`);
    }
    const reference = classifyMediaReferenceSource(input);
    if (reference.hasUnsupportedScheme) {
      throw new ToolInputError(
        `Unsupported ${params.expectedKind} reference: ${rawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
      );
    }
    if (params.sandbox && reference.isHttpUrl) {
      const label = params.toolName === "image_generate" ? "" : `${params.expectedKind} `;
      throw new ToolInputError(`Sandboxed ${params.toolName} does not allow remote ${label}URLs.`);
    }
    const resolvedInput = !params.sandbox && input.startsWith("~") ? resolveUserPath(input) : input;
    if (reference.isHttpUrl && params.mapRemote) {
      loaded.push({ source: params.mapRemote(resolvedInput), resolvedInput });
      continue;
    }
    const { resolvedPath, localRoots, rewrittenFrom } = await resolveMediaToolReferenceAccess({
      input: resolvedInput,
      isDataUrl: reference.isDataUrl,
      workspaceDir: params.workspaceDir,
      cwd: params.cwd,
      fsPolicy: params.fsPolicy,
      sandbox: params.sandbox,
    });
    params.signal?.throwIfAborted();
    if (reference.isDataUrl && params.expectedKind !== "image") {
      throw new ToolInputError(
        `${params.expectedKind} data: URLs are not supported for ${params.toolName}.`,
      );
    }
    let media: LoadedToolReferenceMedia;
    if (reference.isDataUrl) {
      const { decodeDataUrl } = await import("./image-tool.helpers.js");
      params.signal?.throwIfAborted();
      media = decodeDataUrl(resolvedInput, { maxBytes: params.maxBytes });
    } else {
      const { loadWebMedia } = await import("../../media/web-media.js");
      params.signal?.throwIfAborted();
      const timeout =
        params.toolName === "music_generate" && !params.sandbox
          ? buildTimeoutAbortSignal({
              timeoutMs: params.timeoutMs ?? 30_000,
              operation: "music-generate.reference-fetch",
              ...(params.signal ? { signal: params.signal } : {}),
              ...(reference.isHttpUrl ? { url: resolvedPath ?? resolvedInput } : {}),
            })
          : undefined;
      try {
        media = await loadWebMedia(resolvedPath ?? resolvedInput, {
          maxBytes: params.maxBytes,
          ...(params.sandbox
            ? {
                sandboxValidated: true,
                readFile: createSandboxBridgeReadFile({ sandbox: params.sandbox }),
              }
            : { localRoots, ssrfPolicy: params.ssrfPolicy }),
          ...(params.toolName === "image_generate" && reference.isHttpUrl
            ? { readIdleTimeoutMs: REMOTE_MEDIA_READ_IDLE_TIMEOUT_MS }
            : {}),
          ...(timeout?.signal || params.signal
            ? { requestInit: { signal: timeout?.signal ?? params.signal } }
            : {}),
        });
      } finally {
        timeout?.cleanup();
      }
    }
    params.signal?.throwIfAborted();
    if (media.kind !== params.expectedKind) {
      const kind = params.toolName === "image_generate" ? media.kind : (media.kind ?? "unknown");
      throw new ToolInputError(`Unsupported media type: ${kind}`);
    }
    const loadedReference = { source: params.mapMedia(media), resolvedInput };
    loaded.push(rewrittenFrom ? { ...loadedReference, rewrittenFrom } : loadedReference);
  }
  return loaded;
}

/**
 * Resolves channel-scoped inbound attachment roots separately from host-local roots.
 */
export function resolveMediaToolInboundRoots(options?: {
  workspaceOnly?: boolean;
  cfg?: OpenClawConfig;
  channelId?: string | null;
  accountId?: string | null;
}): string[] {
  if (options?.workspaceOnly || !options?.cfg || !options.channelId) {
    return [];
  }
  return normalizeInboundPathRoots(
    resolveChannelInboundAttachmentRootsForChannel({
      cfg: options.cfg,
      channelId: options.channelId,
      accountId: options.accountId,
    }),
  );
}

export function resolvePromptAndModelOverride(
  args: Record<string, unknown>,
  defaultPrompt: string,
): {
  prompt: string;
  modelOverride?: string;
} {
  const prompt = normalizeOptionalString(args.prompt) ?? defaultPrompt;
  const modelOverride = normalizeOptionalString(args.model);
  return { prompt, modelOverride };
}

export function buildTextToolResult(
  result: TextToolResult,
  extraDetails: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: result.text }],
    details: {
      model: `${result.provider}/${result.model}`,
      ...extraDetails,
      // Code Mode and Tool Search read details instead of rendered content.
      text: result.text,
      attempts: result.attempts,
    },
  };
}
