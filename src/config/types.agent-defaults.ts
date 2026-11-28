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
  /** @deprecated Doctor input only; proactive checks are ordinary automation jobs. */
  heartbeat?: LegacyHeartbeatConfig;
  sandbox?: AgentSandboxConfig;
};
export type AgentCompactionMode = NonNullable<AgentCompactionConfig["mode"]>;
export type AgentCompactionIdentifierPolicy = NonNullable<
  AgentCompactionConfig["identifierPolicy"]
>;
export type AgentCompactionConfig = NonNullable<SchemaAgentDefaultsConfig["compaction"]>;

/** July 2026+ input for the one-way Heartbeat to Automations Doctor migration. */
export type LegacyHeartbeatConfig = {
  agentId?: string;
  every?: string;
  activeHours?: {
    start?: string;
    end?: string;
    timezone?: string;
  };
  model?: string;
  session?: string;
  target?: string;
  directPolicy?: "allow" | "block";
  to?: string;
  accountId?: string;
  prompt?: string;
  timeoutSeconds?: number;
  lightContext?: boolean;
  isolatedSession?: boolean;
};
