import type { MessageReactionSummary } from "@openclaw/gateway-protocol";
import type { ControlUiBootstrapConfig } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import type {
  AgentsListResult,
  ModelCatalogEntry,
  UpdateAvailable,
  UpdateScheduleState,
} from "../api/types.ts";
import type { AuthenticatedUser } from "../app/user-profile.ts";
import type { ControlUiMockAuth } from "./control-ui-mock-auth.ts";
import type { ControlUiMockPresenceScenario } from "./control-ui-mock-presence.ts";
import type { NativeControlUiPluginFixture } from "./control-ui-plugin-fixture.ts";
import type {
  createControlUiSessionFixtures,
  ControlUiSessionFixture,
} from "./control-ui-session-fixtures.ts";

export type ControlUiMockPresenceUser = AuthenticatedUser & {
  self?: boolean;
  deviceFamily?: string;
  host?: string;
  ip?: string;
  instanceId?: string;
  lastInputSeconds?: number;
  onlineSince?: number;
  lastActivityAt?: number;
  timeZone?: string;
  mode?: string;
  platform?: string;
  ts?: number;
  watchedSessions?: string[];
};

export type MockGatewayRequest = {
  id: string;
  method: string;
  params?: unknown;
};

export interface ControlUiMockGatewayScenario
  extends ControlUiMockAuth, ControlUiMockPresenceScenario {
  bootstrapPreferences?: ControlUiBootstrapConfig["preferences"];
  /** Auto-wait for sidebar rosters unless startup is held or connect fails; true overrides those skips, false disables the wait. */
  awaitInitialRoster?: boolean;
  nativePlugins?: readonly NativeControlUiPluginFixture[];
  pluginAssetsRequireAuth?: boolean;
  attachmentMaxBytes?: number;
  agentModel?: string | null;
  assistantAgentId?: string;
  assistantName?: string;
  automaticallyFetchFavicons?: boolean;
  communityInvite?: boolean;
  basePath?: string;
  controlUiTabs?: Array<{
    group?: string;
    icon?: string;
    id: string;
    label: string;
    path?: string;
    placement?: string;
    pluginId: string;
    slug?: string;
  }>;
  controlUiLinkReaders?: unknown[];
  controlUiWidgetKinds?: Array<{
    kind: string;
    label: string;
    pluginId: string;
  }>;
  allowedSessionVisibilities?: Array<"shared" | "read-only" | "suggest" | "draft">;
  hasMultipleSessionSharingIdentities?: boolean;
  featureCapabilities?: string[];
  connectCapabilities?: string[];
  defaultAgentId?: string;
  deferredMethods?: string[];
  deferredRequests?: MockGatewayRequestSelector[];
  /** Hold every request until resolveDeferred/rejectDeferred releases the method. */
  heldMethods?: string[];
  /** Hold only requests matching these method and parameter selectors. */
  heldRequests?: MockGatewayRequestSelector[];
  /** Fail each admission-dependent read this many times before serving its normal response. */
  startupPendingResponses?: number;
  /** Non-release gateway checkout branch surfaced in the sidebar footer. */
  devGitBranch?: string;
  /** Exact immutable Control UI artifact served by the mocked Gateway. */
  serverBuildId?: string;
  /** Exact Gateway lifecycle generation served in hello. */
  gatewayBootId?: string;
  gatewaySuspensionPhase?: "accepting" | "preparing" | "draining" | "prepared";
  /** Optional startup update snapshot for rich local mock fixtures. */
  updateAvailable?: UpdateAvailable | null;
  /** Optional automatic-update campaign snapshot for rich local mock fixtures. */
  updateSchedule?: UpdateScheduleState | null;
  controlUiBuildSource?: "bundled" | "configured";
  serverVersion?: string;
  featureEvents?: string[];
  featureMethods?: string[];
  /** Simulate a legacy Gateway that predates the advertised method catalog. */
  omitFeatureMethods?: boolean;
  historyMessages?: unknown[];
  /** Disable only for scenarios exercising the separate chat.startup fallback. */
  subscriptionInitialHistory?: boolean;
  sessionReactions?: Record<string, Record<string, MessageReactionSummary[]>>;
  /** Canonical per-session transcripts, shared by history and startup reads. */
  sessionTranscripts?: Record<
    string,
    {
      messages: unknown[];
      thinkingLevel?: string | null;
      inFlightRun?: ControlUiMockGatewayScenario["inFlightRun"];
    }
  >;
  maxPayload?: number;
  /** Static payloads, parameter-matched cases, or call-ordered sequences. */
  methodResponses?: Record<string, unknown>;
  /** URL prefixes that retain the browser's real WebSocket transport. */
  webSocketPassthroughPrefixes?: string[];
  /** Replayed in-flight run snapshot served by chat.history and chat.startup. */
  inFlightRun?: {
    runId: string;
    text?: string;
    startedAt?: number;
    events?: unknown[];
    plan?: unknown;
  } | null;
  /** Subscription-scoped Gateway events replayed on a fixed browser-side cycle. */
  repeatingSessionEvents?: {
    events: Array<{ event: "agent" | "session.observer" | "session.tool"; payload: unknown }>;
    intervalMs?: number;
  };
  /** Explicit history-only row override, for example a stale run-state projection. */
  sessionInfo?: Record<string, unknown> | null;
  /** Canonical fixture rows, independent of case/sequence/deferred wire overrides. */
  sessions?: ControlUiSessionFixture[];
  /** Partition sessions.list fixtures by archived state after applying patches. */
  sessionArchiveFiltering?: boolean;
  models?: ModelCatalogEntry[];
  /** Selected fixture and event default; use controlUiSessionUrl to select it in the UI. */
  sessionKey?: string;
  sessionScope?: AgentsListResult["scope"];
  mainSessionKey?: string;
  /** Initial gateway-owned custom group catalog (sessions.groups.*), in order. */
  sessionGroups?: string[];
  /** Optional New Session defaults keyed by custom group name. */
  sessionGroupDefaults?: Record<string, { cwd?: string; worktree?: boolean }>;
  terminalEnabled?: boolean;
  cliAgentsEnabled?: boolean;
  workspace?: string;
  workspaceGit?: boolean;
}

export type ControlUiMockGatewayInstallOptions = {
  requestHandlers?: Record<string, (params: unknown) => unknown>;
  /** Run probes after the mock WebSocket is installed, in the same init script. */
  afterInitScript?: string;
};

export type MockGatewayRequestSelector = {
  method: string;
  match?: Record<string, unknown>;
  exactParams?: boolean;
};
type RequestMatch = Omit<MockGatewayRequestSelector, "method">;

type MockSessionsListResponse = { sessions: unknown[]; [field: string]: unknown };

type AsyncMethod<T> = T extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never;

export type MockGatewayControls = {
  [K in keyof GatewayMethods]: AsyncMethod<GatewayMethods[K]>;
} & {
  emitChatFinal: (params: { runId: string; sessionKey?: string; text: string }) => Promise<void>;
  emitGatewayEvent: AsyncMethod<ControlUiMockGateway["emit"]>;
  getRequests: AsyncMethod<ControlUiMockGateway["findRequests"]>;
  getSocketCount: AsyncMethod<ControlUiMockGateway["socketCount"]>;
  getSocketUrls: AsyncMethod<ControlUiMockGateway["socketUrls"]>;
  /** Without `after`, returns the latest prior match. Use the pre-action scoped
   * `getRequests(method, match)` count as `after` to wait for the next request. */
  waitForRequest: (
    method: string,
    options?: RequestMatch & { after?: number },
  ) => Promise<MockGatewayRequest>;
};

export type ControlUiMockRequestHandler = (request: {
  params: unknown;
  respond: (payload: unknown) => void;
  emit: (event: string, payload: unknown) => void;
}) => void;

type GatewayMethods = {
  closeLatest: (code?: number, reason?: string) => void;
  deliverLatest: (frame: unknown) => void;
  /** Returns the matching request count captured when deferral is armed. */
  deferNext: (
    method: string,
    match?: Record<string, unknown>,
    options?: { exactParams?: boolean },
  ) => number;
  getSessionRow: (key: string) => ControlUiSessionFixture;
  rejectDeferred: (
    method: string,
    error?: { code?: string; message?: string; details?: unknown; retryable?: boolean },
    options?: RequestMatch,
  ) => void;
  resolveDeferred: (method: string, payload?: unknown, options?: RequestMatch) => void;
  suspendLatest: () => void;
  setOnline: (online: boolean) => void;
  setGatewayBootId: (bootId: string) => void;
  setServerBuildId: (buildId: string) => void;
  setOperatorScopes: (scopes: string[]) => void;
  setHistoryMessages: (messages: unknown[]) => void;
  setMethodResponse: (method: string, payload: unknown) => void;
  setSessionsListResponse: (payload: MockSessionsListResponse) => void;
  setSessionSharingPolicy: (policy: {
    allowedSessionVisibilities: Array<"shared" | "read-only" | "suggest" | "draft">;
    hasMultipleSessionSharingIdentities: boolean;
  }) => void;
};

export type ControlUiMockGateway = GatewayMethods & {
  /** Commit one fixture-owned visibility change without replacing the canonical roster. */
  setSessionVisibility: ReturnType<typeof createControlUiSessionFixtures>["setVisibility"];
  readonly online: boolean;
  requests: MockGatewayRequest[];
  emit: (event: string, payload?: unknown) => void;
  findRequests: (
    method?: string,
    match?: Record<string, unknown>,
    options?: { exactParams?: boolean },
  ) => MockGatewayRequest[];
  setRequestHandler: (method: string, handler: ControlUiMockRequestHandler) => void;
  socketCount: () => number;
  socketStates: () => Array<{ readyState: number; state: string; url: string }>;
  socketUrls: () => string[];
};
export type MockGatewayWindow = Window & {
  __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
  openclawControlUiE2eGateway?: ControlUiMockGateway;
};
