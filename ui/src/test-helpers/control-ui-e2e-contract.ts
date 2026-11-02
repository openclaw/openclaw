import type { AuthenticatedUser } from "../app/user-profile.ts";
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
