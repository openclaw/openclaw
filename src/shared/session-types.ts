import type {
  AgentSummary,
  ModelChoice,
  SessionCreatedActor,
  SessionPerson,
  SessionOwnerSessionCount,
  SessionsAssignOwnerParams,
} from "../../packages/gateway-protocol/src/index.js";

/** Runtime selection metadata for an agent row. */
export type GatewayAgentRuntime = NonNullable<AgentSummary["agentRuntime"]>;

/** Thinking-level option exposed to UI clients. */
export type GatewayThinkingLevelOption = NonNullable<AgentSummary["thinkingLevels"]>[number];

export type GatewayContextWindowOption = NonNullable<ModelChoice["contextWindows"]>[number];

export type GatewayAgentKind = NonNullable<AgentSummary["kind"]>;

/** Assignable identity returned by the complete session-owner facet. */
export type SessionOwnerFacetIdentity = SessionsAssignOwnerParams["owner"] &
  Pick<SessionCreatedActor, "label" | "avatarUrl" | "identity">;

/** Per-session Control UI face preference carried by session list rows. */
export type SessionBoardFace = "chat" | "dashboard";

/** Common agent row shape used by session list responses. */
export type GatewayAgentRow = Pick<
  AgentSummary,
  | "id"
  | "status"
  | "admissionRefusal"
  | "kind"
  | "name"
  | "identity"
  | "workspace"
  | "workspaceGit"
  | "model"
  | "utilityModel"
  | "agentRuntime"
  | "thinkingLevels"
  | "thinkingOptions"
  | "thinkingDefault"
  | "defaultPermissionMode"
>;

export type SessionActivityPulse = {
  since: number;
  until: number;
  /** Counts between consecutive caller-supplied boundaries. */
  buckets: number[];
  sessions: number;
  /** Sessions created within `activeMinutes`; omitted for an unbounded time filter. */
  started?: number;
  /** Sessions with an active run anywhere in the filtered set. */
  running: number;
  people?: number;
};

/** Generic base for paged session-list responses. */
export type SessionsListResultBase<TDefaults, TRow> = {
  ts: number;
  path: string;
  count: number;
  totalCount?: number;
  limitApplied?: number;
  offset?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
  /** Complete owner facet for the filtered result, independent of pagination. */
  owners?: SessionOwnerFacetIdentity[];
  /** Complete visible open/running ownership summary, before pagination. */
  ownerSessionCounts?: SessionOwnerSessionCount[];
  people?: SessionPerson[];
  peopleIncomplete?: boolean;
  peopleSessionCount?: number;
  /** Earliest activeMinutes boundary among visible candidates, before person filters/pagination. */
  activityExpiresAt?: number;
  /** Window-wide statistics and caller-defined activity buckets, before pagination. */
  activityPulse?: SessionActivityPulse;
  /** Canonical profile selected by the person-association filter. */
  involvingProfileId?: string;
  defaults: TDefaults;
  /** Response-local display facts referenced by rows that opted into sharing. */
  sharedFacts?: Partial<TRow>[];
  /** Opaque identity of the authorized row vector, independent of list facets. */
  rowsRevision?: string;
  /** Only the rows are omitted; counts, defaults and facets remain current. */
  rowsUnchanged?: true;
  /** Complete window indexes into the base rows followed by this response's changed rows. */
  rowsDelta?: { baseRevision: string; order: number[] };
  sessions: TRow[];
};

/** Generic base for successful session patch responses. */
export type SessionsPatchResultBase<TEntry> = {
  ok: true;
  path: string;
  key: string;
  entry: TEntry;
};
