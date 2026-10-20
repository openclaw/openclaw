import type { AuthenticatedUser } from "../app/user-profile.ts";
import type { ControlUiSessionFixture } from "./control-ui-session-fixtures.ts";

export type ControlUiMockPresenceUser = {
  self?: boolean;
  id: string;
  identity?: AuthenticatedUser["identity"];
  name?: string;
  email?: string;
  avatarUrl?: string;
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

export type MockGatewayRequestSelector = {
  method: string;
  match?: Record<string, unknown>;
  exactParams?: boolean;
};

type MockSessionsListResponse = { sessions: unknown[]; [field: string]: unknown };

type AsyncMethod<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<ReturnType<T>>;

type SharedGatewayMethod = Exclude<
  keyof ControlUiMockGateway,
  | "online"
  | "requests"
  | "emit"
  | "findRequests"
  | "setRequestHandler"
  | "socketCount"
  | "socketStates"
  | "socketUrls"
>;

/** Browser controls preserve the in-page method signatures across the async boundary. */
export type MockGatewayControls = {
  [K in SharedGatewayMethod]: AsyncMethod<ControlUiMockGateway[K]>;
} & {
  emitChatFinal: (params: { runId: string; sessionKey?: string; text: string }) => Promise<void>;
  emitGatewayEvent: AsyncMethod<ControlUiMockGateway["emit"]>;
  getRequests: AsyncMethod<ControlUiMockGateway["findRequests"]>;
  getSocketCount: AsyncMethod<ControlUiMockGateway["socketCount"]>;
  getSocketUrls: AsyncMethod<ControlUiMockGateway["socketUrls"]>;
  /**
   * Resolves with a captured request for `method`. Without `after` this is
   * satisfied by ANY prior request of the method (and returns the latest), so
   * a second same-method wait can return a stale earlier request on slow
   * runners; pass `after` = the pre-action count from `getRequests(method, match)`
   * to wait for and return the next new request in that same parameter scope.
   */
  waitForRequest: (
    method: string,
    options?: { after?: number; match?: Record<string, unknown>; exactParams?: boolean },
  ) => Promise<MockGatewayRequest>;
};

export type ControlUiMockRequestHandler = (request: {
  params: unknown;
  respond: (payload: unknown) => void;
  emit: (event: string, payload: unknown) => void;
}) => void;

export type ControlUiMockGateway = {
  readonly online: boolean;
  closeLatest: (code?: number, reason?: string) => void;
  deliverLatest: (frame: unknown) => void;
  /** Returns the matching request count captured when deferral is armed. */
  deferNext: (
    method: string,
    match?: Record<string, unknown>,
    options?: { exactParams?: boolean },
  ) => number;
  emit: (event: string, payload?: unknown) => void;
  findRequests: (
    method?: string,
    match?: Record<string, unknown>,
    options?: { exactParams?: boolean },
  ) => MockGatewayRequest[];
  getSessionRow: (key: string) => ControlUiSessionFixture;
  rejectDeferred: (
    method: string,
    error?: { code?: string; message?: string; details?: unknown; retryable?: boolean },
    options?: { match?: Record<string, unknown>; exactParams?: boolean },
  ) => void;
  requests: MockGatewayRequest[];
  resolveDeferred: (
    method: string,
    payload?: unknown,
    options?: { match?: Record<string, unknown>; exactParams?: boolean },
  ) => void;
  suspendLatest: () => void;
  setOnline: (online: boolean) => void;
  setGatewayBootId: (bootId: string) => void;
  setServerBuildId: (buildId: string) => void;
  setOperatorScopes: (scopes: string[]) => void;
  setHistoryMessages: (messages: unknown[]) => void;
  setMethodResponse: (method: string, payload: unknown) => void;
  setSessionsListResponse: (payload: MockSessionsListResponse) => void;
  setRequestHandler: (method: string, handler: ControlUiMockRequestHandler) => void;
  setSessionSharingPolicy: (policy: {
    allowedSessionVisibilities: Array<"shared" | "read-only" | "suggest" | "draft">;
    hasMultipleSessionSharingIdentities: boolean;
  }) => void;
  socketCount: () => number;
  socketStates: () => Array<{ readyState: number; state: string; url: string }>;
  socketUrls: () => string[];
};
export type MockGatewayWindow = Window & {
  __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
  openclawControlUiE2eGateway?: ControlUiMockGateway;
};
