/** Acyclic contracts for capabilities stored in the installed plugin registry. */
import type { EmbeddingInput } from "../../packages/memory-host-sdk/src/engine-embeddings.js";
import type { ConversationRecallContext } from "../agents/conversation-recall.types.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngine } from "../context-engine/types.js";
import type {
  LegacyMemoryReadResult,
  MemoryCliSearchParams,
  MemoryCliSearchResult,
  MemoryOriginClass,
  MemoryReadResult,
  MemorySearchManager,
  MemorySearchResult,
} from "../memory-host-sdk/host/types.js";
import type {
  EmbeddingBatchChunk,
  EmbeddingBatchOptions,
} from "./embedding-provider-runtime-types.js";
import type {
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderCreateResult,
  EmbeddingProviderIndexIdentity,
  EmbeddingProviderRuntime,
} from "./embedding-provider-types.js";
import type {
  MemoryProviderOpenParams,
  MemoryProviderOpenResult,
} from "./memory-provider-types.js";

export type ContextEngineFactoryContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
};
export type ContextEngineFactory = (
  ctx: ContextEngineFactoryContext,
) => ContextEngine | Promise<ContextEngine>;
export type ContextEngineRegistrationLifecycle = "runtime" | "readOnlyDiscovery";
export type ContextEngineRegistration = {
  factory: ContextEngineFactory;
  owner: string;
  lifecycle: ContextEngineRegistrationLifecycle;
};

type CompactionProviderSummarizationInstructions = {
  identifierPolicy?: "strict" | "off" | "custom";
  identifierInstructions?: string;
};

export interface CompactionProvider {
  id: string;
  label: string;
  summarize(params: {
    messages: unknown[];
    signal?: AbortSignal;
    compressionRatio?: number;
    customInstructions?: string;
    summarizationInstructions?: CompactionProviderSummarizationInstructions;
    previousSummary?: string;
  }): Promise<string>;
}

export type RegisteredCompactionProvider = {
  provider: CompactionProvider;
  ownerPluginId?: string;
};

export type MemoryEmbeddingBatchChunk = EmbeddingBatchChunk & {
  embeddingInput?: EmbeddingInput;
};

export type MemoryEmbeddingBatchOptions = Omit<EmbeddingBatchOptions, "chunks"> & {
  chunks: MemoryEmbeddingBatchChunk[];
};

export type MemoryEmbeddingProviderCallOptions = Pick<EmbeddingProviderCallOptions, "signal">;

export type MemoryEmbeddingProviderRuntime = Omit<EmbeddingProviderRuntime, "batchEmbed"> & {
  batchEmbed?: (options: MemoryEmbeddingBatchOptions) => Promise<number[][] | null>;
};

export type MemoryEmbeddingProviderIndexIdentity = EmbeddingProviderIndexIdentity;

export type MemoryEmbeddingProvider = EmbeddingProvider;

export type MemoryEmbeddingProviderCreateOptions = Omit<EmbeddingProviderCreateOptions, "local"> & {
  fallback?: string;
  local?: NonNullable<EmbeddingProviderCreateOptions["local"]> & {
    contextSize?: number | "auto";
  };
};

export type MemoryEmbeddingProviderCreateResult = Omit<EmbeddingProviderCreateResult, "runtime"> & {
  runtime?: MemoryEmbeddingProviderRuntime;
};

export type MemoryEmbeddingProviderAdapter = Omit<EmbeddingProviderAdapter, "create"> & {
  autoSelectPriority?: number;
  allowExplicitWhenConfiguredAuto?: boolean;
  supportsMultimodalEmbeddings?: (params: { model: string }) => boolean;
  create: (
    options: MemoryEmbeddingProviderCreateOptions,
  ) => Promise<MemoryEmbeddingProviderCreateResult>;
  shouldContinueAutoSelection?: (err: unknown) => boolean;
};

export type MemoryPromptSectionParams = {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
};

export type MemoryPromptSectionBuilder = (params: MemoryPromptSectionParams) => string[];

export type MemoryPromptSectionPreparer = (
  params: MemoryPromptSectionParams,
) => Promise<readonly string[]>;

export type PreparedMemoryPromptSection = Readonly<{
  context: Readonly<{
    availableTools: readonly string[];
    citationsMode?: MemoryCitationsMode;
    agentId?: string;
    agentSessionKey?: string;
    sandboxed: boolean;
  }>;
  lines: readonly string[];
}>;

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

type MemoryCorpusGetResult = {
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
    agentId?: string;
    agentSessionKey?: string;
    sandboxed?: boolean;
  }): Promise<MemoryCorpusSearchResult[]>;
  get(params: {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
    agentId?: string;
    agentSessionKey?: string;
    sandboxed?: boolean;
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

export type MemoryPromptPreparationRegistration = {
  pluginId: string;
  prepare: MemoryPromptSectionPreparer;
};

/**
 * A file-persistence flush plan with its resolved timing. Its shape is unchanged from earlier
 * releases, so existing producers and readers keep compiling and behaving the same.
 */
export type MemoryFlushPlan = {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
  model?: string;
  prompt: string;
  systemPrompt: string;
  relativePath: string;
};

/** Flush timing the host resolves from memory-flush config and the model context window. */
type MemoryFlushPlanTiming = Pick<
  MemoryFlushPlan,
  "softThresholdTokens" | "forceFlushTranscriptBytes" | "reserveTokensFloor"
>;

/**
 * A file plan as a resolver may return it: omitted timing fields are filled by the host, and
 * defined ones deliberately override it. A file plan without a model keeps the session's model.
 */
export type MemoryFlushFilePlanDraft = Omit<MemoryFlushPlan, keyof MemoryFlushPlanTiming> &
  Partial<MemoryFlushPlanTiming> & { persistenceToolNames?: never; lookupToolNames?: never };

/**
 * Tool persistence for the selected memory slot owner. The host fills omitted timing and the
 * configured flush model; defined values deliberately override them.
 */
export type MemoryFlushToolsPlan = Partial<MemoryFlushPlanTiming> & {
  model?: string;
  prompt: string;
  systemPrompt: string;
  /** Absent on every tools plan; a tools plan never names a workspace file. */
  relativePath?: never;
  persistenceToolNames: readonly string[];
  /** Read-only helper tools the flush may use to inspect existing provider memory. */
  lookupToolNames?: readonly string[];
};

type MemoryFlushPlanResolverParams = {
  cfg?: OpenClawConfig;
  nowMs?: number;
  contextWindowTokens?: number;
};

/** Resolves a complete file flush plan; its contract is unchanged from earlier releases. */
export type MemoryFlushPlanResolver = (
  params: MemoryFlushPlanResolverParams,
) => MemoryFlushPlan | null;

/**
 * Resolves a flush plan the host completes: a file plan whose omitted timing the host fills,
 * or a tools plan that persists through the selected slot owner's own tools.
 */
export type MemoryProviderFlushPlanResolver = (
  params: MemoryFlushPlanResolverParams,
) => MemoryFlushFilePlanDraft | MemoryFlushToolsPlan | null;

export type RegisteredMemorySearchManager = Omit<MemorySearchManager, "readFile"> & {
  readFile(
    params: Parameters<MemorySearchManager["readFile"]>[0],
  ): Promise<LegacyMemoryReadResult | MemoryReadResult>;
};

type MemoryRuntimeBackendConfig = { backend: "builtin" };

export type MemoryPluginRuntime = {
  /** CLI search and recall recording run under the same plugin instance. */
  searchForCli?(params: MemoryCliSearchParams): Promise<MemoryCliSearchResult>;
  getMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status" | "cli";
    /** Request a read-only source freshness scan; runtimes may ignore unsupported diagnostics. */
    inspectSources?: boolean;
  }): Promise<{
    manager: RegisteredMemorySearchManager | null;
    debug?: {
      backend?: "builtin";
      purpose?: "default" | "status" | "cli";
      managerMs?: number;
    };
    error?: string;
  }>;
  resolveMemoryBackendConfig(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): MemoryRuntimeBackendConfig;
  /** Authorize raw hits before caller-visible use; absent runtimes must not expose session hits. */
  authorizeSearchHits?(params: {
    cfg: OpenClawConfig;
    agentId: string;
    requesterSessionKey: string | undefined;
    sandboxed: boolean;
    hits: MemorySearchResult[];
    /** A sessionless host or operator caller acting for `agentId` may keep only that agent's hits. */
    trustedAgentScope?: boolean;
    /** The session caller's host-granted recall pass, exactly as its tool context received it. */
    conversationRecall?: ConversationRecallContext;
  }): Promise<MemorySearchResult[]>;
  /** The classifier consumes pinned read sources without probing Gateway-local paths. */
  supportsWorkspaceMemoryReadSources?: true;
  classifyWorkspaceMemoryPaths?(params: {
    cfg: OpenClawConfig;
    agentId: string;
    workspaceDir: string;
    relativePaths: string[];
    /** Already-read remote files; an absent canonical path must remain untrusted. */
    readSources?: readonly { relativePath: string; canonicalRelativePath?: string }[];
  }): Promise<Array<{ relativePath: string; originClass: MemoryOriginClass }>>;
  /** Fence and drain managers consuming these exact retiring capability objects. */
  prepareReload?(change: {
    retireRuntime: boolean;
    retiringEmbeddingProviders: readonly MemoryEmbeddingProviderAdapter[];
  }): {
    drain(): Promise<void | { errors: readonly unknown[] }>;
    resume(): void;
  };
  closeMemorySearchManager?(params: { cfg: OpenClawConfig; agentId: string }): Promise<void>;
  closeAllMemorySearchManagers?(): Promise<void>;
};

/** Additive runtime; lifecycle hooks share the existing memory runtime cleanup owner. */
export type MemoryProviderRuntime = Pick<
  MemoryPluginRuntime,
  "prepareReload" | "closeMemorySearchManager" | "closeAllMemorySearchManagers"
> & {
  open(params: MemoryProviderOpenParams): Promise<MemoryProviderOpenResult>;
};

type MemoryPluginPublicArtifactContentType = "markdown" | "json" | "text";

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

export type MemoryPluginCapability = {
  promptBuilder?: MemoryPromptSectionBuilder;
  flushPlanResolver?: MemoryFlushPlanResolver;
  /** Host-completed flush plans, including tool persistence; preferred over flushPlanResolver. */
  providerFlushPlanResolver?: MemoryProviderFlushPlanResolver;
  runtime?: MemoryPluginRuntime;
  /** Provider-neutral host integration; preferred over runtime when present. */
  providerRuntime?: MemoryProviderRuntime;
  publicArtifacts?: MemoryPluginPublicArtifactsProvider;
  /** Agent-facing tools Active Memory may use for provider-owned deep recall. */
  recallToolNames?: readonly string[];
  /** Local deterministic recall tool required by provider-owned direct lookup. */
  deterministicRecallToolName?: string;
  /** Whether recall may read protected same-agent private session transcripts. */
  supportsPrivateTranscriptRecall?: boolean;
};

export type MemoryPluginCapabilityRegistration = {
  pluginId: string;
  capability: MemoryPluginCapability;
  /**
   * Registrar-provided memory slot ownership. Only the slot owner may displace
   * earlier fields during resolution; undeclared registrations contribute what
   * the owner lacks but never take over its runtime or consolidation surface.
   */
  memorySlotSelected?: boolean;
};

export type SessionDiscussionState = "none" | "available" | "open";
export type SessionDiscussionInfo = {
  state: SessionDiscussionState;
  embedUrl?: string;
  openUrl?: string;
};

export type SessionDiscussionProvider = {
  id: string;
  info(params: { sessionKey: string; agentId: string }): Promise<SessionDiscussionInfo>;
  open(params: { sessionKey: string; agentId: string }): Promise<SessionDiscussionInfo>;
};

export type ResolvedPluginRuntimeArtifact = { source: string; rootDir: string };
