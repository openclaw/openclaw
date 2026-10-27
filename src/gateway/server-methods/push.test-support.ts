import { vi } from "vitest";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { WebPushSubscription } from "../../infra/push-web-store.records.js";
import type { GatewayClient } from "./types.js";

export function holdPushStorage() {
  const entered = createDeferred();
  const released = createDeferred();
  return {
    async wait() {
      entered.resolve();
      await released.promise;
    },
    async settle<T>(pending: Promise<T>, whileWaiting: () => void) {
      const settled = pending.catch(() => undefined);
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "storage admission not reached");
        whileWaiting();
      } finally {
        released.resolve();
        await settled;
      }
      return pending;
    },
  };
}

export const mockPushApns = () => ({
  clearApnsRegistrationIfCurrent: vi.fn(),
  loadApnsRegistration: vi.fn(),
  normalizeApnsEnvironment: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  resolveApnsRelayConfigFromEnv: vi.fn(),
  sendApnsAlert: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(),
});

export const mockPushWeb = () => ({
  WebPushSubscriptionBindingError: class extends Error {},
  broadcastWebPush: vi.fn(),
  clearBoundWebPushSubscription: vi.fn(),
  withBoundWebPushSubscriptionByEndpoint: vi.fn(),
  registerWebPushSubscription: vi.fn(),
  resolveVapidKeys: vi.fn(),
  setWebPushSubscriptionPreferences: vi.fn(),
});

export function pushClient(
  profileId: string,
  connId: string,
  connectionSignal: AbortSignal,
  deviceId = "browser-device",
  scopes = ["operator.write"],
): GatewayClient {
  return {
    connId,
    connectionSignal,
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
      role: "operator",
      scopes,
      device: {
        id: deviceId,
        publicKey: "synthetic-public-key",
        signature: "synthetic-signature",
        signedAt: 1,
        nonce: "synthetic-nonce",
      },
    },
    authenticatedUserProfile: { profileId, displayName: null, hasAvatar: false, updatedAt: 1 },
  };
}

export function pushSubscription(
  endpoint: string,
  keys: WebPushSubscription["keys"],
  subscriptionId: string,
): WebPushSubscription {
  return { subscriptionId, endpoint, keys, createdAtMs: 1, updatedAtMs: 1 };
}
