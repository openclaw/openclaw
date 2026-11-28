import type { TSchema } from "typebox";
import type { AgentToolSurfacePresentation } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginToolMcpMeta } from "../plugins/tool-metadata.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import type { AgentToolResult, AgentToolUpdateCallback } from "./runtime/index.js";
import type { ToolDefinition } from "./sessions/index.js";
import type {
  CatalogSource,
  CatalogVisibilityOptions,
  ToolSearchConfig,
  UnknownToolErrorOptions,
} from "./tool-search-protocol.js";
import type { AnyAgentTool } from "./tools/common.js";

export type CatalogTool = AnyAgentTool | ToolDefinition;
export type ToolSearchCallOptions = CatalogVisibilityOptions &
  UnknownToolErrorOptions & {
    parentToolCallId?: string;
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback;
    /**
     * Code Mode's MCP namespace guest expects a thrown denial for resource and
     * prompt operations. Ordinary `dispatch_action` keeps the blocked result envelope.
     */
    mcpNamespaceGuest?: boolean;
  };

export type ToolSearchCatalogToolExecutor = (params: {
  tool: CatalogTool;
  /** Stable catalog identity captured by the catalog owner before execution. */
  toolId: string;
  toolName: string;
  source: CatalogSource;
  sourceName?: string;
  toolCallId: string;
  parentToolCallId?: string;
  /** Exact registered-instance classification resolved by the catalog owner. */
  replaySafe?: boolean;
  input: unknown;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  acceptResultBeforeProjection: (
    result: AgentToolResult<unknown>,
  ) => Promise<AgentToolResult<unknown>>;
}) => Promise<AgentToolResult<unknown>>;

/** Per-run/session context used by Tool Search control tools. */
export type ToolSearchToolContext = {
  pluginExecutionAuthority?: AdmittedRunOperatorAuthority;
  modelContextWindowTokens?: number;
  config?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  abortSignal?: AbortSignal;
  executeTool?: ToolSearchCatalogToolExecutor;
  /** Set when the run executes only these tools; swarm globals gate on `sessions_spawn`. */
  toolExecutionAllow?: readonly string[];
  codeModeSkills?: Readonly<AgentToolSurfacePresentation["skills"]>;
};

/** Catalog entry retained behind compacted Tool Search control tools. */
export type ToolSearchCatalogEntry = {
  id: string;
  source: CatalogSource;
  sourceName?: string;
  mcp?: PluginToolMcpMeta;
  name: string;
  label?: string;
  description: string;
  /** Recorded when the catalog owner also exposes this tool in the native surface. */
  directVisible?: boolean;
  /** Its bare name also belongs to an eligible tool kept direct outside the catalog. */
  requiresExactId?: boolean;
  /** Runs only as a direct call by name; catalog bridges refuse it. */
  onDemand?: true;
  parameters?: unknown;
  outputSchema?: TSchema;
  tool: CatalogTool;
};

export type ToolSearchCatalogSession = {
  entries: ToolSearchCatalogEntry[];
  counterScope: string;
  searchCount: number;
  describeCount: number;
  callCount: number;
};

export type ToolSearchCatalogTelemetry = Omit<ToolSearchCatalogSession, "entries"> & {
  catalogSize: number;
  sources: Record<CatalogSource, number>;
};

export type ToolSearchCatalogRef = {
  current?: ToolSearchCatalogSession;
  /**
   * Set by a runner that loads an on-demand tool on its first direct call by name. Without it,
   * compaction keeps on-demand tools direct, like direct-only ones.
   */
  loadsOnDemandTools?: true;
  /** On-demand tools this session already loaded; compaction keeps them direct. */
  promotedToolNames?: ReadonlySet<string>;
  /**
   * Set only by a runner that pins the session's tool listing: the names its pin sends, or on a
   * series' first request the MCP tools chosen by size. Unset, every MCP tool stays deferred.
   */
  sessionPinnedToolNames?: ReadonlySet<string>;
  /** Set by a runner that loads an on-demand tool as soon as the model looks it up. */
  loadOnDemandTool?: (name: string) => void;
  directOnlyToolNames?: ReadonlySet<string>;
  baselineDirectOnlyToolNames?: ReadonlySet<string>;
  closedTelemetry?: ToolSearchCatalogTelemetry;
  onDispose?: Set<() => void>;
};

export type ToolSearchCatalogApplyResult = {
  tools: AnyAgentTool[];
  compacted: boolean;
  catalogToolCount: number;
  catalogRegistered: boolean;
  catalogReused: boolean;
};

export type ToolSearchCatalogCompactionParams = {
  config?: OpenClawConfig;
  tools: AnyAgentTool[];
  enabled: boolean;
  catalogRef?: ToolSearchCatalogRef;
  toolHookContext?: HookContext;
  toolExecutionAllow?: readonly string[];
  isVisibleControlTool: (tool: AnyAgentTool) => boolean;
  isVisibleCatalogTool?: (tool: AnyAgentTool) => boolean;
  shouldCatalogTool?: (tool: AnyAgentTool) => boolean;
  selection?: Pick<ToolSearchConfig, "include" | "exclude">;
};
