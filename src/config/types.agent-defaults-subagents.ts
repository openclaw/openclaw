import type { SubagentAnnounceTarget } from "../agents/subagent-announce-target.js";
import type { SubagentDelegationMode } from "./types.agent-defaults.js";
import type { AgentModelConfig } from "./types.agents-shared.js";

export type AgentDefaultsSubagentsConfig = {
  /** Prompt-only guidance for how strongly the main agent should delegate work. Default: "suggest". */
  delegationMode?: SubagentDelegationMode;
  /** Default allowlist of target agent ids for sessions_spawn. Use "*" to allow any configured target. */
  allowAgents?: string[];
  /** Max concurrent sub-agent runs (global lane: "subagent"). Default: 8. */
  maxConcurrent?: number;
  /** Maximum depth allowed for sessions_spawn chains. Default behavior: 1 (no nested spawns). */
  maxSpawnDepth?: number;
  /** Maximum active children a single requester session may spawn. Default behavior: 5. */
  maxChildrenPerAgent?: number;
  /** Auto-archive sub-agent sessions after N minutes (default: 60, set 0 to disable). */
  archiveAfterMinutes?: number;
  /** Default model selection for spawned sub-agents (string or {primary,fallbacks}). */
  model?: AgentModelConfig;
  /** Default thinking level for spawned sub-agents (e.g. "off", "low", "medium", "high"). */
  thinking?: string;
  /** Default run timeout in seconds for spawned sub-agents (0 = no timeout). */
  runTimeoutSeconds?: number;
  /** Gateway timeout in ms for sub-agent announce delivery calls (default: 120000). */
  announceTimeoutMs?: number;
  /** Default completion routing for native sub-agents. Default: "channel". */
  announceTarget?: SubagentAnnounceTarget;
  /** Require explicit agentId in sessions_spawn (no default same-as-caller). Default: false. */
  requireAgentId?: boolean;
};
