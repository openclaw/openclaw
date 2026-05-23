import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MemorySearchManager } from "../memory-host-sdk/host/types.js";
import type { OpenClawPluginApi } from "../plugin-entry.js";

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
  listArtifacts(params: { cfg: OpenClawConfig }): Promise<MemoryPluginPublicArtifact[]>;
};
// ── Dreaming Provider Interface ──────────────────────────────────────
//
// Any memory plugin that implements this interface can participate in
// OpenClaw's dreaming lifecycle (Light → Deep → REM memory consolidation).
// All methods are optional — the runtime falls back to memory-core defaults.

export type DreamingCandidate = {
  /** Unique key, typically `${path}:${startLine}:${endLine}` */
  key: string;
  /** Absolute path to the source memory file */
  path: string;
  startLine: number;
  endLine: number;
  /** Human-readable snippet of the candidate content */
  snippet: string;
  /** Composite score 0–1 */
  score: number;
  /** How many times this candidate has been recalled */
  recallCount: number;
  /** Number of unique search queries that surfaced this candidate */
  uniqueQueries: number;
  /** Individual component scores (for transparency / debugging) */
  components: {
    frequency: number;
    relevance: number;
    diversity: number;
    recency: number;
    consolidation: number;
    conceptual: number;
  };
};

export type DreamingPromotionResult = {
  /** Number of candidates promoted to long-term memory */
  applied: number;
  /** The candidates that were promoted */
  appliedCandidates: DreamingCandidate[];
  /** Dates of dropped old promotion sections (compaction) */
  droppedDates: string[];
};

export type DreamingPhaseSignal = {
  phase: "light" | "deep" | "rem";
  keys: string[];
  timestamp: number;
};

export type DreamingStorageConfig = {
  timezone?: string;
  storage: {
    mode: "inline" | "separate" | "both";
    separateReports: boolean;
  };
  execution?: {
    model?: string;
  };
};

export type DreamingLogger = Pick<
  OpenClawPluginApi["logger"],
  "info" | "warn" | "error" | "debug"
>;

export type MemoryPluginDreamingProvider = {
  /** Light phase: ingest daily memory + session signals, collect candidates */
  runLightPhase?(params: {
    workspaceDir: string;
    cfg?: OpenClawConfig;
    nowMs: number;
    logger: DreamingLogger;
  }): Promise<void>;

  /** Deep phase: rank short-term candidates, promote high-scorers to MEMORY.md */
  runDeepPhase?(params: {
    workspaceDir: string;
    cfg?: OpenClawConfig;
    limit: number;
    minScore: number;
    nowMs: number;
    logger: DreamingLogger;
  }): Promise<DreamingPromotionResult>;

  /** REM phase: surface cross-cutting patterns and write reflection entries */
  runRemPhase?(params: {
    workspaceDir: string;
    cfg?: OpenClawConfig;
    nowMs: number;
    logger: DreamingLogger;
  }): Promise<void>;

  /** Write a deep dreaming report artifact (markdown or JSON) */
  writeDeepReport?(params: {
    workspaceDir: string;
    bodyLines: string[];
    nowMs: number;
    timezone?: string;
    storage: DreamingStorageConfig["storage"];
  }): Promise<void>;
};


export type MemoryPluginCapability = {
  promptBuilder?: MemoryPromptSectionBuilder;
  flushPlanResolver?: MemoryFlushPlanResolver;
  runtime?: MemoryPluginRuntime;
  publicArtifacts?: MemoryPluginPublicArtifactsProvider;
  /** Optional dreaming lifecycle provider */
  dreaming?: MemoryPluginDreamingProvider;
};

export type MemoryPluginCapabilityRegistration = {
  pluginId: string;
  capability: MemoryPluginCapability;
};

const LEGACY_MEMORY_COMPAT_PLUGIN_ID = "legacy-memory-v1";

type MemoryPluginState = {
  capability?: MemoryPluginCapabilityRegistration;
  corpusSupplements: MemoryCorpusSupplementRegistration[];
  promptSupplements: MemoryPromptSupplementRegistration[];
};

const memoryPluginState: MemoryPluginState = {
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
  const existingCapability = memoryPluginState.capability?.capability;
  // A selected memory plugin can add bridge artifacts while memory-core owns sidecar runtime hooks.
  const shouldPreserveExisting =
    existingCapability &&
    Boolean(capability.publicArtifacts) &&
    !capability.promptBuilder &&
    !capability.flushPlanResolver &&
    !capability.runtime;
  memoryPluginState.capability = {
    pluginId,
    capability: {
      ...(shouldPreserveExisting ? existingCapability : {}),
      ...capability,
    },
  };
}

function patchMemoryCapability(pluginId: string, patch: MemoryPluginCapability): void {
  const current =
    memoryPluginState.capability?.pluginId === pluginId
      ? memoryPluginState.capability.capability
      : {};
  registerMemoryCapability(pluginId, { ...current, ...patch });
}

export function getMemoryCapabilityRegistration(): MemoryPluginCapabilityRegistration | undefined {
  return memoryPluginState.capability
    ? {
        pluginId: memoryPluginState.capability.pluginId,
        capability: { ...memoryPluginState.capability.capability },
      }
    : undefined;
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
}): string[] {
  const primary = normalizeMemoryPromptLines(
    memoryPluginState.capability?.capability.promptBuilder?.(params) ?? [],
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
}): MemoryFlushPlan | null {
  return memoryPluginState.capability?.capability.flushPlanResolver?.(params) ?? null;
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

export function getMemoryRuntime(): MemoryPluginRuntime | undefined {
  return memoryPluginState.capability?.capability.runtime;
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
}): Promise<MemoryPluginPublicArtifact[]> {
  const artifacts =
    (await memoryPluginState.capability?.capability.publicArtifacts?.listArtifacts(params)) ?? [];
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
  memoryPluginState.capability = state.capability
    ? {
        pluginId: state.capability.pluginId,
        capability: { ...state.capability.capability },
      }
    : undefined;
  memoryPluginState.corpusSupplements = [...state.corpusSupplements];
  memoryPluginState.promptSupplements = [...state.promptSupplements];
}

export function clearMemoryPluginState(): void {
  memoryPluginState.capability = undefined;
  memoryPluginState.corpusSupplements = [];
  memoryPluginState.promptSupplements = [];
}

export const resetMemoryPluginState = clearMemoryPluginState;
