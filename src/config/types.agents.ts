import type {
  AgentDefaultsConfig,
  AgentRuntime,
  ClaudeSdkOptions,
} from "./types.agent-defaults.js";
import type { HumanDelayConfig, IdentityConfig } from "./types.base.js";
import type { McpServersConfig } from "./types.mcp.js";
import type { GroupChatConfig } from "./types.messages.js";
import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.sandbox.js";
import type { AgentToolsConfig, MemorySearchConfig } from "./types.tools.js";

/**
 * Extended thinking budget tier for Claude Code SDK.
 * Maps to token budgets: none=0, low=10k, medium=25k, high=50k
 */
export type SdkThinkingBudgetTier = "none" | "low" | "medium" | "high";

export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent model fallbacks (provider/model). */
      fallbacks?: string[];
    };

export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentModelConfig;
  /** Per-agent runtime override (pi or claude). */
  runtime?: AgentRuntime;
  /** Per-agent Claude SDK options (when runtime is claude). */
  claudeSdkOptions?: ClaudeSdkOptions;
  /** Optional allowlist of skills for this agent (omit = all skills; empty = none). */
  skills?: string[];
  memorySearch?: MemorySearchConfig;
  /** Human-like delay between block replies for this agent. */
  humanDelay?: HumanDelayConfig;
  /** Optional per-agent heartbeat overrides. */
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  /** Per-agent default thinking level override (Pi runtime only). */
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Per-agent default verbose level override (Pi runtime only). */
  verboseDefault?: "off" | "on" | "full";
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  subagents?: {
    /** Allow spawning sub-agents under other agent ids. Use "*" to allow any. */
    allowAgents?: string[];
    /** Per-agent default model for spawned sub-agents (string or {primary,fallbacks}). */
    model?: string | { primary?: string; fallbacks?: string[] };
    /**
     * Runtime for sub-agents spawned from this agent.
     * - "pi": Pi Agent embedded runner
     * - "claude": Claude Code SDK runner
     * - "inherit": Inherit from this agent's runtime (default)
     */
    runtime?: "pi" | "claude" | "inherit";
  };
  sandbox?: {
    mode?: "off" | "non-main" | "all";
    /** Agent workspace access inside the sandbox. */
    workspaceAccess?: "none" | "ro" | "rw";
    /**
     * Session tools visibility for sandboxed sessions.
     * - "spawned": only allow session tools to target sessions spawned from this session (default)
     * - "all": allow session tools to target any session
     */
    sessionToolsVisibility?: "spawned" | "all";
    /** Container/workspace scope for sandbox isolation. */
    scope?: "session" | "agent" | "shared";
    /** Legacy alias for scope ("session" when true, "shared" when false). */
    perSession?: boolean;
    workspaceRoot?: string;
    /** Docker-specific sandbox overrides for this agent. */
    docker?: SandboxDockerSettings;
    /** Optional sandboxed browser overrides for this agent. */
    browser?: SandboxBrowserSettings;
    /** Auto-prune overrides for this agent. */
    prune?: SandboxPruneSettings;
  };
  /** Per-agent MCP server overrides/additions. Merged with root-level `mcpServers`. */
  mcpServers?: McpServersConfig;
  tools?: AgentToolsConfig;
};

export type AgentHandoffLoggingConfig = {
  /** Enable agent handoff transition logging (default: false). */
  enabled?: boolean;
  /** Log level for handoff events (default: "info"). */
  level?: "debug" | "info" | "warn";
};

export type AgentsConfig = {
  /**
   * Main agent loop configuration.
   *
   * This is the gateway-wide "main agent" operating mode (inbound auto-reply loop, etc.).
   * It is intentionally separate from per-agent/session defaults so the main runtime can be
   * swapped independently of configured agents.
   */
  main?: {
    runtime?: AgentDefaultsConfig["runtime"];
    /**
     * Claude Agent SDK (TypeScript) runtime tuning for the main agent loop.
     *
     * This is intentionally runtime-specific and only applies when the main
     * runtime is "claude".
     */
    sdk?: {
      /** Enable Claude Code hook wiring for richer lifecycle/tool parity. */
      hooksEnabled?: boolean;
      /**
       * Model to use (e.g., "sonnet", "opus", "haiku", or full model ID).
       * Default: SDK's default (typically sonnet).
       */
      model?: string;
      /**
       * Extended thinking budget tier. Controls how much the model "thinks" before responding.
       * - "none": Disable extended thinking (fastest, cheapest)
       * - "low": Light thinking (~10k tokens) — quick queries
       * - "medium": Moderate thinking (~25k tokens) — standard tasks
       * - "high": Deep thinking (~50k tokens) — complex reasoning
       * Default: "low"
       */
      thinkingBudget?: SdkThinkingBudgetTier;
      /**
       * Model mappings for Claude Code SDK thinking tiers.
       * Maps shorthand keys ("opus", "sonnet", "haiku") to full model identifiers.
       * These are passed as environment variables to the SDK:
       * - opus → ANTHROPIC_DEFAULT_OPUS_MODEL
       * - sonnet → ANTHROPIC_DEFAULT_SONNET_MODEL
       * - haiku → ANTHROPIC_DEFAULT_HAIKU_MODEL
       * - subagent → CLAUDE_CODE_SUBAGENT_MODEL
       */
      models?: {
        opus?: string;
        sonnet?: string;
        haiku?: string;
        subagent?: string;
      };
      /**
       * Additional SDK `query({ options })` fields to pass through.
       *
       * NOTE: Clawdbrain still controls tool bridging (`mcpServers`, `allowedTools`, etc.).
       * Use this for options like `settingSources`, `additionalDirectories`,
       * `includePartialMessages`, etc.
       */
      options?: Record<string, unknown>;
    };
  };
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
  handoffLogging?: AgentHandoffLoggingConfig;
};

export type AgentBinding = {
  agentId: string;
  match: {
    channel: string;
    accountId?: string;
    peer?: { kind: "dm" | "group" | "channel"; id: string };
    guildId?: string;
    teamId?: string;
  };
};
