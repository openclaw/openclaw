import type { ProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { InheritedToolPolicyV2 } from "../agents/inherited-tool-policy.schema.js";

export type AgentRuntimeInheritedToolPolicy =
  | { version: 1; allow: string[]; deny: string[] }
  | { version: 2; policy: InheritedToolPolicyV2 };

/** Automatic intent bound to the complete request before creation resolves aliases. */
export type AgentRuntimeSpawnModelAutoSelection = {
  model: string;
  /** Self-origin distinguishes configured selection from legacy fallback residue. */
  hasFallbackOrigin: boolean;
};

export type AgentRuntimeSessionSpawnContext = {
  /** Host-verified human requester; inherited ownership still requires a matching parent owner. */
  requesterProfileId?: string;
  completionOwnerSessionKey?: string;
  resolvedModel?: ProviderModelRef;
  inheritedToolPolicy: AgentRuntimeInheritedToolPolicy;
  spawnModelAutoSelection?: AgentRuntimeSpawnModelAutoSelection;
};
