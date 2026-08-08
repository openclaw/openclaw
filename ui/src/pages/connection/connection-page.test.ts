/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import {
  loadSettings,
  persistSessionToken,
  resolveGatewayTokenForUrlEdit,
  saveSettings,
} from "../../app/settings.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { loadDeviceAuthToken, storeDeviceAuthToken } from "../../lib/nodes/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ConnectionPage, supportsSystemInfo } from "./connection-page.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("supportsSystemInfo", () => {
  it("requires the Gateway to advertise system.info", () => {
    const hello = {
      features: { methods: ["health", "system.info"] },
    } as ApplicationGatewaySnapshot["hello"];
    const unsupportedHello = {
      features: { methods: ["health"] },
    } as ApplicationGatewaySnapshot["hello"];

    expect(supportsSystemInfo(hello)).toBe(true);
    expect(supportsSystemInfo(unsupportedHello)).toBe(false);
    expect(supportsSystemInfo(null)).toBe(false);
  });
});

describe("ConnectionPage system info", () => {
  it("clears stale host info when the Gateway disconnects", () => {
    const client = {} as GatewayBrowserClient;
    const snapshot = {
      client,
      phase: "stopped",
      hello: null,
    } as ApplicationGatewaySnapshot;
    const page = new ConnectionPage();
    const state = page as unknown as {
      context: { gateway: { snapshot: ApplicationGatewaySnapshot } };
      systemInfo: SystemInfoResult | null;
      systemInfoClient: GatewayBrowserClient | null;
      handleSystemInfoGatewaySnapshot: (snapshot: ApplicationGatewaySnapshot) => void;
    };
    state.context = { gateway: { snapshot } };
    state.systemInfoClient = client;
    state.systemInfo = {} as SystemInfoResult;

    state.handleSystemInfoGatewaySnapshot(snapshot);

    expect(state.systemInfo).toBeNull();
  });

  it("rejects an old Gateway source response when the replacement reuses its client", async () => {
    const firstResponse = deferred<SystemInfoResult>();
    const secondResponse = deferred<SystemInfoResult>();
    const client = {
      request: vi
        .fn()
        .mockImplementationOnce(() => firstResponse.promise)
        .mockImplementationOnce(() => secondResponse.promise),
    } as unknown as GatewayBrowserClient;
    const snapshot = {
      client,
      phase: "connected",
      hello: { features: { methods: ["system.info"] } },
    } as ApplicationGatewaySnapshot;
    const firstGateway = { snapshot } as ApplicationGateway;
    const secondGateway = { snapshot } as ApplicationGateway;
    const page = new ConnectionPage();
    const state = page as unknown as {
      context: ApplicationContext;
      syncSystemInfoPolling: () => void;
      synchronizeSystemInfoGateway: (gateway: ApplicationGateway) => void;
      loadSystemInfo: () => Promise<void>;
      systemInfo: SystemInfoResult | null;
      systemInfoUnavailable: boolean;
    };
    Object.defineProperty(page, "isConnected", { configurable: true, value: true });
    state.syncSystemInfoPolling = () => undefined;
    state.context = { gateway: firstGateway } as ApplicationContext;
    state.synchronizeSystemInfoGateway(firstGateway);

    const firstLoad = state.loadSystemInfo();
    state.systemInfo = {} as SystemInfoResult;
    state.systemInfoUnavailable = true;
    state.context = { gateway: secondGateway } as ApplicationContext;
    state.synchronizeSystemInfoGateway(secondGateway);
    const secondLoad = state.loadSystemInfo();

    const stale = { platform: "stale" } as unknown as SystemInfoResult;
    firstResponse.resolve(stale);
    await firstLoad;
    expect(state.systemInfo).toBeNull();
    expect(state.systemInfoUnavailable).toBe(false);

    const current = { platform: "current" } as unknown as SystemInfoResult;
    secondResponse.resolve(current);
    await secondLoad;
    expect(state.systemInfo).toBe(current);
  });
});

describe("ConnectionPage browser credential recovery", () => {
  const currentToken = {
    deviceId: "current-device",
    gatewayUrl: "wss://current.gateway.test",
    role: "operator",
  };

  function createRecoveryState() {
    const persistedSettings = {
      ...loadSettings(),
      gatewayUrl: currentToken.gatewayUrl,
      token: "secret-token",
    };
    saveSettings(persistedSettings);
    persistSessionToken("wss://other.gateway.test", "other-shared-token");
    localStorage.setItem(
      "openclaw-device-identity-v1",
      JSON.stringify({
        version: 1,
        deviceId: currentToken.deviceId,
        publicKey: "AA",
        privateKey: "AA",
        createdAtMs: 1,
      }),
    );
    storeDeviceAuthToken({ ...currentToken, token: "test-auth-token", scopes: ["operator.read"] });
    storeDeviceAuthToken({
      ...currentToken,
      gatewayUrl: "wss://other.gateway.test",
      token: "test-token-placeholder",
      scopes: ["operator.read"],
    });
    storeDeviceAuthToken({
      ...currentToken,
      role: "node",
      token: "gateway-token",
      scopes: ["node.invoke"],
    });
    localStorage.setItem("unrelated-preference", "preserved");

    const connect = vi.fn();
    const page = new ConnectionPage();
    const state = page as unknown as {
      context: ApplicationContext;
      settings: { token: string };
      password: string;
      forgetBrowserDevice: () => Promise<void>;
    };
    state.context = {
      gateway: {
        connection: {
          gatewayUrl: currentToken.gatewayUrl,
          token: "secret-token",
          bootstrapToken: "placeholder",
          password: "placeholder",
        },
        connect,
      },
    } as unknown as ApplicationContext;
    state.settings = persistedSettings;
    state.password = "placeholder";
    return { connect, state };
  }

  it("does nothing when the operator cancels", async () => {
    const { connect, state } = createRecoveryState();
    vi.mocked(showConfirmDialog).mockResolvedValue(false);

    await state.forgetBrowserDevice();

    expect(loadDeviceAuthToken(currentToken)?.token).toBe("test-auth-token");
    expect(state.settings.token).toBe("secret-token");
    expect(connect).not.toHaveBeenCalled();
  });

  it("forgets only the current Gateway operator credential before reconnecting", async () => {
    const { connect, state } = createRecoveryState();
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await state.forgetBrowserDevice();

    expect(loadDeviceAuthToken(currentToken)).toBeNull();
    expect(
      loadDeviceAuthToken({ ...currentToken, gatewayUrl: "wss://other.gateway.test" })?.token,
    ).toBe("test-token-placeholder");
    expect(loadDeviceAuthToken({ ...currentToken, role: "node" })?.token).toBe("gateway-token");
    expect(localStorage.getItem("unrelated-preference")).toBe("preserved");
    expect(state.settings.token).toBe("");
    expect(state.password).toBe("");
    const reconstructed = new ConnectionPage() as unknown as {
      settings: { gatewayUrl: string; token: string };
    };
    expect(reconstructed.settings.gatewayUrl).toBe(currentToken.gatewayUrl);
    expect(reconstructed.settings.token).toBe("");
    expect(
      resolveGatewayTokenForUrlEdit(currentToken.gatewayUrl, "wss://other.gateway.test", ""),
    ).toBe("other-shared-token");
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith({ token: "", bootstrapToken: "", password: "" });
  });
});
