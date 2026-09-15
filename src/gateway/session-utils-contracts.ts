import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { findModelCatalogEntry } from "../agents/model-catalog-lookup.js";
import type { selectModelCatalogRuntimeEntry } from "../agents/model-catalog-view.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { resolveSessionModelRef } from "../agents/session-model-ref.js";
import type { SubagentRunReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunReadRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { ThinkLevel, listThinkingLevelOptions } from "../auto-reply/thinking.js";
import type { SessionAcpMeta, SessionEntry } from "../config/sessions.js";
import type { GatewayStoredSessionTargets } from "../config/sessions/combined-store-gateway.js";
import type { SessionEntryReadSource } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProjectedAgentRunIndex } from "../infra/agent-run-registry.js";
import type { ModelCostConfig } from "../utils/usage-format.js";
import type { CurrentUserProfileDisplay } from "./current-user-profile-display.js";
import type { SessionListModelCatalog } from "./session-utils.types.js";

export type SessionSelectionScope =
  | { opts: SessionsListParams; targetsBySessionKey: GatewayStoredSessionTargets }
  | {
      opts: Omit<SessionsListParams, "search"> & { search?: never };
      targetsBySessionKey?: never;
    };

export type ListSessionsFromStoreParams = {
  cfg: OpenClawConfig;
  durableStorePath?: string;
  entryFilter?: (key: string, entry: SessionEntry) => boolean;
  storePath: string;
  store: Record<string, SessionEntry>;
  // Sentinels retain the first projected store's owner; their raw key cannot recover it.
  targetsBySessionKey: GatewayStoredSessionTargets;
  modelCatalog?: SessionListModelCatalog | ModelCatalogEntry[];
  opts: SessionsListParams;
  involvingActorId?: string;
  ownerFirstActorId?: string;
  projectActiveRun?: SessionListActiveRunProjector;
};

export type SessionListCpuTiming = {
  startSyncCpu: () => NodeJS.CpuUsage | undefined;
  finishSyncCpu: (
    metric: "prepareThreadCpuMs" | "rowThreadCpuMs",
    started: NodeJS.CpuUsage | undefined,
  ) => void;
};

export type GatewayModelThinkingProfile = {
  thinkingLevels: ReturnType<typeof listThinkingLevelOptions>;
  thinkingDefault?: ThinkLevel;
};

export type SessionActorProfileIdentity = Extract<CurrentUserProfileDisplay, { kind: "resolved" }>;

export type GatewaySessionModelSource = {
  entry: SessionEntry | undefined;
  loadSessionEntry: (key: string) => SessionEntry | undefined;
};

export type SessionListRowContext = {
  workerPlacementEnvironment?: NodeJS.ProcessEnv;
  projectedAgentRuns?: ProjectedAgentRunIndex;
  subagentRuns: SubagentRunReadIndex<SubagentRunReadRecord>;
  selectedModelByOverrideRef: Map<string, ReturnType<typeof resolveSessionModelRef>>;
  thinkingMetadataByModelRef: Map<string, GatewayModelThinkingProfile>;
  findModelCatalogEntry: typeof findModelCatalogEntry;
  selectModelCatalogRuntimeEntry: typeof selectModelCatalogRuntimeEntry;
  displayModelIdentityByKey: Map<string, { provider?: string; model?: string }>;
  modelCostConfigByModelRef: Map<string, ModelCostConfig | undefined>;
  userProfileIdentityById: Map<string, SessionActorProfileIdentity | undefined>;
  acpSessionMetaByEntry: Map<SessionEntry, SessionAcpMeta | undefined>;
};

export type SessionListRowContextProvider = () => SessionListRowContext;

export type GatewaySessionStoreTarget = {
  agentId: string;
  storePath: string;
  canonicalKey: string;
  storeKeys: string[];
};

export type GatewaySessionStoreTargetWithStore = GatewaySessionStoreTarget & {
  canonicalValidationError?: Error;
  store: Record<string, InternalSessionEntry>;
  readSource?: SessionEntryReadSource;
};

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
