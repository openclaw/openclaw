/** Acyclic contracts for capabilities stored in the installed plugin registry. */
import type { SessionDiscussionInfo } from "../../packages/gateway-protocol/src/schema/session-discussion.js";
import type {
  MemoryCliSearchParams,
  MemorySearchManager,
} from "../../packages/memory-host-sdk/src/host/search-manager.types.js";
import type { ConversationRecallContext } from "../agents/conversation-recall.types.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngine } from "../context-engine/types.js";
import type {
  LegacyMemoryReadResult,
  MemoryCliSearchResult,
  MemoryOriginClass,
  MemoryReadResult,
  MemorySearchResult,
} from "../memory-host-sdk/host/types.js";
import type {
  EmbeddingProviderAdapter,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderCreateResult,
} from "./embedding-provider-types.js";
import type { MemoryEmbeddingProviderRuntime } from "./memory-embedding-providers.js";
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
  /** Host-resolved repository identity for this run; the plugin owns any memory-format guidance. */
  projectKey?: string;
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
    projectKey?: string;
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

/** A file-persistence flush plan with its resolved timing. */
export type MemoryFlushPlan = {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
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
 * defined ones deliberately override it.
 */
export type MemoryFlushFilePlanDraft = Omit<MemoryFlushPlan, keyof MemoryFlushPlanTiming> &
  Partial<MemoryFlushPlanTiming> & { persistenceToolNames?: never; lookupToolNames?: never };

/**
 * Tool persistence for the selected memory slot owner. The host fills omitted timing;
 * defined values deliberately override it.
 */
export type MemoryFlushToolsPlan = Partial<MemoryFlushPlanTiming> & {
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

/** Resolves a complete file flush plan. */
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

/**
 * What a /learn contribution writes. The host owns routing between media, so a medium is
 * host vocabulary: "memory" is reserved for the selected memory slot owner.
 */
export type LearnMedium = "skills" | "memory";

type LearnGuidance = {
  /** Lines for the /learn prompt body. */
  lines: readonly string[];
  /** Reference blocks the host appends after the closing instruction, each after a blank line. */
  appendix?: readonly string[];
};

type LearnSubcommandContext = {
  /** Text after the subcommand name. */
  args: string;
  config: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  /** Revalidates admitted owner authority; call it after awaited work, before effects. */
  assertOwnerCurrent?: () => void;
};

/** A reply without a model turn, or the prompt that replaces this turn's user message. */
type LearnSubcommandResult = { text: string } | { prompt: string };

export type LearnSubcommand = {
  /** The word after /learn, matched case-insensitively. */
  name: string;
  /**
   * Whether the raw text after the name, separator included, selects the subcommand;
   * other text stays a learning request. The handler gets the arguments without the separator.
   */
  matchArgs?: (args: string) => boolean;
  /**
   * Changes state without a model turn: only owners may run it, gateway clients need
   * operator.admin, and it runs even when the contribution's tools are unavailable.
   * Other subcommands run only when the contribution can learn on this turn.
   */
  direct?: boolean;
  handle: (
    context: LearnSubcommandContext,
  ) => LearnSubcommandResult | Promise<LearnSubcommandResult>;
};

export type LearnContribution = {
  medium: LearnMedium;
  /** Tools a /learn turn may use to persist lessons; the host checks them against tool policy. */
  toolNames: readonly string[];
  /** Tools that must all be allowed for this contribution to learn; default: any of toolNames. */
  requiredToolNames?: readonly string[];
  /** This contribution can learn in a sandboxed turn using its own authorized tools. Defaults to false. */
  sandboxCompatible?: boolean;
  /**
   * Builds this contribution's /learn guidance from the allowed tools and the media that
   * learn on this turn, including this one. It must be deterministic: it is prompt text.
   */
  buildGuidance: (params: {
    availableTools: Set<string>;
    media: ReadonlySet<LearnMedium>;
  }) => LearnGuidance;
  /** Words after /learn that this contribution handles instead of a learning request. */
  subcommands?: readonly LearnSubcommand[];
  /**
   * Reply when /learn cannot learn here and this contribution's medium is the only one
   * registered (or its subcommand was asked for). Default: a generic remedy.
   */
  unavailableText?: string;
};

export type LearnContributionRegistration = {
  pluginId: string;
  contribution: LearnContribution;
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

export type {
  SessionDiscussionInfo,
  SessionDiscussionState,
} from "../../packages/gateway-protocol/src/schema/session-discussion.js";

export type SessionDiscussionProvider = {
  id: string;
  info(params: { sessionKey: string; agentId: string }): Promise<SessionDiscussionInfo>;
  open(params: { sessionKey: string; agentId: string }): Promise<SessionDiscussionInfo>;
};

export type ResolvedPluginRuntimeArtifact = { source: string; rootDir: string };
