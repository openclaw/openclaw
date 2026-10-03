import type { z } from "zod";
import type { AgentDefaultsConfig, AgentModelEntryConfig } from "./types.agent-defaults.js";
import type { AgentSandboxConfig } from "./types.agents-shared.js";
import type { MemorySearchConfig } from "./types.memory.js";
import type { AgentToolsConfig } from "./types.tools.js";
import type { TtsConfig } from "./types.tts.js";
import type { AgentEntrySchema } from "./zod-schema.agent-runtime.js";
import type { BindingsSchema } from "./zod-schema.agents.js";
type SchemaAgentBinding = NonNullable<z.input<typeof BindingsSchema>>[number];

export type AgentBindingMatch = AgentRouteBinding["match"];

export type AgentRouteBinding = Extract<SchemaAgentBinding, { type?: "route" }>;

export type AgentAcpBinding = Extract<SchemaAgentBinding, { type: "acp" }>;

export type AgentBinding = AgentRouteBinding | AgentAcpBinding;

export type AgentConfig = Omit<
  z.input<typeof AgentEntrySchema>,
  "memory" | "tts" | "sandbox" | "tools"
> & {
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
  tts?: TtsConfig & { prefsPath?: string };
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
