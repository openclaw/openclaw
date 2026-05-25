import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MemorySearchManager } from "../memory-host-sdk/host/types.js";
import { normalizePluginsConfig } from "./config-state.js";
import { resolveMemoryRoleSlot } from "./slot-resolution.js";

export type MemoryPromptSectionBuilder = (params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}) => string[];

export type MemoryCorpusSearchResult = {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  score: number;
  snippet: string;
  id?: string;
  startLine?: number;
  endLine?: number;
  citation?: string;
  source?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
};

export type MemoryCorpusGetResult = {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  content: string;
  fromLine: number;
  lineCount: number;
  id?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
};

export type MemoryCorpusSupplement = {
  search(params: {
    query: string;
    maxResults?: number;
    agentSessionKey?: string;
  }): Promise<MemoryCorpusSearchResult[]>;
  get(params: {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
    agentSessionKey?: string;
  }): Promise<MemoryCorpusGetResult | null>;
};

export type MemoryCorpusSupplementRegistration = {
  pluginId: string;
  supplement: MemoryCorpusSupplement;
};

export type MemoryPromptSupplementRegistration = {
  pluginId: string;
  builder: MemoryPromptSectionBuilder;
};

export type MemoryFlushPlan = {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
  model?: string;
  prompt: string;
  systemPrompt: string;
  relativePath: string;
};

export type MemoryFlushPlanResolver = (params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}) => MemoryFlushPlan | null;

export type RegisteredMemorySearchManager = MemorySearchManager;

export type MemoryRuntimeQmdConfig = {
  command?: string;
};

export type MemoryRuntimeBackendConfig =
  | {
      backend: "builtin";
    }
  | {
      backend: "qmd";
      qmd?: MemoryRuntimeQmdConfig;
    };

export type MemoryPluginRuntime = {
  getMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status" | "cli";
  }): Promise<{
    manager: RegisteredMemorySearchManager | null;
    error?: string;
  }>;
  resolveMemoryBackendConfig(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): MemoryRuntimeBackendConfig;
  closeMemorySearchManager?(params: { cfg: OpenClawConfig; agentId: string }): Promise<void>;
  closeAllMemorySearchManagers?(): Promise<void>;
};

export type MemoryPluginPublicArtifactContentType = "markdown" | "json" | "text";

export type MemoryPluginPublicArtifact = {
  kind: string;
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
  agentIds: string[];
  contentType: MemoryPluginPublicArtifactContentType;
};

export type MemoryPluginPublicArtifactsProvider = {
  listArtifacts(params: {
    cfg: OpenClawConfig;
    agentId?: string;
  }): Promise<MemoryPluginPublicArtifact[]>;
};

export type MemoryPluginCapability = {
  promptBuilder?: MemoryPromptSectionBuilder;
  flushPlanResolver?: MemoryFlushPlanResolver;
  runtime?: MemoryPluginRuntime;
  publicArtifacts?: MemoryPluginPublicArtifactsProvider;
};

export type MemoryPluginCapabilityRegistration = {
  pluginId: string;
  capability: MemoryPluginCapability;
};

const LEGACY_MEMORY_COMPAT_PLUGIN_ID = "legacy-memory-v1";

export type MemoryPluginRuntimeRegistration = {
  pluginId: string;
  runtime: MemoryPluginRuntime;
};

type MemoryPluginState = {
  capability?: MemoryPluginCapabilityRegistration;
  capabilities: MemoryPluginCapabilityRegistration[];
  runtimes: MemoryPluginRuntimeRegistration[];
  corpusSupplements: MemoryCorpusSupplementRegistration[];
  promptSupplements: MemoryPromptSupplementRegistration[];
};

const memoryPluginState: MemoryPluginState = {
  capabilities: [],
  runtimes: [],
  corpusSupplements: [],
  promptSupplements: [],
};

export function registerMemoryCorpusSupplement(
  pluginId: string,
  supplement: MemoryCorpusSupplement,
): void {
  const next = memoryPluginState.corpusSupplements.filter(
    (registration) => registration.pluginId !== pluginId,
  );
  next.push({ pluginId, supplement });
  memoryPluginState.corpusSupplements = next;
}

export function registerMemoryCapability(
  pluginId: string,
  capability: MemoryPluginCapability,
): void {
  if (capability.runtime) {
    registerMemoryRuntimeRegistration(pluginId, capability.runtime);
  }
  const existingCapability = getMemoryCapabilityForPlugin(pluginId);
  const fallbackCapability = memoryPluginState.capability?.capability;
  // A selected memory plugin can add bridge artifacts while memory-core owns sidecar runtime hooks.
  const shouldPreserveExisting =
    !existingCapability &&
    fallbackCapability &&
    Boolean(capability.publicArtifacts) &&
    !capability.promptBuilder &&
    !capability.flushPlanResolver &&
    !capability.runtime;
  const registration = {
    pluginId,
    capability: {
      ...(shouldPreserveExisting ? fallbackCapability : existingCapability),
      ...capability,
    },
  };
  memoryPluginState.capabilities = [
    ...(memoryPluginState.capabilities ?? []).filter((entry) => entry.pluginId !== pluginId),
    registration,
  ];
  memoryPluginState.capability = registration;
}

function patchMemoryCapability(pluginId: string, patch: MemoryPluginCapability): void {
  const current = getMemoryCapabilityForPlugin(pluginId) ?? {};
  registerMemoryCapability(pluginId, { ...current, ...patch });
}

export function getMemoryCapabilityRegistration(params?: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): MemoryPluginCapabilityRegistration | undefined {
  const registration = resolveSelectedMemoryCapability(params);
  return registration
    ? {
        pluginId: registration.pluginId,
        capability: { ...registration.capability },
      }
    : undefined;
}

export function listMemoryCapabilityRegistrations(): MemoryPluginCapabilityRegistration[] {
  return (memoryPluginState.capabilities ?? []).map((registration) => ({
    pluginId: registration.pluginId,
    capability: { ...registration.capability },
  }));
}

function getMemoryCapabilityForPlugin(pluginId: string): MemoryPluginCapability | undefined {
  return (memoryPluginState.capabilities ?? []).find(
    (registration) => registration.pluginId === pluginId,
  )?.capability;
}

function resolveSelectedMemoryCapability(params?: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): MemoryPluginCapabilityRegistration | undefined {
  if (!params?.cfg) {
    return memoryPluginState.capability;
  }
  const plugins = normalizePluginsConfig(params.cfg.plugins);
  const selectedPluginId = resolveMemoryRoleSlot({
    cfg: params.cfg,
    role: "recall",
    agentId: params.agentId,
  });
  if (typeof selectedPluginId !== "string") {
    return undefined;
  }
  const pluginId = selectedPluginId.trim();
  if (
    !pluginId ||
    pluginId.toLowerCase() === "none" ||
    !plugins.enabled ||
    plugins.deny.includes(pluginId) ||
    plugins.entries[pluginId]?.enabled === false
  ) {
    return undefined;
  }
  const capability = getMemoryCapabilityForPlugin(pluginId);
  return capability ? { pluginId, capability } : undefined;
}

export function listMemoryCorpusSupplements(): MemoryCorpusSupplementRegistration[] {
  return [...memoryPluginState.corpusSupplements];
}

/** @deprecated Use registerMemoryCapability(pluginId, { promptBuilder }) instead. */
export function registerMemoryPromptSection(builder: MemoryPromptSectionBuilder): void {
  registerMemoryPromptSectionForPlugin(LEGACY_MEMORY_COMPAT_PLUGIN_ID, builder);
}

export function registerMemoryPromptSectionForPlugin(
  pluginId: string,
  builder: MemoryPromptSectionBuilder,
): void {
  patchMemoryCapability(pluginId, { promptBuilder: builder });
}

export function registerMemoryPromptSupplement(
  pluginId: string,
  builder: MemoryPromptSectionBuilder,
): void {
  const next = memoryPluginState.promptSupplements.filter(
    (registration) => registration.pluginId !== pluginId,
  );
  next.push({ pluginId, builder });
  memoryPluginState.promptSupplements = next;
}

export function buildMemoryPromptSection(params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
  cfg?: OpenClawConfig;
  agentId?: string;
}): string[] {
  const primary = normalizeMemoryPromptLines(
    resolveSelectedMemoryCapability(params)?.capability.promptBuilder?.(params) ?? [],
  );
  const supplements = memoryPluginState.promptSupplements
    // Keep supplement order stable even if plugin registration order changes.
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId))
    .flatMap((registration) => normalizeMemoryPromptLines(registration.builder(params)));
  return [...primary, ...supplements];
}

function normalizeMemoryPromptLines(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((line): line is string => typeof line === "string");
}

export function getMemoryPromptSectionBuilder(): MemoryPromptSectionBuilder | undefined {
  return memoryPluginState.capability?.capability.promptBuilder;
}

export function listMemoryPromptSupplements(): MemoryPromptSupplementRegistration[] {
  return [...memoryPluginState.promptSupplements];
}

/** @deprecated Use registerMemoryCapability(pluginId, { flushPlanResolver }) instead. */
export function registerMemoryFlushPlanResolver(resolver: MemoryFlushPlanResolver): void {
  registerMemoryFlushPlanResolverForPlugin(LEGACY_MEMORY_COMPAT_PLUGIN_ID, resolver);
}

export function registerMemoryFlushPlanResolverForPlugin(
  pluginId: string,
  resolver: MemoryFlushPlanResolver,
): void {
  patchMemoryCapability(pluginId, { flushPlanResolver: resolver });
}

export function resolveMemoryFlushPlan(params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
  agentId?: string;
}): MemoryFlushPlan | null {
  return resolveSelectedMemoryCapability(params)?.capability.flushPlanResolver?.(params) ?? null;
}

export function getMemoryFlushPlanResolver(): MemoryFlushPlanResolver | undefined {
  return memoryPluginState.capability?.capability.flushPlanResolver;
}

/** @deprecated Use registerMemoryCapability(pluginId, { runtime }) instead. */
export function registerMemoryRuntime(runtime: MemoryPluginRuntime): void {
  registerMemoryRuntimeForPlugin(LEGACY_MEMORY_COMPAT_PLUGIN_ID, runtime);
}

export function registerMemoryRuntimeForPlugin(
  pluginId: string,
  runtime: MemoryPluginRuntime,
): void {
  patchMemoryCapability(pluginId, { runtime });
}

function registerMemoryRuntimeRegistration(pluginId: string, runtime: MemoryPluginRuntime): void {
  const next = memoryPluginState.runtimes.filter(
    (registration) => registration.pluginId !== pluginId,
  );
  next.push({ pluginId, runtime });
  memoryPluginState.runtimes = next;
}

export function getMemoryRuntime(): MemoryPluginRuntime | undefined {
  return memoryPluginState.capability?.capability.runtime;
}

export function getMemoryRuntimeForPlugin(pluginId: string): MemoryPluginRuntime | undefined {
  return memoryPluginState.runtimes.find((registration) => registration.pluginId === pluginId)
    ?.runtime;
}

export function listMemoryRuntimeRegistrations(): MemoryPluginRuntimeRegistration[] {
  return [...memoryPluginState.runtimes];
}

export function hasMemoryRuntime(): boolean {
  return getMemoryRuntime() !== undefined;
}

function cloneMemoryPublicArtifact(
  artifact: MemoryPluginPublicArtifact,
): MemoryPluginPublicArtifact {
  return {
    ...artifact,
    agentIds: [...artifact.agentIds],
  };
}

export async function listActiveMemoryPublicArtifacts(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<MemoryPluginPublicArtifact[]> {
  const artifacts =
    (await resolveSelectedMemoryCapability(params)?.capability.publicArtifacts?.listArtifacts(
      params,
    )) ?? [];
  return artifacts.map(cloneMemoryPublicArtifact).toSorted((left, right) => {
    const workspaceOrder = left.workspaceDir.localeCompare(right.workspaceDir);
    if (workspaceOrder !== 0) {
      return workspaceOrder;
    }
    const relativePathOrder = left.relativePath.localeCompare(right.relativePath);
    if (relativePathOrder !== 0) {
      return relativePathOrder;
    }
    const kindOrder = left.kind.localeCompare(right.kind);
    if (kindOrder !== 0) {
      return kindOrder;
    }
    const contentTypeOrder = left.contentType.localeCompare(right.contentType);
    if (contentTypeOrder !== 0) {
      return contentTypeOrder;
    }
    const agentOrder = left.agentIds.join("\0").localeCompare(right.agentIds.join("\0"));
    if (agentOrder !== 0) {
      return agentOrder;
    }
    return left.absolutePath.localeCompare(right.absolutePath);
  });
}

export function restoreMemoryPluginState(state: MemoryPluginState): void {
  memoryPluginState.capabilities = [...(state.capabilities ?? [])];
  memoryPluginState.capability = state.capability
    ? {
        pluginId: state.capability.pluginId,
        capability: { ...state.capability.capability },
      }
    : undefined;
  if (memoryPluginState.capabilities.length === 0 && memoryPluginState.capability) {
    memoryPluginState.capabilities = [memoryPluginState.capability];
  }
  memoryPluginState.runtimes = [...(state.runtimes ?? [])];
  memoryPluginState.corpusSupplements = [...state.corpusSupplements];
  memoryPluginState.promptSupplements = [...state.promptSupplements];
}

export function clearMemoryPluginState(): void {
  memoryPluginState.capability = undefined;
  memoryPluginState.capabilities = [];
  memoryPluginState.runtimes = [];
  memoryPluginState.corpusSupplements = [];
  memoryPluginState.promptSupplements = [];
}

export const resetMemoryPluginState = clearMemoryPluginState;
