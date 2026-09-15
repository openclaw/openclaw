import type { ProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";

export type AgentRuntimeSessionSpawnContext = {
  completionOwnerSessionKey?: string;
  resolvedModel?: ProviderModelRef;
  inheritedToolPolicy: {
    version: 1;
    allow: string[];
    deny: string[];
  };
};
