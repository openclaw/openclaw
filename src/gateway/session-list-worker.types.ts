import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { SubagentRunReadSnapshot } from "../agents/subagents/registry/subagent-registry-queries.js";
import type { SubagentRunReadRecord } from "../agents/subagents/registry/subagent-registry-read.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UserProfileDisplay } from "../state/user-profiles.types.js";
import type {
  SessionEntrySelection,
  resolveSessionListSearchModelIdentity,
} from "./session-list-filters.js";
import type { SessionListModelFactsLookup } from "./session-list-target.js";
import type { SessionListVisibility } from "./session-list-visibility.js";
import type { Lookup, SelectionRow } from "./session-row-projection-record.js";
import type { createSessionRowSelection } from "./session-row-selection.js";
import type {
  SessionListActiveRunProjector,
  SessionListRowContext,
} from "./session-utils-contracts.js";

export type SessionListWorkerRow = Omit<SelectionRow, "generation">;
export type SessionListWorkerChange = {
  id: string;
  key: string;
  agentId: string;
  row: SessionListWorkerRow | undefined;
};

/** Only owner publications replace retained facts; page requests carry no resident roster. */
export type SessionListWorkerUpdate = {
  cfg?: OpenClawConfig;
  reset?: SessionListWorkerRow[];
  changes?: SessionListWorkerChange[];
  profiles?: ReadonlyMap<string, UserProfileDisplay>;
  subagentRuns?: SubagentRunReadSnapshot<SubagentRunReadRecord>;
  projectedAgentRuns?: SessionListRowContext["projectedAgentRuns"];
  projectedSubagentActivity?: ReadonlySet<string>;
};

export type SessionListWorkerRequest = {
  opts: SessionsListParams;
  now: number;
  scopeId: string;
  scope: Parameters<typeof createSessionRowSelection>[1];
  key?: string;
  candidateRowIds?: ReadonlySet<string>;
  visibility: SessionListVisibility;
  restrictProfileReferences: boolean;
  actorId?: string;
  /** Sparse current live states, keyed by physical row identity after host authorization. */
  projectActiveRun: boolean;
  activeRuns: ReadonlyMap<string, ReturnType<SessionListActiveRunProjector>>;
  identityNames?: ReadonlyMap<string, string>;
  searchRows?: ReadonlyMap<
    string,
    {
      modelFacts: ReturnType<SessionListModelFactsLookup>;
      modelIdentity: ReturnType<typeof resolveSessionListSearchModelIdentity>;
    }
  >;
};

export type SessionListWorkerResult = {
  selection: Omit<SessionEntrySelection, "entries" | "ownerSessionProfiles">;
  queries: Lookup[];
  archivedRowIds: string[];
  keys: string[];
  storePath: string;
};
