import type { ProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";

/** Automatic intent bound to the complete request before creation resolves aliases. */
export type AgentRuntimeSpawnModelAutoSelection = {
  model: string;
  /** Self-origin distinguishes configured selection from legacy fallback residue. */
  hasFallbackOrigin: boolean;
};

export type AgentRuntimeSessionSpawnContext = {
  /** Canonical profile of this turn's direct human requester, verified by the host. */
  requesterProfileId?: string;
  completionOwnerSessionKey?: string;
  resolvedModel?: ProviderModelRef;
  inheritedToolPolicy: {
    version: 1;
    allow: string[];
    deny: string[];
  };
  spawnModelAutoSelection?: AgentRuntimeSpawnModelAutoSelection;
};
