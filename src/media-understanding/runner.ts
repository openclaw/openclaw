// Media-understanding runner resolves providers/models, local roots, auth, and
// per-capability execution decisions for message attachments.
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { ok } from "@openclaw/normalization-core/result";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { ActiveMediaModel } from "../../packages/media-understanding-common/src/active-model.js";
import { isMediaUnderstandingSkipError } from "../../packages/media-understanding-common/src/errors.js";
import {
  normalizeMediaExecutionProviderId,
  normalizeMediaProviderId,
} from "../../packages/media-understanding-common/src/provider-id.js";
import { providerSupportsCapability } from "../../packages/media-understanding-common/src/provider-supports.js";
import { isMinimaxVlmModel, isMinimaxVlmProvider } from "../agents/minimax-vlm.js";
import { isProviderAuthError } from "../agents/model-auth-runtime-shared.js";
import {
  buildModelAliasIndex,
  inferUniqueProviderFromConfiguredModels,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import type { MsgContext } from "../auto-reply/templating.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.js";
import type {
  MediaUnderstandingConfig,
  MediaUnderstandingModelConfig,
} from "../config/types.tools.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { logWarn } from "../logger.js";
import { classifyMediaReferenceSource } from "../media/media-reference.js";
import { createLazyRuntimeModule, createLazyRuntimeNamedExport } from "../shared/lazy-runtime.js";
import { MediaAttachmentCache, selectAttachments } from "./attachments.js";
import {
  matchesMediaEntryCapability,
  resolveConfiguredMediaEntryCapabilities,
} from "./entry-capabilities.js";
import { inspectLocalAudioSelection } from "./local-audio.js";
import { resolveOpenAiAudioAuthModelApi } from "./openai-audio-api.js";
import {
  resolveAutoMediaKeyProvidersFromRegistry,
  resolveDefaultMediaModelFromRegistry,
} from "./provider-registry-metadata.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "./provider-registry.js";
import {
  resolveModelEntries,
  resolveScopeDecision,
  type ResolvedMediaModelEntry,
} from "./resolve.js";
import {
  buildModelDecision,
  formatDecisionSummary,
  runCliEntry,
  runProviderEntry,
  type MediaRequestOverrides,
} from "./runner.entries.js";
import type {
  MediaAttachment,
  MediaAttachmentDisposition,
  MediaAttachmentProcessing,
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingModelDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";

export {
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  resolveMediaAttachmentLocalRoots,
} from "./runner.attachments.js";
export { buildMediaUnderstandingRegistry as buildProviderRegistry } from "./provider-registry.js";

type ProviderRegistry = Map<string, MediaUnderstandingProvider>;
type AutoModelSelectionParams = Parameters<typeof resolveAutoImageModel>[0] & {
  providerRegistry: ProviderRegistry;
  capability: MediaUnderstandingCapability;
};
/**
 * A provider registry, or a memoized factory that builds one on first use.
 * `runCapability` receives the factory form so a turn that never needs the
 * registry (the native-vision fast path) never pays to build it.
 */
type LazyProviderRegistry = ProviderRegistry | (() => ProviderRegistry);

function resolveProviderRegistry(registry: LazyProviderRegistry): ProviderRegistry {
  return typeof registry === "function" ? registry() : registry;
}
type ModelCatalogApi = typeof import("../agents/model-catalog.js") &
  typeof import("../agents/prepared-model-catalog.js");
type ModelCatalog = Awaited<ReturnType<ModelCatalogApi["readPreparedModelCatalog"]>>;

type RunCapabilityResult = {
  outputs: MediaUnderstandingOutput[];
  decision: MediaUnderstandingDecision;
};

const loadHasAvailableAuthForProvider = createLazyRuntimeNamedExport(
  () => import("../agents/model-auth.js"),
  "hasAvailableAuthForProvider",
);

const loadPreparedModelCatalogApi = createLazyRuntimeModule(async () => ({
  ...(await import("../agents/model-catalog.js")),
  ...(await import("../agents/prepared-model-catalog.js")),
}));

async function hasProviderAuthAvailable(params: {
  capability: MediaUnderstandingCapability;
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<boolean> {
  // Literal config keys are cheap to detect; defer loading model-auth until
  // profile/env discovery is actually needed.
  if (
    normalizeNullableString(
      findNormalizedProviderValue(params.cfg?.models?.providers, params.provider)?.apiKey,
    )
  ) {
    return true;
  }
  const hasAvailableAuthForProvider = await loadHasAvailableAuthForProvider();
  return await hasAvailableAuthForProvider({
    ...params,
    modelApi: resolveOpenAiAudioAuthModelApi({
      capability: params.capability,
      providerId: params.provider,
    }),
  });
}

function resolveConfiguredKeyProviderOrder(params: {
  cfg: OpenClawConfig;
  providerRegistry: ProviderRegistry;
  capability: MediaUnderstandingCapability;
  fallbackProviders: readonly string[];
}): string[] {
  const configuredProviders = Object.keys(params.cfg.models?.providers ?? {})
    .map((providerId) => normalizeMediaExecutionProviderId(providerId))
    .filter(Boolean);
  const supportedProviders = uniqueStrings(configuredProviders).filter((providerId) =>
    providerSupportsCapability(
      params.providerRegistry.get(normalizeMediaProviderId(providerId)),
      params.capability,
    ),
  );
  return uniqueStrings([...supportedProviders, ...params.fallbackProviders]);
}

function resolveConfiguredImageModelId(params: {
  cfg: OpenClawConfig;
  providerId: string;
}): string | undefined {
  const providerCfg = findNormalizedProviderValue(params.cfg.models?.providers, params.providerId);
  return providerCfg?.models
    ?.find((entry) => entry?.id?.trim() && entry.input?.includes("image"))
    ?.id.trim();
}

function resolveCatalogImageModelId(params: {
  providerId: string;
  catalog: ModelCatalog;
  modelSupportsVision: ModelCatalogApi["modelSupportsVision"];
}): string | undefined {
  const matches = params.catalog.filter(
    (entry) =>
      normalizeMediaProviderId(entry.provider) === normalizeMediaProviderId(params.providerId) &&
      params.modelSupportsVision(entry),
  );
  if (matches.length === 0) {
    return undefined;
  }
  const autoEntry = matches.find((entry) => normalizeLowercaseStringOrEmpty(entry.id) === "auto");
  return normalizeOptionalString((autoEntry ?? matches[0])?.id);
}

async function explicitImageModelVisionStatus(
  params: Pick<AutoModelSelectionParams, "cfg" | "agentId" | "agentDir" | "workspaceDir"> & {
    providerId: string;
    model: string;
  },
): Promise<"supported" | "unsupported" | "unknown"> {
  // Explicit model overrides should survive unknown catalog state, but known
  // text-only models must not be routed into image understanding.
  if (
    isMinimaxVlmProvider(params.providerId) &&
    !isMinimaxVlmModel(params.providerId, params.model)
  ) {
    return "unsupported";
  }
  if (resolveConfiguredImageModelId(params) === params.model) {
    return "supported";
  }
  const { findModelInCatalog, readPreparedModelCatalog, modelSupportsVision } =
    await loadPreparedModelCatalogApi();
  const catalog = await readPreparedModelCatalog({
    config: params.cfg,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  const entry = findModelInCatalog(catalog, params.providerId, params.model);
  if (!entry) {
    return "unknown";
  }
  return modelSupportsVision(entry) ? "supported" : "unsupported";
}

async function resolveAutoImageModelId(
  params: Omit<AutoModelSelectionParams, "capability" | "activeModel"> & {
    providerId: string;
    explicitModel?: string;
  },
): Promise<string | undefined> {
  const explicit = normalizeOptionalString(params.explicitModel);
  if (explicit) {
    const explicitStatus = await explicitImageModelVisionStatus({
      cfg: params.cfg,
      agentId: params.agentId,
      providerId: params.providerId,
      model: explicit,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    });
    if (explicitStatus !== "unsupported") {
      return explicit;
    }
  }
  if (isMinimaxVlmProvider(params.providerId)) {
    return "MiniMax-VL-01";
  }
  const configuredModel = resolveConfiguredImageModelId(params);
  if (configuredModel) {
    return configuredModel;
  }
  const defaultModel = resolveDefaultMediaModelFromRegistry({
    providerId: params.providerId,
    capability: "image",
    providerRegistry: params.providerRegistry,
  });
  if (defaultModel) {
    return defaultModel;
  }
  const { resolveDefaultMediaModel } = await import("./defaults.js");
  const bundledDefaultModel = resolveDefaultMediaModel({
    cfg: params.cfg,
    providerId: params.providerId,
    capability: "image",
    workspaceDir: params.workspaceDir,
  });
  if (bundledDefaultModel) {
    return bundledDefaultModel;
  }
  const { readPreparedModelCatalog, modelSupportsVision } = await loadPreparedModelCatalogApi();
  const catalog = await readPreparedModelCatalog({
    config: params.cfg,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  return resolveCatalogImageModelId({
    providerId: params.providerId,
    catalog,
    modelSupportsVision,
  });
}

async function resolveKeyEntry(
  params: AutoModelSelectionParams,
): Promise<MediaUnderstandingModelConfig | null> {
  const { cfg, providerRegistry, capability } = params;
  const activeProvider = params.activeModel?.provider?.trim();
  if (activeProvider) {
    const model = params.activeModel?.model;
    const activeEntry = await resolveAutoProviderModelEntry(params, activeProvider, () => model);
    if (activeEntry) {
      return activeEntry;
    }
  }
  for (const providerId of resolveConfiguredKeyProviderOrder({
    cfg,
    providerRegistry,
    capability,
    fallbackProviders: resolveAutoMediaKeyProvidersFromRegistry({
      capability,
      providerRegistry,
    }),
  })) {
    const entry = await resolveAutoProviderModelEntry(params, providerId, () => undefined);
    if (entry) {
      return entry;
    }
  }
  return null;
}

function resolveImageModelFromAgentDefaults(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): MediaUnderstandingModelConfig[] {
  const refs = [
    resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.imageModel),
    ...resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.imageModel),
  ]
    .map((ref) => ref?.trim())
    .filter((ref): ref is string => Boolean(ref));
  if (refs.length === 0) {
    return [];
  }
  const defaultProvider = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  }).provider;
  const entries: MediaUnderstandingModelConfig[] = [];
  for (const ref of refs) {
    const effectiveDefaultProvider = ref.includes("/")
      ? defaultProvider
      : (inferUniqueProviderFromConfiguredModels({
          cfg: params.cfg,
          model: ref,
          agentId: params.agentId,
        }) ?? defaultProvider);
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: effectiveDefaultProvider,
      agentId: params.agentId,
    });
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      agentId: params.agentId,
      raw: ref,
      defaultProvider: effectiveDefaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      continue;
    }
    entries.push({
      type: "provider",
      provider: resolved.ref.provider,
      model: resolved.ref.model,
    });
  }
  return entries;
}

function hasExplicitImageUnderstandingConfig(params: {
  cfg: OpenClawConfig;
  providerRegistry: LazyProviderRegistry;
}): boolean {
  return (params.cfg.tools?.media?.models ?? []).some((entry) => {
    const configured = resolveConfiguredMediaEntryCapabilities(entry);
    if (configured) {
      return configured.includes("image");
    }
    return matchesMediaEntryCapability({
      entry,
      capability: "image",
      providerRegistry: resolveProviderRegistry(params.providerRegistry),
    });
  });
}

async function activeModelSupportsNativeVision(
  params: Omit<AutoModelSelectionParams, "capability" | "providerRegistry">,
): Promise<boolean> {
  const activeProvider = params.activeModel?.provider?.trim();
  if (!activeProvider) {
    return false;
  }
  if (
    isMinimaxVlmProvider(activeProvider) &&
    // M2.x catalog rows may advertise images but require the separate VLM path.
    !/^MiniMax-M3(\b|[-.])/i.test(params.activeModel?.model?.trim() ?? "")
  ) {
    return false;
  }
  const { findModelInCatalog, readPreparedModelCatalog, modelSupportsVision } =
    await loadPreparedModelCatalogApi();
  const catalog = await readPreparedModelCatalog({
    config: params.cfg,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  const entry = findModelInCatalog(catalog, activeProvider, params.activeModel?.model ?? "");
  return modelSupportsVision(entry);
}

async function* resolveAutoAudioEntries(
  params: AutoModelSelectionParams,
): AsyncGenerator<ResolvedMediaModelEntry> {
  const activeProvider = normalizeMediaExecutionProviderId(
    params.activeModel?.provider?.trim() ?? "",
  );
  const providers = uniqueStrings([
    ...(activeProvider ? [activeProvider] : []),
    ...resolveConfiguredKeyProviderOrder({
      ...params,
      fallbackProviders: resolveAutoMediaKeyProvidersFromRegistry(params),
    }),
  ]);
  // Advance lazily: unused providers must not refresh credentials, and an upload
  // failure must not silently disclose the same recording to another provider.
  for (const providerId of providers) {
    const entry = await resolveAutoProviderModelEntry(params, providerId, () => undefined);
    if (entry) {
      yield { entry };
    }
  }
  const localAudio = await inspectLocalAudioSelection();
  for (const entry of localAudio.entries) {
    yield { entry };
  }
}

async function resolveAutoEntries(
  params: Omit<AutoModelSelectionParams, "providerRegistry"> & {
    providerRegistry?: ProviderRegistry;
    nativeVisionActive: boolean;
  },
): Promise<ResolvedMediaModelEntry[]> {
  if (params.capability === "image" && !params.nativeVisionActive) {
    const imageModelEntries = resolveImageModelFromAgentDefaults(params);
    if (imageModelEntries.length > 0) {
      return imageModelEntries.map((entry) => ({ entry }));
    }
  }
  const prepared = {
    ...params,
    providerRegistry:
      params.providerRegistry ?? buildMediaUnderstandingRegistry(undefined, params.cfg),
  };
  const activeProvider = normalizeMediaExecutionProviderId(prepared.activeModel?.provider ?? "");
  if (activeProvider) {
    const activeEntry = await resolveAutoProviderModelEntry(
      prepared,
      activeProvider,
      () => prepared.activeModel?.model,
    );
    if (activeEntry) {
      return [{ entry: activeEntry }];
    }
  }
  const keys = await resolveKeyEntry(prepared);
  if (keys) {
    return [{ entry: keys }];
  }
  return [];
}

export async function resolveAutoImageModel(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  activeModel?: ActiveMediaModel;
}): Promise<ActiveMediaModel | null> {
  const entries = await resolveAutoEntries({
    ...params,
    capability: "image",
    nativeVisionActive: false,
  });
  for (const { entry } of entries) {
    if (entry.type === "cli") {
      continue;
    }
    const provider = entry.provider;
    const model = entry.model?.trim();
    if (provider && model) {
      return { provider, model };
    }
  }
  return null;
}

async function resolveAutoProviderModelEntry(
  params: AutoModelSelectionParams,
  providerId: string,
  readModel: () => string | undefined,
): Promise<MediaUnderstandingModelConfig | null> {
  const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
  if (!providerSupportsCapability(provider, params.capability)) {
    return null;
  }
  if (
    !(params.capability === "audio" && provider?.transcribeAudioWithContext) &&
    !(await hasProviderAuthAvailable({
      ...params,
      provider: providerId,
    }))
  ) {
    return null;
  }
  // Active selection reads its model after auth; key selection captures it before auth.
  // Audio uses its provider default instead of the active chat model in either path.
  let model: string | undefined;
  if (params.capability === "image") {
    model = await resolveAutoImageModelId({
      ...params,
      providerId,
      explicitModel: readModel(),
    });
  } else if (params.capability === "audio") {
    model = resolveDefaultMediaModelFromRegistry({
      ...params,
      providerId,
    });
  } else {
    model =
      readModel() ??
      resolveDefaultMediaModelFromRegistry({
        ...params,
        providerId,
      });
  }
  if (params.capability === "image" && !model) {
    return null;
  }
  return {
    type: "provider",
    provider: providerId,
    model,
  };
}

async function runAttachmentEntries(
  params: Omit<
    Parameters<typeof runProviderEntry>[0],
    "entry" | "attachmentIndex" | "secretOwnerId"
  > & {
    ctx: MsgContext;
    attachment: MediaAttachment;
    entries: Iterable<ResolvedMediaModelEntry> | AsyncIterable<ResolvedMediaModelEntry>;
    automaticAudio: boolean;
  },
): Promise<{
  output: MediaUnderstandingOutput | null;
  attempts: MediaUnderstandingModelDecision[];
  processing: MediaAttachmentProcessing;
}> {
  const { entries, capability } = params;
  const attachmentIndex = params.attachment.index;
  const attempts: MediaUnderstandingModelDecision[] = [];
  let processing: MediaAttachmentProcessing = "omitted";
  for await (const candidate of entries) {
    const { entry } = candidate;
    const entryType = entry.type ?? (entry.command ? "cli" : "provider");
    try {
      const attempt =
        entryType === "cli"
          ? ok(await runCliEntry({ ...params, entry }))
          : await runProviderEntry({
              ...params,
              entry,
              attachmentIndex,
              secretOwnerId: candidate.secretOwnerId,
            });
      if (!attempt.ok) {
        if (
          !(params.automaticAudio && isProviderAuthError(attempt.error, "missing-provider-auth"))
        ) {
          attempts.push(
            buildModelDecision({
              entry,
              entryType,
              outcome: "failed",
              reason: String(attempt.error),
            }),
          );
        }
        continue;
      }
      const result = attempt.value;
      // Successful empty CLI/API output was processed; unavailable auth was not.
      processing = "completed";
      if (result?.text) {
        const decision = buildModelDecision({ entry, entryType, outcome: "success" });
        if (result.provider) {
          decision.provider = result.provider;
        }
        decision.model = result.model;
        if (result.requestedBackend) {
          decision.requestedBackend = result.requestedBackend;
        }
        if (result.observedBackend) {
          decision.observedBackend = result.observedBackend;
        }
        attempts.push(decision);
        return { output: result, attempts, processing };
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
      } else {
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
    if (params.automaticAudio && entryType === "provider") {
      break;
    }
  }

  return { output: null, attempts, processing };
}

function hasFailedMediaAttempt(attachments: MediaUnderstandingDecision["attachments"]): boolean {
  return attachments.some((attachment) =>
    attachment.attempts.some((attempt) => attempt.outcome === "failed"),
  );
}

function createAttachmentDispositions(
  indexes: readonly number[],
  disposition: MediaAttachmentDisposition,
): Record<number, MediaAttachmentDisposition> {
  return Object.fromEntries(indexes.map((index) => [index, disposition]));
}

export async function runCapability(params: {
  capability: MediaUnderstandingCapability;
  cfg: OpenClawConfig;
  ctx: MsgContext;
  attachments: MediaAttachmentCache;
  media: MediaAttachment[];
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  providerRegistry: LazyProviderRegistry;
  config?: MediaUnderstandingConfig;
  activeModel?: ActiveMediaModel;
  request?: MediaRequestOverrides;
}): Promise<RunCapabilityResult> {
  const { capability, cfg, ctx } = params;
  const config: MediaUnderstandingConfig = params.config ?? cfg.tools?.media?.[capability] ?? {};
  const selection = selectAttachments({
    capability,
    attachments: params.media,
    policy: config.attachments,
  });
  const selectedAttachmentIndexes = selection.selected.map((attachment) => attachment.index);
  const attachmentProcessing: Record<number, MediaAttachmentProcessing> = Object.fromEntries(
    [...selectedAttachmentIndexes, ...selection.droppedAttachmentIndexes].map((index) => [
      index,
      "omitted",
    ]),
  );
  const activeProvider = params.activeModel?.provider?.trim();
  // One memoized owner for the native-vision fact. Probed lazily — only when
  // the skip branch must decide, or an image decision carries a renderable
  // disposition — so explicit image models never pay a catalog lookup. A probe
  // failure yields "unknown" and never alters a decision outcome; unknown
  // suppresses image markers because a false skip claim beside a natively
  // delivered image is worse than silence (#122101).
  let nativeVisionProbe: Promise<boolean | undefined> | undefined;
  const resolveNativeVisionFlag = (): Promise<boolean | undefined> => {
    nativeVisionProbe ??= activeModelSupportsNativeVision(params).catch((err: unknown) => {
      if (shouldLogVerbose()) {
        logVerbose(`native vision support check failed: ${String(err)}`);
      }
      return undefined;
    });
    return nativeVisionProbe;
  };
  const buildDispositions = (
    selectedDisposition: MediaAttachmentDisposition,
    droppedDisposition = selectedDisposition,
  ) => ({
    ...createAttachmentDispositions(selectedAttachmentIndexes, selectedDisposition),
    ...createAttachmentDispositions(selection.droppedAttachmentIndexes, droppedDisposition),
  });
  const rendersMarker = (dispositions: Record<number, MediaAttachmentDisposition>) =>
    Object.values(dispositions).some(
      (d) => d.kind !== "handled" && d.kind !== "handed-to-native-vision",
    );
  const buildDecision = async (
    outcome: MediaUnderstandingDecision["outcome"],
    attachments: MediaUnderstandingDecision["attachments"],
    attachmentDispositions: Record<number, MediaAttachmentDisposition>,
  ): Promise<MediaUnderstandingDecision> => {
    // Record the fact whenever it is known (probe already ran) or needed
    // (a marker could render); never fire the probe for marker-free decisions.
    const nativeVisionActive =
      capability === "image" &&
      (nativeVisionProbe !== undefined || rendersMarker(attachmentDispositions))
        ? await resolveNativeVisionFlag()
        : undefined;
    return {
      capability,
      outcome,
      attachments,
      attachmentDispositions,
      attachmentProcessing,
      ...(nativeVisionActive !== undefined ? { nativeVisionActive } : {}),
    };
  };
  if (config?.enabled === false) {
    return {
      outputs: [],
      decision: await buildDecision(
        "disabled",
        [],
        buildDispositions({ kind: "capability-disabled" }),
      ),
    };
  }

  if (selection.selected.length === 0) {
    return {
      outputs: [],
      decision: await buildDecision("no-attachment", [], {}),
    };
  }

  const scopeDecision = resolveScopeDecision({ scope: config?.scope, ctx });
  if (scopeDecision === "deny") {
    if (shouldLogVerbose()) {
      logVerbose(`${capability} understanding disabled by scope policy.`);
    }
    return {
      outputs: [],
      decision: await buildDecision(
        "scope-deny",
        selection.selected.map((item) => ({
          attachmentIndex: item.index,
          attempts: [],
        })),
        buildDispositions({ kind: "scope-denied" }),
      ),
    };
  }

  // Skip image understanding when the primary model supports vision natively.
  // The image will be injected directly into the model context instead.
  if (
    capability === "image" &&
    activeProvider &&
    !hasExplicitImageUnderstandingConfig({ cfg, providerRegistry: params.providerRegistry }) &&
    (await resolveNativeVisionFlag()) === true
  ) {
    if (shouldLogVerbose()) {
      logVerbose("Skipping image understanding: primary model supports vision natively");
    }
    const attempt = {
      type: "provider" as const,
      provider: activeProvider,
      model: params.activeModel?.model?.trim() || undefined,
      outcome: "skipped" as const,
      reason: "primary model supports vision natively",
    };
    // Native hydration ignores understanding limits but only resolves local paths
    // and media-store refs. Selected and dropped remote URLs both need failure
    // markers; claiming a handoff would silently hide them.
    const nativeDeliverable = (item: MediaAttachment) =>
      Boolean(item.path) ||
      (Boolean(item.url) && classifyMediaReferenceSource(item.url ?? "").isMediaStoreUrl);
    const attachmentDispositions = buildDispositions(
      { kind: "handed-to-native-vision" },
      { kind: "not-selected" },
    );
    for (const item of params.media) {
      if (attachmentDispositions[item.index] && !nativeDeliverable(item)) {
        attachmentDispositions[item.index] = {
          kind: "failed",
          reason: "remote-url image is not natively deliverable",
        };
      }
    }
    return {
      outputs: [],
      decision: await buildDecision(
        "skipped",
        selection.selected.map((item) =>
          nativeDeliverable(item)
            ? { attachmentIndex: item.index, attempts: [attempt], chosen: attempt }
            : { attachmentIndex: item.index, attempts: [] },
        ),
        attachmentDispositions,
      ),
    };
  }

  // Every path past the native-vision skip branch reads the registry: resolve
  // it once here (apply.ts's memoized factory builds it at most once per turn)
  // and reuse the concrete value for every remaining call below.
  const providerRegistry = resolveProviderRegistry(params.providerRegistry);
  const entries = resolveModelEntries({
    cfg,
    capability,
    config,
    providerRegistry,
  });
  const automaticAudio = capability === "audio" && entries.length === 0;
  let resolvedEntries: ResolvedMediaModelEntry[] = entries;
  if (!automaticAudio && resolvedEntries.length === 0) {
    resolvedEntries = await resolveAutoEntries({
      ...params,
      providerRegistry,
      nativeVisionActive: capability === "image" && (await resolveNativeVisionFlag()) === true,
    });
  }
  if (!automaticAudio && resolvedEntries.length === 0) {
    return {
      outputs: [],
      decision: await buildDecision(
        "skipped",
        selection.selected.map((item) => ({
          attachmentIndex: item.index,
          attempts: [],
        })),
        buildDispositions({ kind: "no-model" }, { kind: "not-selected" }),
      ),
    };
  }

  const outputs: MediaUnderstandingOutput[] = [];
  const attachmentDecisions: MediaUnderstandingDecision["attachments"] = [];
  const attachmentDispositions = buildDispositions({ kind: "failed" }, { kind: "not-selected" });
  for (const attachment of selection.selected) {
    const { output, attempts, processing } = await runAttachmentEntries({
      ...params,
      attachment,
      providerRegistry,
      cache: params.attachments,
      entries: automaticAudio
        ? resolveAutoAudioEntries({
            ...params,
            providerRegistry,
          })
        : resolvedEntries,
      automaticAudio,
      config,
    });
    if (output) {
      outputs.push(output);
    }
    attachmentProcessing[attachment.index] = processing;
    attachmentDispositions[attachment.index] = output
      ? { kind: "handled" }
      : attempts.length > 0
        ? { kind: "failed" }
        : { kind: "no-model" };
    attachmentDecisions.push({
      attachmentIndex: attachment.index,
      attempts,
      chosen: attempts.find((attempt) => attempt.outcome === "success"),
    });
  }
  const decision = await buildDecision(
    outputs.length > 0
      ? "success"
      : hasFailedMediaAttempt(attachmentDecisions)
        ? "failed"
        : "skipped",
    attachmentDecisions,
    attachmentDispositions,
  );
  if (decision.outcome === "failed") {
    logWarn(`media-understanding: ${formatDecisionSummary(decision)}`);
  } else if (shouldLogVerbose()) {
    logVerbose(`Media understanding ${formatDecisionSummary(decision)}`);
  }
  return {
    outputs,
    decision,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
