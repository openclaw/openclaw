import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { findModelCatalogEntry } from "../agents/model-catalog-lookup.js";
import type { selectModelCatalogRuntimeEntry } from "../agents/model-catalog-view.js";
import type { resolveSessionModelRef } from "../agents/session-model-ref.js";
import type { SubagentRunReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunReadRecord } from "../agents/subagents/registry/subagent-registry-read.types.js";
import type {
  ThinkLevel,
  listThinkingLevelOptions,
  resolveThinkingProfile,
} from "../auto-reply/thinking.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { ProjectedAgentRunIndex } from "../infra/agent-run-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { ModelCostConfig } from "../utils/usage-format.js";
import type {
  SessionActorProfileIdentity,
  SessionIdentityProjection,
} from "./session-identity-projection.js";

export type { SessionActorProfileIdentity } from "./session-identity-projection.js";

export type GatewayModelThinkingProfile = {
  thinkingLevels: ReturnType<typeof listThinkingLevelOptions>;
  thinkingDefault?: ThinkLevel;
};

export type GatewayModelThinkingFacts = {
  profile: ReturnType<typeof resolveThinkingProfile>;
  metadata: GatewayModelThinkingProfile;
};

export type GatewaySessionModelSource = {
  entry: SessionEntry | undefined;
  readSourceEntry: (key: string) => SessionEntry | undefined;
};

export type SessionListRowContext = {
  identityProjection?: SessionIdentityProjection;
  workerPlacementEnvironment?: NodeJS.ProcessEnv;
  projectedAgentRuns?: ProjectedAgentRunIndex;
  projectedSubagentActivity?: ReadonlySet<string>;
  subagentRuns: SubagentRunReadIndex<SubagentRunReadRecord>;
  subagentRunsByChildSessionKey: ReadonlyMap<string, readonly SubagentRunReadRecord[]>;
  configuredDefaultModelByAgent: Map<string, ReturnType<typeof resolveSessionModelRef>>;
  thinkingFactsByModelRef: Map<string, GatewayModelThinkingFacts>;
  findModelCatalogEntry: typeof findModelCatalogEntry;
  selectModelCatalogRuntimeEntry: typeof selectModelCatalogRuntimeEntry;
  displayModelIdentityByKey: Map<
    string,
    {
      metadataSnapshot?: PluginMetadataSnapshot | null;
      identity: { provider?: string; model?: string };
    }
  >;
  modelCostConfigByModelRef: Map<string, ModelCostConfig | undefined>;
  userProfileIdentityById: Map<string, SessionActorProfileIdentity | undefined>;
};

export type SessionListRowContextProvider = () => SessionListRowContext;

export function createSessionRowModelCacheKey(
  provider: string | undefined,
  model: string | undefined,
) {
  return `${normalizeLowercaseStringOrEmpty(provider)}\0${normalizeOptionalString(model) ?? ""}`;
}

export type SessionListActiveRunProjector = (
  key: string,
  entry: SessionEntry,
  agentId: string,
) => { active: boolean; status?: "queued" };
