import { expect, it, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { callGateway as CallGateway } from "./call.js";
import type { GatewayClientOptions } from "./client.js";

type DeviceAuthLookupMock = Mock<(...args: unknown[]) => DeviceAuthEntry | null>;

export function registerGatewayCallLocalBackendAuthTests({
  callGateway,
  setGatewayConfig,
  setGatewayNetworkDefaults,
  setLocalLoopbackGatewayConfig,
  getRuntimeConfig,
  getClientOptions,
  getDeviceIdentity,
  loadOrCreateDeviceIdentityMock,
  loadDeviceIdentityIfPresentMock,
  loadDeviceAuthTokenMock,
  loadDeviceAuthTokenReadOnlyMock,
  loadOriginDeviceTokenMock,
}: {
  callGateway: typeof CallGateway;
  setGatewayConfig: (gateway: NonNullable<OpenClawConfig["gateway"]>) => void;
  setGatewayNetworkDefaults: () => void;
  setLocalLoopbackGatewayConfig: () => void;
  getRuntimeConfig: () => OpenClawConfig;
  getClientOptions: () => GatewayClientOptions | null;
  getDeviceIdentity: () => DeviceIdentity;
  loadOrCreateDeviceIdentityMock: Mock;
  loadDeviceIdentityIfPresentMock: Mock;
  loadDeviceAuthTokenMock: DeviceAuthLookupMock;
  loadDeviceAuthTokenReadOnlyMock: DeviceAuthLookupMock;
  loadOriginDeviceTokenMock: DeviceAuthLookupMock;
}): void {
  it.each([undefined, "read-only"] as const)(
    "fails before connecting when identity storage is unavailable (%s)",
    async (sharedStateMode) => {
      setGatewayConfig({ mode: "local", auth: { mode: "none" } });
      const load =
        sharedStateMode === "read-only"
          ? loadDeviceIdentityIfPresentMock
          : loadOrCreateDeviceIdentityMock;
      load.mockImplementationOnce(() => {
        throw new Error("synthetic unreadable identity storage");
      });
      await expect(callGateway({ method: "sessions.create", sharedStateMode })).rejects.toThrow(
        /device identity.*openclaw doctor --fix/is,
      );
      expect(getClientOptions()).toBeNull();
    },
  );

  it("uses local backend shared auth without a device identity when required", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({
      method: "node.list",
      token: "explicit-token",
      scopes: ["operator.read", "operator.pairing"],
      requireLocalBackendSharedAuth: true,
    });

    expect(getClientOptions()?.clientName).toBe(GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT);
    expect(getClientOptions()?.mode).toBe(GATEWAY_CLIENT_MODES.BACKEND);
    expect(getClientOptions()?.scopes).toEqual(["operator.read", "operator.pairing"]);
    expect(getClientOptions()?.deviceIdentity).toBeNull();
  });

  it("uses local backend auth-none without a device identity when required", async () => {
    setGatewayConfig({ mode: "local", bind: "loopback", auth: { mode: "none" } });
    setGatewayNetworkDefaults();

    await callGateway({
      method: "node.list",
      scopes: ["operator.read", "operator.pairing"],
      requireLocalBackendSharedAuth: true,
    });

    expect(getClientOptions()?.clientName).toBe(GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT);
    expect(getClientOptions()?.mode).toBe(GATEWAY_CLIENT_MODES.BACKEND);
    expect(getClientOptions()?.scopes).toEqual(["operator.read", "operator.pairing"]);
    expect(getClientOptions()?.token).toBeUndefined();
    expect(getClientOptions()?.password).toBeUndefined();
    expect(getClientOptions()?.deviceIdentity).toBeNull();
  });

  it("keeps local auth-none CLI cron.status off device storage", async () => {
    setGatewayConfig({ mode: "local", bind: "loopback", auth: { mode: "none" } });
    setGatewayNetworkDefaults();
    const { callGatewayFromCliRuntime } = await import("../cli/gateway-rpc.runtime.js");

    await expect(callGatewayFromCliRuntime("cron.status", { json: true })).resolves.toEqual({
      ok: true,
    });

    expect(getClientOptions()).toMatchObject({
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      deviceIdentity: null,
      scopes: ["operator.read"],
    });
    expect(loadOrCreateDeviceIdentityMock).not.toHaveBeenCalled();
    expect(loadDeviceIdentityIfPresentMock).not.toHaveBeenCalled();
    expect(loadDeviceAuthTokenMock).not.toHaveBeenCalled();
    expect(loadDeviceAuthTokenReadOnlyMock).not.toHaveBeenCalled();
  });

  it.each(["url", "device", "stored auth"])(
    "preserves explicit %s authentication for auth-none CLI calls",
    async (kind) => {
      setGatewayConfig({ mode: "local", bind: "loopback", auth: { mode: "none" } });
      setGatewayNetworkDefaults();
      const { callGatewayFromCliRuntime } = await import("../cli/gateway-rpc.runtime.js");
      loadOriginDeviceTokenMock.mockReturnValue({
        token: "fixture-origin-token",
        role: "operator",
        scopes: ["operator.read"],
        updatedAtMs: 123,
      });

      await callGatewayFromCliRuntime(
        "cron.status",
        {
          json: true,
          config: getRuntimeConfig(),
          ...(kind === "url" ? { url: "ws://127.0.0.1:18789" } : {}),
          ...(kind === "url" ? { token: "fixture-override-token" } : {}),
        },
        undefined,
        {
          ...(kind === "device" ? { deviceIdentity: getDeviceIdentity() } : {}),
          ...(kind === "stored auth" ? { useStoredDeviceAuth: true } : {}),
        },
      );

      expect(getClientOptions()).toMatchObject({
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
        deviceIdentity: getDeviceIdentity(),
      });
    },
  );

  it("rejects required local backend shared auth for loopback URL overrides", async () => {
    await expect(
      callGateway({
        method: "node.list",
        url: "ws://127.0.0.1:18789",
        token: "explicit-token",
        scopes: ["operator.read", "operator.pairing"],
        requireLocalBackendSharedAuth: true,
      }),
    ).rejects.toMatchObject({ name: "GatewayLocalBackendSharedAuthUnavailableError" });

    expect(getClientOptions()).toBeNull();
  });

  it("rejects required local backend shared auth for remote-mode loopback tunnels", async () => {
    setGatewayConfig({
      mode: "remote",
      remote: {
        url: "ws://127.0.0.1:18789",
        token: "remote-token",
      },
    });
    setGatewayNetworkDefaults();

    await expect(
      callGateway({
        method: "node.list",
        scopes: ["operator.read", "operator.pairing"],
        requireLocalBackendSharedAuth: true,
      }),
    ).rejects.toMatchObject({ name: "GatewayLocalBackendSharedAuthUnavailableError" });

    expect(getClientOptions()).toBeNull();
  });
}
