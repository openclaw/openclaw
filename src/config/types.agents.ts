import type { z } from "zod";
// Defines agent routing, model, and runtime configuration types.
import type { ChatType } from "../channels/chat-type.js";
import type {
  AgentContextLimitsConfig,
  AgentDefaultsConfig,
  AgentModelEntryConfig,
} from "./types.agent-defaults.js";
import type { AgentSandboxConfig } from "./types.agents-shared.js";
import type { DmScope, GroupScope, HumanDelayConfig, IdentityConfig } from "./types.base.js";
import type { MemorySearchConfig } from "./types.memory.js";
import type { GroupChatConfig } from "./types.messages.js";
import type { SkillsLimitsConfig } from "./types.skills.js";
import type { AgentToolsConfig } from "./types.tools.js";
import type { TtsConfig } from "./types.tts.js";
import type { AgentEntryBaseSchema } from "./zod-schema.agent-entry-base.js";

export type AgentRuntimeAcpConfig = {
  /** ACP harness adapter id (for example codex, claude). */
  agent?: string;
  /** Optional ACP backend override for this agent runtime. */
  backend?: string;
  /** Optional ACP session mode override. */
  mode?: "persistent" | "oneshot";
  /** Optional runtime working directory override. */
  cwd?: string;
};

export type AgentRuntimeConfig =
  | {
      type: "embedded";
    }
  | {
      type: "acp";
      acp?: AgentRuntimeAcpConfig;
    };

export type AgentBindingMatch = {
  channel: string;
  /**
   * Channel account to match.
   * - Omitted/empty: matches only the channel default account.
   * - "*": matches every account on the channel.
   * - Any other string: matches that specific account id.
   */
  accountId?: string;
  peer?: { kind: ChatType; id: string };
  guildId?: string;
  teamId?: string;
  /** Discord role IDs used for role-based routing. */
  roles?: string[];
};

export type AgentRouteBinding = {
  /** Missing type is interpreted as route for backward compatibility. */
  type?: "route";
  agentId: string;
  comment?: string;
  match: AgentBindingMatch;
  session?: {
    /** Optional session scoping override for conversations matched by this binding. */
    dmScope?: DmScope;
    groupScope?: GroupScope;
  };
};

export type AgentAcpBinding = {
  type: "acp";
  agentId: string;
  comment?: string;
  match: AgentBindingMatch;
  acp?: {
    mode?: "persistent" | "oneshot";
    label?: string;
    cwd?: string;
    backend?: string;
  };
};

export type AgentBinding = AgentRouteBinding | AgentAcpBinding;

export type AgentConfig = z.input<typeof AgentEntryBaseSchema> & {
  /** @deprecated Raw legacy list compatibility only; canonical agents.entries rejects this key. */
  default?: boolean;
  /**
   * @deprecated Legacy raw config accepted only by doctor/migration repair.
   * Normal schema parsing rejects this key; use per-model agentRuntime instead.
   */
  agentRuntime?: AgentModelEntryConfig["agentRuntime"];
  /** @deprecated Legacy per-agent compaction config is kept for raw doctor migration/repair. */
  compaction?: AgentDefaultsConfig["compaction"];
  memory?: {
    search?: MemorySearchConfig;
  };
  humanDelay?: HumanDelayConfig;
  typingMode?: AgentDefaultsConfig["typingMode"];
  tts?: TtsConfig & { prefsPath?: string };
  skillsLimits?: Pick<SkillsLimitsConfig, "maxSkillsPromptChars">;
  contextLimits?: AgentContextLimitsConfig;
  heartbeat?: Omit<NonNullable<AgentDefaultsConfig["heartbeat"]>, "agentId">;
  identity?: IdentityConfig;
  groupChat?: Omit<GroupChatConfig, "visibleReplies">;
  /** Optional per-agent sandbox overrides. */
  sandbox?: AgentSandboxConfig;
  tools?: AgentToolsConfig;
};

export type AgentEntryConfig = Omit<AgentConfig, "id">;

export type AgentsConfig = {
  ownership?: "explicit";
  defaults?: AgentDefaultsConfig;
  entries?: Record<string, AgentEntryConfig>;
  /** Internal non-serialized projection materialized by validation for ID-based runtime code. */
  list?: AgentConfig[];
};
