import { vi } from "vitest";
import { createMockSubsystemLogger } from "../../../../test/helpers/mock-subsystem-logger.js";
import { GatewayClientRegistry } from "../client-registry.js";
import type { GatewayWsClient } from "../ws-types.js";
import type { GatewayWsMessageHandlerParams as Handler } from "./message-handler-types.js";
import { GatewayNodeLifecycleDispatchTracker } from "./node-lifecycle-dispatch.js";

type AdmissionOverrides = Pick<
  Handler,
  | "socket"
  | "upgradeReq"
  | "buildRequestContext"
  | "getResolvedAuth"
  | "close"
  | "isClosed"
  | "connectionWork"
> &
  Partial<Handler>;

export function createAdmissionHandler(overrides: AdmissionOverrides) {
  let client: GatewayWsClient | null = null;
  return {
    clients: new GatewayClientRegistry(),
    prepareAuthenticatedReceive: () => ({ ok: true as const, value: vi.fn() }),
    bootId: "admission-test-boot",
    ingressAttribution: {
      kind: "direct-local",
      clientIp: "127.0.0.1",
      rateLimit: { subject: { key: "127.0.0.1" }, resetOnSuccess: true },
    },
    connId: "admission-connect",
    remoteAddr: "127.0.0.1",
    localAddr: "127.0.0.1",
    requestHost: overrides.upgradeReq.headers.host,
    connectNonce: "admission-nonce",
    gatewayMethods: [],
    events: [],
    extraHandlers: {},
    nodeLifecycleDispatch: new GatewayNodeLifecycleDispatchTracker(),
    refreshHealthSnapshot: vi.fn(),
    send: vi.fn<Handler["send"]>(() => ({ kind: "sent" })),
    clearHandshakeTimer: vi.fn(),
    getClient: () => client,
    setClient: vi.fn((next: GatewayWsClient) => {
      client = next;
      return true;
    }),
    setHandshakeState: vi.fn(),
    advanceHandshakePhase: vi.fn(),
    setCloseCause: vi.fn(),
    setLastFrameMeta: vi.fn(),
    originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
    logGateway: createMockSubsystemLogger("gateway"),
    logHealth: createMockSubsystemLogger("health"),
    logWsControl: createMockSubsystemLogger("ws-control"),
    ...overrides,
  } satisfies Handler;
}
