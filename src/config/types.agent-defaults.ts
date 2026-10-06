import type { z } from "zod";
import type { AgentSandboxConfig } from "./types.agents-shared.js";
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
  sandbox?: AgentSandboxConfig;
};
export type AgentCompactionMode = NonNullable<AgentCompactionConfig["mode"]>;
export type AgentCompactionIdentifierPolicy = NonNullable<
  AgentCompactionConfig["identifierPolicy"]
>;
export type AgentCompactionConfig = NonNullable<SchemaAgentDefaultsConfig["compaction"]>;
