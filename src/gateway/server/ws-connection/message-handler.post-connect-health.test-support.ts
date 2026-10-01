import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, onTestFinished, vi, type Mock } from "vitest";
import type { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../../../agents/admitted-run-context.js";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { mintAgentRuntimeIdentityToken } from "../../agent-runtime-identity-token.js";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "../../auth.js";
import type { HealthSummary } from "../../health/types.js";
import type { GatewayAttributedIngress } from "../../ingress-attribution.js";
import { getGatewayLocalUserIngress } from "../../local-user-ingress.js";
import { GatewayConnectionWork } from "../../server-connection-work.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "../../server-constants.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import { GatewayClientRegistry } from "../client-registry.js";
import { createGatewayWsTestLogger as createLogger } from "../ws-connection.test-helpers.js";
import { createOperatorWsClient } from "./authenticated-request-dispatch.test-support.js";
import { attachGatewayWsMessageHandler } from "./message-handler.js";
import { GatewayNodeLifecycleDispatchTracker } from "./node-lifecycle-dispatch.js";

export type CloseGatewayConnection = (code?: number, reason?: string) => void;
export type SetCloseCause = (cause: string, meta?: Record<string, unknown>) => void;

export const DEVICE_TOKEN_MUTATION_PARAMS = {
  deviceId: "device-1",
  role: "operator",
} as const satisfies Record<string, unknown>;
export const NODE_PAIR_REMOVE_PARAMS = {
  nodeId: "device-1",
} as const satisfies Record<string, unknown>;
export const BACKEND_CONNECT_PARAMS = {
  minProtocol: PROTOCOL_VERSION,
  maxProtocol: PROTOCOL_VERSION,
  client: {
    id: "gateway-client",
    version: "dev",
    platform: "test",
    mode: "backend",
  },
  role: "operator",
  caps: [],
} as const satisfies Record<string, unknown>;

export function captureSecurityEvents(): {
  events: Extract<DiagnosticEventPayload, { type: "security.event" }>[];
  stop: () => void;
} {
  const events: Extract<DiagnosticEventPayload, { type: "security.event" }>[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}

export function createCloseMock() {
  return vi.fn<CloseGatewayConnection>();
}

export function createBackendClient() {
  return { id: "gateway-client", version: "dev", platform: "test", mode: "backend" };
}

export function waitForFast(assertion: () => void | Promise<void>) {
  return vi.waitFor(assertion, { interval: 1 });
}

export async function createTestAgentRuntimeIdentityLease() {
  const prepared = prepareSystemAgentRunAdmission(
    {},
    "run-1",
    "ops",
    "message-handler.post-connect-health.test",
  );
  await prepared.admit("embedded");
  onTestFinished(prepared.close);
  return {
    close: prepared.close,
    token: await mintAgentRuntimeIdentityToken({
      agentId: "ops",
      sessionKey: "agent:ops:telegram:direct:alice",
      operationalRunInstance: prepared.operationalRunInstance,
    }),
  };
}

export function createSetCloseCauseMock() {
  return vi.fn<SetCloseCause>();
}

export function localUserIngressFor(client: unknown) {
  return typeof client === "object" && client !== null
    ? getGatewayLocalUserIngress(client)
    : undefined;
}

export function useGatewayTestConfig<T>(mock: Mock<() => T>, implementation: () => T) {
  const previous = mock.getMockImplementation();
  onTestFinished(() => {
    if (previous) {
      mock.mockImplementation(previous);
    }
  });
  mock.mockImplementation(implementation);
}

export function createHealthSummary(): HealthSummary {
  return {
    ok: true,
    ts: 1,
    durationMs: 1,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    defaultAgentId: "main",
    agents: [],
    sessions: { path: "", count: 0, recent: [] },
  };
}

export function createConnectedTestClient(params: {
  connId: string;
  invalidated?: boolean;
  invalidatedReason?: string;
}) {
  return {
    ...createOperatorWsClient({
      connId: params.connId,
      clientInfo: { id: "openclaw-control-ui", mode: "ui" },
      scopes: [],
    }),
    invalidated: params.invalidated ?? false,
    ...(params.invalidatedReason ? { invalidatedReason: params.invalidatedReason } : {}),
  };
}

function createGatewayAttachmentCompletion(connId: string, warnings: () => unknown) {
  const completion = createDeferred();
  void completion.promise.catch(() => {});
  return {
    promise: completion.promise,
    attached(callback?: () => void) {
      try {
        callback?.();
        completion.resolve();
      } catch (error) {
        completion.reject(error);
        throw error;
      }
    },
    closed(code?: number, reason?: string) {
      completion.reject(
        new Error(
          `Connection ${connId} closed before attachment: ${code ?? "no code"} ${reason ?? "no reason"}; warnings=${JSON.stringify(warnings())}`,
        ),
      );
    },
  };
}

const harnessCleanups: Array<() => Promise<void>> = [];
const fixtureGateReleases: Array<() => void> = [];
let harnessCleanupPromise: Promise<void> | undefined;

export function createGatewayHarnessGate<T = void>() {
  const gate = createDeferred<T>();
  // Cleanup can precede a mock's first call; cancel its gate without an unhandled rejection.
  void gate.promise.catch(() => {});
  fixtureGateReleases.push(() => gate.reject(new Error("Gateway test fixture closed")));
  return gate;
}

export function cleanupGatewayHarnesses() {
  // A native timeout can overlap afterEach with the state callback's finally.
  return (harnessCleanupPromise ??= Promise.resolve().then(async () => {
    for (const release of fixtureGateReleases.splice(0)) {
      release();
    }
    const results = await Promise.allSettled(harnessCleanups.splice(0).map((cleanup) => cleanup()));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Gateway test connections failed to close");
    }
  }));
}

beforeEach(() => {
  harnessCleanupPromise = undefined;
});
afterEach(cleanupGatewayHarnesses);

export async function withGatewayTestState(
  options: Parameters<typeof withOpenClawTestState>[0],
  run: () => Promise<void>,
) {
  await withOpenClawTestState(options, async () => {
    try {
      await run();
    } finally {
      // Test-finished hooks run after this state owner has already restored its environment.
      await cleanupGatewayHarnesses();
    }
  });
}

export function attachGatewayHarness(options: {
  connId: string;
  connectNonce: string;
  deferSocketSend?: boolean;
  socket?: WebSocket;
  refreshHealthSnapshot?: GatewayRequestContext["refreshHealthSnapshot"];
  requestOrigin?: string;
  requestHost?: string;
  headers?: Record<string, string>;
  ingressAttribution?: GatewayAttributedIngress;
  remoteAddr?: string;
  localAddr?: string;
  resolvedAuth?: ResolvedGatewayAuth;
  getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
  rateLimiter?: AuthRateLimiter;
  client?: unknown;
  close?: CloseGatewayConnection;
  isClosed?: () => boolean;
  setCloseCause?: SetCloseCause;
  clearHandshakeTimer?: () => void;
  handoffAuthenticatedReceive?: () => void;
}) {
  const connectionWork = new GatewayConnectionWork();
  const logWsControl = createLogger();
  const attachment = createGatewayAttachmentCompletion(
    options.connId,
    () => logWsControl.warn.mock.calls,
  );
  let closed = false;
  const close = options.close ?? createCloseMock();
  const closeSocket: CloseGatewayConnection = (code, reason) => {
    closed = true;
    attachment.closed(code, reason);
    close(code, reason);
  };
  harnessCleanups.push(async () => {
    closeSocket();
    connectionWork.beginClose();
    await connectionWork.drain();
  });
  let finishSocketSend: ((error?: Error) => void) | undefined;
  const socketSend = vi.fn((_payload: string, cb?: (err?: Error) => void) => {
    if (options.deferSocketSend) {
      finishSocketSend = (error) => cb?.(error);
      return;
    }
    cb?.();
  });
  let onMessage: ((data: Buffer) => void) | undefined;
  const socket =
    options.socket ??
    ({
      readyState: 1,
      _receiver: { _maxPayload: MAX_PREAUTH_PAYLOAD_BYTES, _allowSynchronousEvents: false },
      send: socketSend,
      on: vi.fn((event: string, handler: (data: Buffer) => void) => {
        if (event === "message") {
          onMessage = handler;
        }
        return socket;
      }),
    } as unknown as WebSocket);
  const send = vi.fn((_frame: unknown) => ({ kind: "sent" }) as const);
  let client: unknown = options.client ?? null;
  let registeredProfileId: string | undefined;
  const refreshedProfileIds: Array<string | undefined> = [];
  const requestHost = options.requestHost ?? "127.0.0.1:19001";
  const remoteAddr = options.remoteAddr ?? "127.0.0.1";
  const localAddr = options.localAddr ?? "127.0.0.1";
  const resolvedAuth: ResolvedGatewayAuth = options.resolvedAuth ?? {
    mode: "none",
    allowTailscale: false,
  };
  const advanceHandshakePhase = vi.fn();
  const clearHandshakeTimer = options.clearHandshakeTimer ?? vi.fn();
  const handoffAuthenticatedReceive = vi.fn(() =>
    attachment.attached(options.handoffAuthenticatedReceive),
  );
  const refreshConnectedUserProfile = vi.fn<
    NonNullable<GatewayRequestContext["refreshConnectedUserProfile"]>
  >((profile) => {
    refreshedProfileIds.push(
      (client as { preparedRecipientProfileId?: string } | null)?.preparedRecipientProfileId,
    );
    const authenticatedUserProfile = (
      client as { authenticatedUserProfile?: Record<string, unknown> } | null
    )?.authenticatedUserProfile;
    if (authenticatedUserProfile && profile) {
      Object.assign(authenticatedUserProfile, {
        profileId: profile.id,
        displayName: profile.displayName,
        avatarRevision: profile.avatarRevision,
        hasAvatar: profile.hasAvatar,
        updatedAt: profile.updatedAt,
      });
    }
  });
  const setClient = vi.fn((next: unknown) => {
    if (closed || options.isClosed?.()) {
      return false;
    }
    registeredProfileId = (next as { preparedRecipientProfileId?: string })
      .preparedRecipientProfileId;
    client = next;
    return true;
  });
  attachGatewayWsMessageHandler({
    clients: new GatewayClientRegistry(),
    socket,
    prepareAuthenticatedReceive: () => ({ ok: true, value: handoffAuthenticatedReceive }),
    connectionWork,
    bootId: "post-connect-health-test-boot",
    upgradeReq: {
      headers: {
        host: requestHost,
        ...(options.requestOrigin ? { origin: options.requestOrigin } : {}),
        ...options.headers,
      },
      socket: { localAddress: localAddr, remoteAddress: remoteAddr },
    } as unknown as IncomingMessage,
    ingressAttribution:
      options.ingressAttribution ??
      (remoteAddr === "127.0.0.1"
        ? {
            kind: "direct-local",
            clientIp: remoteAddr,
            rateLimit: { subject: { key: remoteAddr }, resetOnSuccess: true },
          }
        : {
            kind: "direct-remote",
            clientIp: remoteAddr,
            rateLimit: { subject: { key: remoteAddr }, resetOnSuccess: true },
          }),
    connId: options.connId,
    remoteAddr,
    localAddr,
    requestHost,
    requestOrigin: options.requestOrigin,
    connectNonce: options.connectNonce,
    getResolvedAuth: () => resolvedAuth,
    getRequiredSharedGatewaySessionGeneration: options.getRequiredSharedGatewaySessionGeneration,
    rateLimiter: options.rateLimiter,
    gatewayMethods: [],
    events: [],
    extraHandlers: {},
    buildRequestContext: () =>
      ({
        refreshConnectedUserProfile,
        broadcast: vi.fn(),
        publishPresence: vi.fn(),
      }) as never,
    nodeLifecycleDispatch: new GatewayNodeLifecycleDispatchTracker(),
    refreshHealthSnapshot:
      options.refreshHealthSnapshot ?? vi.fn(async () => createHealthSummary()),
    send,
    close: closeSocket,
    isClosed: () => closed || options.isClosed?.() === true,
    clearHandshakeTimer,
    getClient: () => client as never,
    setClient,
    setHandshakeState: vi.fn(),
    advanceHandshakePhase,
    setCloseCause: options.setCloseCause ?? createSetCloseCauseMock(),
    setLastFrameMeta: vi.fn(),
    originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
    logGateway: createLogger() as never,
    logHealth: createLogger() as never,
    logWsControl: logWsControl as never,
  });
  if (onMessage === undefined && !options.socket) {
    throw new Error("expected websocket message handler");
  }
  const sendMessage = (data: string) => {
    if (!onMessage) {
      throw new Error("synthetic websocket message handler is unavailable for a real socket");
    }
    onMessage(Buffer.from(data));
  };
  return {
    whenAttached: attachment.promise,
    runWhenIdle: () => connectionWork.runWhenIdle(() => {}),
    advanceHandshakePhase,
    clearHandshakeTimer,
    finishSocketSend: (error?: Error) => finishSocketSend?.(error),
    handoffAuthenticatedReceive,
    logWsControl,
    refreshConnectedUserProfile,
    refreshedProfileIds,
    send,
    setClient,
    socket,
    socketSend,
    sendMessage,
    sendRequest: (id: string, method: string, params: Record<string, unknown> = {}) => {
      sendMessage(
        JSON.stringify({
          type: "req",
          id,
          method,
          params,
        }),
      );
    },
    sendConnect: (id: string, params: Record<string, unknown>) => {
      sendMessage(
        JSON.stringify({
          type: "req",
          id,
          method: "connect",
          params,
        }),
      );
    },
    get client() {
      return client;
    },
    get registeredProfileId() {
      return registeredProfileId;
    },
  };
}
