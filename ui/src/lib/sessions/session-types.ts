import type { GatewaySessionMessageSubscription } from "@openclaw/gateway-client/browser";
import type {
  PreservedSessionWorktree,
  SessionsDeleteResult,
  SessionsListParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { SchemaContract } from "../../../../packages/gateway-protocol/src/schema-contract.js";
import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type {
  ApplicationGateway,
  ApplicationGatewayPhase,
  ApplicationGatewaySnapshot,
} from "../../app/gateway.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import type { GatewayConnectionScope } from "../gateway-connection-lifecycle.ts";
import type { SessionGroupSettings } from "./custom-groups.ts";
import type { GitHubPublicationPresentationBinding } from "./github-publication-owner.ts";
import type { SessionArchivedFilter } from "./navigation.ts";
import type { SessionChangedRowResult } from "./session-row-reconcile.ts";

export type SessionState = {
  result: SessionsListResult | null;
  resultCached?: boolean;
  agentId: string | null;
  modelOverrides: Readonly<Record<string, string | null>>;
  loading: boolean;
  error: string | null;
  startupPending?: boolean;
  deletedSessions: readonly SessionDeletionFact[];
  /** Gateway-owned custom group catalog in display order. */
  groups: readonly string[];
  /** New Session defaults associated with each gateway-owned group. */
  groupSettings: readonly SessionGroupSettings[];
  /** Gateway-owned sidebar section order; pinned is intentionally absent. */
  sectionOrder: readonly string[];
};

type SessionDeletionFact = {
  key: string;
  agentId?: string;
  retireBeforeRevision: number;
};

export type SessionGroupMutationResult = "completed" | "stale";
export type SessionGroupDefaultsStatus = "idle" | "loading" | "ready" | "unavailable";

export type SessionListOptions = SchemaContract<
  Omit<
    SessionsListParams,
    | "source"
    | "activityPulseBoundaries"
    | "activeOnly"
    | "requireLastInteraction"
    | "sortBy"
    | "includeActivitySummary"
    | "label"
    | "projectId"
    | "workspaceDir"
    | "group"
    | "pinned"
    | "creatorId"
    | "profileRelation"
    | "involvingProfileId"
    | "includePeople"
    | "archived"
  >
> & {
  source?: SessionsListParams["source"];
  /** Physical read size for a managed window that needs every page enriched. */
  pageSize?: number;
  archivedFilter?: SessionArchivedFilter;
  append?: boolean;
};

export type SessionRefreshOptions = SessionListOptions & {
  force?: boolean;
  // Sidebar startup hydration must not block session creation or drop the open session.
  backgroundHydrate?: boolean;
};

export type SessionRefreshOutcome =
  | { status: "refreshed" | "stale" }
  | { status: "failed"; error: string };

export type SessionListScope = Readonly<Omit<SessionListOptions, "offset" | "append">>;

export type SessionListSnapshot = Pick<
  SessionState,
  "result" | "agentId" | "loading" | "error" | "startupPending"
> & {
  /** Outcome of the latest settled managed-list read, including suppressed availability errors. */
  readSucceeded?: boolean;
  /** Accepted server-window membership before local visibility and generation filters. */
  pagination?: Pick<SessionsListResult, "totalCount" | "hasMore" | "nextOffset"> & {
    count: number;
  };
};

export type SessionRowTarget = Readonly<{ key: string; agentId: string }>;

type SessionRowReadOutcome =
  | { status: "current"; row: GatewaySessionRow | null }
  | { status: "retired" };

export type SessionRowObservation = {
  readonly row: GatewaySessionRow | null;
  readonly sessionId: string | null;
  /** False until this owner accepts a row or confirms its absence. */
  readonly hasObserved: boolean;
  isCurrent: () => boolean;
  captureReconcile: () => (row: GatewaySessionRow | undefined) => SessionRowReadOutcome;
  dispose: () => void;
};

export type SessionRowEventListener = (
  event: GatewayEventFrame,
  /** Rejected generations can wake recovery but cannot mutate transcript or lifecycle state. */
  result: SessionChangedRowResult & { generationRejected?: true },
) => void;

export type SessionRowListener = (
  row: GatewaySessionRow | null,
  /** This retiring registration still owns delivery of the captured frame. */
  notification?: { eventPending: true },
) => void;

export type SessionDeleteOptions = {
  agentId?: string;
  deleteTranscript?: boolean;
  expectedSessionId?: string;
  archivedOnly?: boolean;
};

export type SessionDeleteTarget = SessionDeleteOptions & {
  key: string;
};

export type SessionDeleteOutcome = Pick<SessionsDeleteResult, "deleted" | "worktreePreserved">;

export type SessionDeleteBatchResult = {
  deleted: string[];
  errors: { target: SessionDeleteTarget; error: unknown }[];
  preservedWorktrees: PreservedSessionWorktree[];
};

export type SessionCompactResult = {
  ok?: boolean;
  compacted?: boolean;
  reason?: string;
  result?: { tokensBefore?: number; tokensAfter?: number };
};

export type SessionResetOptions = {
  agentId?: string | null;
};

export type SessionResetResult = "completed" | "not-started" | "uncertain";

export type SessionGateway = {
  defer?: ApplicationGateway["defer"];
  readonly connection?: { readonly gatewayUrl: string; readonly token?: string };
  readonly connectionRevision?: number;
  readonly snapshot: {
    client: GatewayBrowserClient | null;
    phase: ApplicationGatewayPhase;
    deferredIntentCount?: number;
    deferredIntentDraining?: boolean;
    restartPending?: boolean;
    suspensionPhase?: ApplicationGatewaySnapshot["suspensionPhase"];
    hello: GatewayHelloOk | null;
    assistantAgentId?: string | null;
    sessionKey?: string;
    selfUser?: AuthenticatedUser | null;
  };
  subscribe: (listener: (snapshot: SessionGateway["snapshot"]) => void) => () => void;
  subscribeEvents: (listener: (event: GatewayEventFrame) => void) => () => void;
};

export type SessionRequestClient = Pick<GatewayBrowserClient, "request">;

export type SessionConnectionScope = GatewayConnectionScope;

export type SessionConnectionOwner = {
  capture: () => SessionConnectionScope | null;
  isCurrent: (scope: SessionConnectionScope) => boolean;
};

export type SessionCreateReconciliation = "blocking" | "background";

export type SessionMessageSubscription = GatewaySessionMessageSubscription;
export type SessionArchiveVisibility = "pending" | "archived";

export type GitHubPublicationBinding = GitHubPublicationPresentationBinding & {
  matches: (row: GatewaySessionRow) => boolean;
};
