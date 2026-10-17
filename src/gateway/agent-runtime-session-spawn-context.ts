import type { ProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { SessionEntry } from "../config/sessions/types.js";

/** Automatic intent bound to the complete request before creation resolves aliases. */
export type AgentRuntimeSpawnModelAutoSelection = {
  model: string;
  /** Self-origin distinguishes configured selection from legacy fallback residue. */
  hasFallbackOrigin: boolean;
};

export type AgentRuntimeSessionSpawnContext = {
  /** Host-verified human requester; inherited ownership still requires a matching parent owner. */
  requesterProfileId?: string;
  /** Trusted owner status of the spawning invocation, never synthetic child launch authority. */
  requesterSenderIsOwner?: boolean;
  completionOwnerSessionKey?: string;
  resolvedModel?: ProviderModelRef;
  inheritedPermissionMode?: SessionPermissionMode;
  inheritedToolPolicy: {
    version: 1;
    allow: string[];
    deny: string[];
    delegatedToolPolicy?: SessionEntry["delegatedToolPolicy"];
  };
  spawnModelAutoSelection?: AgentRuntimeSpawnModelAutoSelection;
};
