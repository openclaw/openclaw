import type { SessionCatalogPullRequestSummary } from "../../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { BootRecord } from "../../app/boot-record.ts";
import type { ConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import type { BootRoster } from "./session-boot-roster.ts";
import type { createSessionDeletions } from "./session-deletions.ts";
import type { createSessionGitHubPublication } from "./session-github-publication.ts";
import type { createSessionGroupCatalog } from "./session-group-catalog.ts";
import type { createSessionMutations } from "./session-mutations.ts";
import type { createSessionPermissionProjection } from "./session-permission-projection.ts";
import type { createSessionReconciliation } from "./session-reconciliation.ts";
import type { createSessionRosterRefresh } from "./session-roster-refresh.ts";
import type { SessionRunTerminal } from "./session-run-terminal.ts";
import type { createSessionScopedOperations } from "./session-scoped-operations.ts";
import type { createSessionThinkingClaims } from "./session-thinking-claims.ts";
import type {
  SessionConnectionScope,
  SessionRefreshOutcome,
  SessionState,
} from "./session-types.ts";

export type * from "./session-types.ts";

export type SessionCacheOptions = {
  bootRecord?: BootRecord | null;
  connectionBootstrap?: ConnectionBootstrapCoordinator;
};

export function createSessionState(
  bootRecord?: Pick<BootRecord, "groups" | "sectionOrder"> | null,
): SessionState {
  return {
    result: null,
    agentId: null,
    modelOverrides: {},
    loading: false,
    error: null,
    deletedSessions: [],
    groups: bootRecord?.groups.map((group) => group.name) ?? [],
    groupSettings: bootRecord?.groups ?? [],
    sectionOrder: bootRecord?.sectionOrder ?? [],
  };
}

type SessionRoster = ReturnType<typeof createSessionRosterRefresh>;
type SessionGroups = ReturnType<typeof createSessionGroupCatalog>;
type SessionGroupMethod = "load" | "status" | "invalidate" | "put" | "rename" | "update" | "delete";

/** Public operations come from their concrete owners; internal lifecycle methods stay private. */
export type SessionCapability = Pick<
  ReturnType<typeof createSessionMutations>,
  | "create"
  | "createResult"
  | "patch"
  | "patchMany"
  | "archiveVisibility"
  | "beginArchive"
  | "assignOwner"
  | "retireModelOverride"
  | "settingsPreview"
  | "patchRowLocal"
  | "isPreparedWorkSession"
  | "reset"
> &
  Omit<ReturnType<typeof createSessionScopedOperations>, "retireConnection" | "dispose"> &
  Pick<
    SessionRoster,
    | "list"
    | "listSnapshot"
    | "subscribeList"
    | "observeList"
    | "refreshList"
    | "refresh"
    | "refreshReplacement"
  > &
  Pick<ReturnType<typeof createSessionReconciliation>, "observeRow" | "captureReconcile"> &
  Pick<ReturnType<typeof createSessionDeletions>, "delete" | "deleteMany" | "deletionState"> & {
    [K in SessionGroupMethod as `groups${Capitalize<K>}`]: SessionGroups[K];
  } & {
    readonly githubPublication: Pick<ReturnType<typeof createSessionGitHubPublication>, "attach">;
    readonly state: SessionState;
    /** Broad observer outage, independent of query and operation errors. */
    readonly eventSubscriptionError: string | null;
    /** Current primary list failure, excluding mutation and observer errors. */
    readonly canonicalListError: string | null;
    /** Advances for every publication, including pending facts outside state. */
    readonly revision: number;
    /** Memory-only presentation; never authority for mutations or live row observations. */
    readonly presentation: Pick<SessionState, "result" | "agentId" | "resultCached"> & {
      profileId?: string | null;
    };
    /** Advances only when a canonical sessions.list result is published. */
    readonly canonicalListRevision: number;
    readonly canonicalListReady: boolean;
    /** Initial routing hints only; cached agent discovery never grants live authority. */
    readonly cachedRoutingDefaults?: {
      readonly mainKey: string;
      readonly scope: "per-sender" | "global";
    };
    whenCachedRosterSettled: () => Promise<void>;
    captureBootRoster: () => BootRoster | null;
    captureConnectionScope: () => SessionConnectionScope | null;
    isConnectionScopeCurrent: (scope: SessionConnectionScope) => boolean;
    describe: SessionRoster["observations"]["descriptions"]["describe"];
    /** Admits history through lifecycle fences; defaults-only never authorizes row publication. */
    reconcile: ReturnType<ReturnType<typeof createSessionReconciliation>["captureReconcile"]>;
    inheritRow: (
      row: GatewaySessionRow,
      previous: GatewaySessionRow | undefined,
      donor?: GatewaySessionRow,
    ) => GatewaySessionRow;
    projectRows: SessionRoster["observations"]["projectRows"];
    isRunVisuallyActive: (row: GatewaySessionRow) => boolean;
    reconcileRunTerminal: (terminal: SessionRunTerminal) => boolean;
    /** Schedules background list refreshes without replacing queued foreground queries. */
    invalidate: () => void;
    /** Reconciles an operation's agent without claiming the foreground query. */
    reconcileMutation: (agentId?: string | null) => Promise<SessionRefreshOutcome>;
    capturePermissionObservation: ReturnType<typeof createSessionPermissionProjection>["capture"];
    think: ReturnType<typeof createSessionThinkingClaims>["get"];
    pullRequestSummary: (key: string) => SessionCatalogPullRequestSummary | undefined;
    capturePullRequestEpoch: (key: string) => object;
    setPullRequestSummary: (
      key: string,
      summary: SessionCatalogPullRequestSummary | undefined,
      epoch?: object,
    ) => void;
    subscribeCreated: (listener: (key: string) => void) => () => void;
    subscribe: (listener: (state: SessionState) => void) => () => void;
    dispose: () => void;
  };
