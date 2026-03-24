import type { ChatType } from "../channels/chat-type.js";
import type { AgentDefaultsConfig } from "./types.agent-defaults.js";
import type { HumanDelayConfig, IdentityConfig } from "./types.base.js";
import type { GroupChatConfig } from "./types.messages.js";
import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.sandbox.js";
import type { AgentToolsConfig, MemorySearchConfig } from "./types.tools.js";

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
  /** Short agent-specific role prompt appended as a dedicated system section. */
  systemPrompt?: string;
  /** Legacy/custom params bag; `params.system` is supported as a compatibility alias. */
  params?: Record<string, unknown> & { system?: string };
  workspace?: string;
  agentDir?: string;
  model?: AgentModelConfig;
  /** Optional allowlist of skills for this agent (omit = all skills; empty = none). */
  skills?: string[];
  memorySearch?: MemorySearchConfig;
  /** Human-like delay between block replies for this agent. */
  humanDelay?: HumanDelayConfig;
  /** Optional per-agent heartbeat overrides. */
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  subagents?: {
    /** Allow spawning sub-agents under other agent ids. Use "*" to allow any. */
    allowAgents?: string[];
    /** Per-agent default model for spawned sub-agents (string or {primary,fallbacks}). */
    model?: string | { primary?: string; fallbacks?: string[] };
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
  tools?: AgentToolsConfig;
};

export type AgentRoutingAliasConfig = {
  /** Canonical target agent id. */
  agentId: string;
  /** Accepted @alias values for direct routing. */
  aliases?: string[];
  /** Optional human-readable description. */
  description?: string;
  /** Optional routing hints / keywords for maintainers. */
  routingHints?: string[];
};

export type AgentOrchestrationPolicyConfig = {
  defaultBehavior?: "orchestrate";
  fallbackBehavior?: "self-answer";
  directRoutingMode?: "hint" | "force";
  allowMultiAgentDelegation?: boolean;
  preserveUserVisibleSingleChat?: boolean;
};

export type AgentOrchestrationCommunicationConfig = {
  allowDirectSpecialistToSpecialist?: boolean;
  requireStructuredHandoff?: boolean;
  requireStructuredReturn?: boolean;
  allowParallelDelegation?: boolean;
};

export type AgentOrchestrationLimitsConfig = {
  maxDelegationDepth?: number;
  maxAgentsPerRequest?: number;
  dedupeRepeatedHandoffs?: boolean;
  stopWhenNoNewInformation?: boolean;
};

export type AgentOrchestrationEnvelopeConfig = {
  enabled?: boolean;
};

export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
  orchestration?: {
    routingAliases?: AgentRoutingAliasConfig[];
    policy?: AgentOrchestrationPolicyConfig;
    communication?: AgentOrchestrationCommunicationConfig;
    limits?: AgentOrchestrationLimitsConfig;
    handoffEnvelope?: AgentOrchestrationEnvelopeConfig;
    responseEnvelope?: AgentOrchestrationEnvelopeConfig;
  };
};

export type AgentBinding = {
  agentId: string;
  match: {
    channel: string;
    accountId?: string;
    peer?: { kind: ChatType; id: string };
    guildId?: string;
    teamId?: string;
    /** Discord role IDs used for role-based routing. */
    roles?: string[];
  };
};
