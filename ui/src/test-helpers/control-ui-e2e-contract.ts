import type { ControlUiSessionFixture } from "./control-ui-session-fixtures.ts";

export type MockGatewayRequest = {
  id: string;
  method: string;
  params?: unknown;
};

type MockSessionsListResponse = { sessions: unknown[]; [field: string]: unknown };

export type MockGatewayControls = {
  closeLatest: (code?: number, reason?: string) => Promise<void>;
  deliverLatest: (frame: unknown) => Promise<void>;
  deferNext: (method: string, match?: Record<string, unknown>) => Promise<void>;
  emitChatFinal: (params: { runId: string; sessionKey?: string; text: string }) => Promise<void>;
  emitGatewayEvent: (event: string, payload?: unknown) => Promise<void>;
  getRequests: (method?: string, match?: Record<string, unknown>) => Promise<MockGatewayRequest[]>;
  getSessionRow: (key: string) => Promise<ControlUiSessionFixture>;
  getSocketCount: () => Promise<number>;
  getSocketUrls: () => Promise<string[]>;
  rejectDeferred: (
    method: string,
    error?: { code?: string; message?: string; details?: unknown; retryable?: boolean },
  ) => Promise<void>;
  resolveDeferred: (method: string, payload?: unknown) => Promise<void>;
  suspendLatest: () => Promise<void>;
  setOnline: (online: boolean) => Promise<void>;
  setGatewayBootId: (bootId: string) => Promise<void>;
  setServerBuildId: (buildId: string) => Promise<void>;
  setOperatorScopes: (scopes: string[]) => Promise<void>;
  setHistoryMessages: (messages: unknown[]) => Promise<void>;
  setMethodResponse: (method: string, payload: unknown) => Promise<void>;
  setSessionsListResponse: (payload: MockSessionsListResponse) => Promise<void>;
  setSessionSharingPolicy: (policy: {
    allowedSessionVisibilities: Array<"shared" | "read-only" | "suggest" | "draft">;
    hasMultipleSessionSharingIdentities: boolean;
  }) => Promise<void>;
  /**
   * Resolves with a captured request for `method`. Without `after` this is
   * satisfied by ANY prior request of the method (and returns the latest), so
   * a second same-method wait can return a stale earlier request on slow
   * runners; pass `after` = the pre-action count from `getRequests(method, match)`
   * to wait for and return the next new request in that same parameter scope.
   */
  waitForRequest: (
    method: string,
    options?: { after?: number; match?: Record<string, unknown> },
  ) => Promise<MockGatewayRequest>;
};

export type ControlUiMockRequestHandler = (request: {
  params: unknown;
  respond: (payload: unknown) => void;
  emit: (event: string, payload: unknown) => void;
}) => void;

export type ControlUiMockGateway = {
  closeLatest: (code?: number, reason?: string) => void;
  deliverLatest: (frame: unknown) => void;
  deferNext: (method: string, match?: Record<string, unknown>) => void;
  emit: (event: string, payload?: unknown) => void;
  findRequests: (method?: string, match?: Record<string, unknown>) => MockGatewayRequest[];
  getSessionRow: (key: string) => ControlUiSessionFixture;
  rejectDeferred: (
    method: string,
    error?: { code?: string; message?: string; details?: unknown; retryable?: boolean },
  ) => void;
  requests: MockGatewayRequest[];
  resolveDeferred: (method: string, payload?: unknown) => void;
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
