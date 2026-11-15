// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goalOperationScopePrefix } from "../lib/chat/goal-operation-storage.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import {
  loadDeviceAuthToken,
  loadOrCreateDeviceIdentity,
  storeDeviceAuthToken,
} from "../lib/nodes/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  createGatewayStoreTestStore as createStore,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import { loadSettings, persistSessionToken } from "./settings.ts";

const DEVICE_ID = "device-1";
const OTHER_GATEWAY = "wss://other-remote.example.test";
const IDENTITY_KEY = "openclaw-device-identity-v1";

beforeEach(stubGatewayStoreTestGlobals);
afterEach(() => {
  setAvatarGatewayOrigin(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function seedIdentity() {
  localStorage.setItem(
    IDENTITY_KEY,
    JSON.stringify({
      version: 1,
      deviceId: DEVICE_ID,
      publicKey: "AA",
      privateKey: "AA",
      createdAtMs: 1,
    }),
  );
}
function credential(gatewayUrl: string) {
  return { deviceId: DEVICE_ID, gatewayUrl, role: "operator" };
}
function seedToken(gatewayUrl: string, token: string) {
  storeDeviceAuthToken({ ...credential(gatewayUrl), token, scopes: ["operator.read"] });
}

describe("createApplicationGateway stored device credential", () => {
  it.each([
    { running: true, alias: false },
    { running: true, alias: true },
    { running: false, alias: false },
  ])(
    "forgets only the live credential and its session (running=$running, alias=$alias)",
    ({ running, alias }) => {
      const { gateway, current, clients } = createStore();
      const firstUrl = gateway.connection.gatewayUrl;
      if (running) {
        gateway.start();
        gateway.connect({
          gatewayUrl: OTHER_GATEWAY,
          token: "page-shared-token",
          password: "gate-password",
        });
        expect(gateway.connection.gatewayUrl).toBe(OTHER_GATEWAY);
        expect(current().testOptions.token).toBe("page-shared-token");
      }
      const gatewayUrl = gateway.connection.gatewayUrl;
      const otherUrl = running ? firstUrl : OTHER_GATEWAY;
      seedIdentity();
      seedToken(gatewayUrl, "current-gateway-token");
      seedToken(otherUrl, "other-gateway-token");
      if (alias) {
        const key = Array.from({ length: localStorage.length }, (_, index) =>
          localStorage.key(index),
        ).find(
          (candidate) =>
            candidate?.startsWith("openclaw.device.auth.v1:") &&
            localStorage.getItem(candidate)?.includes("current-gateway-token"),
        );
        if (!key) {
          throw new Error("missing device-auth storage key");
        }
        const stored = JSON.parse(localStorage.getItem(key) ?? "null");
        stored.tokens = { " operator ": stored.tokens.operator };
        localStorage.setItem(key, JSON.stringify(stored));
      }
      persistSessionToken(gatewayUrl, "persisted-shared-token");
      expect(loadSettings().token).toBe("persisted-shared-token");
      const recoveryKey = `${goalOperationScopePrefix(gatewayUrl, "principal")}session`;
      const otherRecoveryKey = `${goalOperationScopePrefix(otherUrl, "principal")}session`;
      sessionStorage.setItem(recoveryKey, JSON.stringify({ objective: "Private goal edit" }));
      sessionStorage.setItem(otherRecoveryKey, JSON.stringify({ objective: "Other goal" }));
      expect(gateway.hasStoredDeviceToken?.()).toBe(true);
      const clientsBefore = clients.length;

      expect(gateway.forgetDeviceToken?.()).toBe(true);

      expect(loadDeviceAuthToken(credential(gatewayUrl))).toBeNull();
      expect(loadDeviceAuthToken(credential(otherUrl))?.token).toBe("other-gateway-token");
      expect(localStorage.getItem(IDENTITY_KEY)).not.toBeNull();
      expect(sessionStorage.getItem(recoveryKey)).toBeNull();
      expect(sessionStorage.getItem(otherRecoveryKey)).toContain("Other goal");
      expect(loadSettings().token).toBe("");
      expect(gateway.hasStoredDeviceToken?.()).toBe(false);
      expect(clients.length).toBe(clientsBefore + Number(running));
      if (running) {
        expect(current().testOptions.token).toBeUndefined();
        expect(current().testOptions.bootstrapToken).toBeUndefined();
        expect(current().testOptions.password).toBeUndefined();
        expect(gateway.connection.token).toBe("");
      }
      gateway.stop();
    },
  );

  it.each([
    ["no stored identity", null],
    ["unparsable", "{not json"],
    ["malformed", JSON.stringify({ version: 1 })],
    ["incomplete, with an id", JSON.stringify({ version: 1, deviceId: "stale-device" })],
  ])(
    "finds and forgets a credential kept only for this page when storage rejects writes (%s)",
    async (_, storedIdentity) => {
      const storage = createStorageMock();
      if (storedIdentity !== null) {
        storage.setItem(IDENTITY_KEY, storedIdentity);
      }
      storage.setItem = () => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      };
      vi.stubGlobal("localStorage", storage);
      const identity = await loadOrCreateDeviceIdentity();
      const { gateway } = createStore();
      const pageCredential = {
        deviceId: identity.deviceId,
        gatewayUrl: gateway.connection.gatewayUrl,
        role: "operator",
      };
      storeDeviceAuthToken({
        ...pageCredential,
        token: "page-only-token",
        scopes: ["operator.read"],
      });
      expect(loadDeviceAuthToken(pageCredential)?.token).toBe("page-only-token");

      expect(gateway.hasStoredDeviceToken?.()).toBe(true);
      expect(gateway.forgetDeviceToken?.()).toBe(true);
      expect(loadDeviceAuthToken(pageCredential)).toBeNull();
      expect(gateway.hasStoredDeviceToken?.()).toBe(false);
    },
  );

  it("skips reconnect when no credential is stored", () => {
    const { gateway, clients } = createStore();
    gateway.start();
    const clientsBefore = clients.length;
    expect(gateway.hasStoredDeviceToken?.()).toBe(false);
    expect(gateway.forgetDeviceToken?.()).toBe(false);
    expect(clients.length).toBe(clientsBefore);
    gateway.stop();
  });
});
