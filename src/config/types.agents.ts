import type { ChatType } from "../channels/chat-type.js";
import type { AgentDefaultsConfig } from "./types.agent-defaults.js";
import type { AgentModelConfig, AgentSandboxConfig } from "./types.agents-shared.js";
import type { HumanDelayConfig, IdentityConfig } from "./types.base.js";
import type { GroupChatConfig } from "./types.messages.js";
import type { AgentToolsConfig, MemorySearchConfig } from "./types.tools.js";

export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
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
    model?: AgentModelConfig;
  };
  /** Optional per-agent sandbox overrides. */
  sandbox?: AgentSandboxConfig;
  tools?: AgentToolsConfig;
};

export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
};

export type AgentBinding = {
  agentId: string;
  comment?: string;
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
