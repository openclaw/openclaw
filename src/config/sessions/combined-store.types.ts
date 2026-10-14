import type { AgentDatabaseDeletionSnapshot } from "../../state/agent-deletion-journal.types.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionEntryListScope, SessionEntrySummary } from "./session-accessor.types.js";
import type { SessionStoreReadCandidate } from "./session-store-read-candidates.js";
import type { SessionStoreTarget } from "./targets-collision.js";

export type GatewaySessionStoreDiscovery = {
  env: NodeJS.ProcessEnv;
  snapshot: AgentDatabaseDeletionSnapshot | undefined;
  readCandidates?: readonly SessionStoreReadCandidate[];
};

export type GatewaySessionEntryProjection = NonNullable<SessionEntryListScope["projection"]>;

export type GatewaySessionStoreOptions = {
  discovery?: GatewaySessionStoreDiscovery;
  agentId?: string;
  configuredAgentsOnly?: boolean;
  includeIncognito?: boolean;
  projection?: SessionEntryListScope["projection"];
  /** Keep per-agent sentinel rows distinct internally; public reads restore their raw key. */
  preserveSentinelOwners?: boolean | "physical";
  /** Durable stores may use resident entries; incognito retains its existing lifetime. */
  loadEntries?: (
    target: SessionStoreTarget,
    projection: GatewaySessionEntryProjection,
  ) => SessionEntrySummary[];
  onStoreLoaded?: (
    target: SessionStoreTarget,
    rowAgentId: string,
    discovery: { agentId: string; order: number } | null,
  ) => void;
};

export type ResolvedGatewaySessionStoreTargets = {
  groupDiscovery?: ReadonlyMap<string, { agentId: string; order: number }>;
  configuredAgentIds?: ReadonlySet<string>;
  defaultAgentId: string;
  diagnostics: readonly string[];
  durableStorePath?: string;
  durableTargets: ReadonlyArray<SessionStoreTarget>;
  incognitoTargets: ReadonlyArray<SessionStoreTarget>;
  physicalTargets: ReadonlyMap<string, SessionStoreTarget>;
  requestedAgentId?: string;
  preparedAgentIds?: Set<string>;
  sharedStoreRowOwner?: { agentId: string; target: SessionStoreTarget };
  storeConfig?: string;
};

export type PreparedCombinedSessionStore = {
  projection: GatewaySessionEntryProjection;
  targets: ResolvedGatewaySessionStoreTargets;
  reads: Array<{ target: SessionStoreTarget; storeTarget: SessionStoreTarget }>;
};

export type CombinedSessionStoreTopologyRequest = {
  config: OpenClawConfig;
  options: Omit<GatewaySessionStoreOptions, "loadEntries" | "onStoreLoaded"> & {
    discovery: GatewaySessionStoreDiscovery;
  };
  candidates: readonly SessionStoreReadCandidate[];
  scopeAgentIds?: readonly string[];
};

export type CombinedSessionStoreScopeTargets = ReadonlyMap<
  string,
  ResolvedGatewaySessionStoreTargets | Error
>;

export type CombinedSessionStoreTopologyResult = {
  kind: "combined-store-topology";
  prepared: PreparedCombinedSessionStore;
  scopes?: CombinedSessionStoreScopeTargets;
};
