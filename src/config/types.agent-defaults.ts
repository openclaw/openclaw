import type { z } from "zod";
import type {
  AgentRuntimePolicyConfig,
  AgentSandboxConfig,
  AgentToolModelConfig,
} from "./types.agents-shared.js";
import type { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

type SchemaAgentDefaultsConfig = NonNullable<z.input<typeof AgentDefaultsSchema>>;

export type AgentContextInjection = NonNullable<SchemaAgentDefaultsConfig["contextInjection"]>;
export type OptionalBootstrapFileName = NonNullable<
  SchemaAgentDefaultsConfig["skipOptionalBootstrapFiles"]
>[number];
export type SubagentDelegationMode = NonNullable<
  NonNullable<SchemaAgentDefaultsConfig["subagents"]>["delegationMode"]
>;
export type ModelSelectionScope = NonNullable<SchemaAgentDefaultsConfig["modelSelectionScope"]>;
export type AgentThinkingLevel = NonNullable<SchemaAgentDefaultsConfig["thinkingDefault"]>;

export type AgentModelEntryConfig = NonNullable<SchemaAgentDefaultsConfig["models"]>[string];

export type AgentModelPolicyConfig = NonNullable<SchemaAgentDefaultsConfig["modelPolicy"]>;

export type AgentContextPruningConfig = NonNullable<SchemaAgentDefaultsConfig["contextPruning"]>;

export type AgentContextLimitsConfig = NonNullable<SchemaAgentDefaultsConfig["contextLimits"]>;

export type AgentDefaultsConfig = Omit<SchemaAgentDefaultsConfig, "sandbox"> & {
  /** @deprecated Doctor-only legacy input. */
  imageGenerationModel?: AgentToolModelConfig;
  /** @deprecated Doctor-only legacy input. */
  videoGenerationModel?: AgentToolModelConfig;
  /** @deprecated Doctor-only legacy input. */
  musicGenerationModel?: AgentToolModelConfig;
  /** @deprecated Doctor-only legacy input. */
  envelopeTimezone?: string;
  /** @deprecated Doctor-only legacy input. */
  envelopeTimestamp?: "on" | "off";
  /** @deprecated Doctor-only legacy input. */
  envelopeElapsed?: "on" | "off";
  /** @deprecated Doctor-only legacy input. */
  timeFormat?: "auto" | "12" | "24";
  /** @deprecated Doctor-only legacy input. */
  promptOverlays?: { gpt5?: { personality?: "friendly" | "on" | "off" } };
  /**
   * @deprecated Legacy raw config accepted only by doctor/migration repair.
   * Normal schema parsing rejects this key; use per-model agentRuntime instead.
   */
  agentRuntime?: AgentRuntimePolicyConfig;
  sandbox?: AgentSandboxConfig;
};
export type AgentCompactionMode = NonNullable<AgentCompactionConfig["mode"]>;
export type AgentCompactionIdentifierPolicy = NonNullable<
  AgentCompactionConfig["identifierPolicy"]
>;
export type AgentCompactionConfig = NonNullable<SchemaAgentDefaultsConfig["compaction"]>;
