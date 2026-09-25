import type { z } from "zod";
// Defines agent routing, model, and runtime configuration types.
import type {
  AgentContextLimitsConfig,
  AgentDefaultsConfig,
  AgentModelEntryConfig,
} from "./types.agent-defaults.js";
import type { AgentSandboxConfig } from "./types.agents-shared.js";
import type { HumanDelayConfig, IdentityConfig } from "./types.base.js";
import type { MemorySearchConfig } from "./types.memory.js";
import type { GroupChatConfig } from "./types.messages.js";
import type { SkillsLimitsConfig } from "./types.skills.js";
import type { AgentToolsConfig } from "./types.tools.js";
import type { TtsConfig } from "./types.tts.js";
import type { AgentEntryBaseSchema } from "./zod-schema.agent-entry-base.js";
import type { BindingsSchema } from "./zod-schema.agents.js";
type SchemaAgentBinding = NonNullable<z.input<typeof BindingsSchema>>[number];

export type AgentRuntimeAcpConfig = NonNullable<
  Extract<AgentRuntimeConfig, { type: "acp" }>["acp"]
>;

export type AgentRuntimeConfig = NonNullable<z.input<typeof AgentEntryBaseSchema>["runtime"]>;

export type AgentBindingMatch = AgentRouteBinding["match"];

export type AgentRouteBinding = Extract<SchemaAgentBinding, { type?: "route" }>;

export type AgentAcpBinding = Extract<SchemaAgentBinding, { type: "acp" }>;

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
