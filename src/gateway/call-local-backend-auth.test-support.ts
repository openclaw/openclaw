import { expect, it, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { callGateway as CallGateway } from "./call.js";
import type { GatewayClientOptions } from "./client.js";

type DeviceAuthLookupMock = Mock<(...args: unknown[]) => DeviceAuthEntry | null>;

export function registerGatewayCallLocalBackendAuthTests(fixture: {
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
  const getOptions = fixture.getClientOptions;
  const backend = {
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    scopes: ["operator.read", "operator.pairing"] satisfies NonNullable<
      Parameters<typeof fixture.callGateway>[0]["scopes"]
    >,
    deviceIdentity: null,
  };
  const localAuthNone = () => {
    fixture.setGatewayConfig({ mode: "local", bind: "loopback", auth: { mode: "none" } });
    fixture.setGatewayNetworkDefaults();
  };
  const url = "ws://127.0.0.1:18789";
  it.each([undefined, "read-only"] as const)(
    "rejects unreadable identity storage (%s)",
    async (sharedStateMode) => {
      fixture.setGatewayConfig({ mode: "local", auth: { mode: "none" } });
      const load =
        sharedStateMode === "read-only"
          ? fixture.loadDeviceIdentityIfPresentMock
          : fixture.loadOrCreateDeviceIdentityMock;
      load.mockImplementationOnce(() => {
        throw new Error("synthetic unreadable identity storage");
      });
      await expect(
        fixture.callGateway({ method: "sessions.create", sharedStateMode }),
      ).rejects.toThrow(/device identity.*openclaw doctor --fix/is);
      expect(getOptions()).toBeNull();
    },
  );

  const nodeList = (options: Partial<Parameters<typeof fixture.callGateway>[0]> = {}) =>
    fixture.callGateway({
      method: "node.list",
      scopes: backend.scopes,
      requireLocalBackendSharedAuth: true,
      ...options,
    });
  it.each(["shared", "none"])("uses identity-free backend %s auth", async (auth) => {
    (auth === "shared" ? fixture.setLocalLoopbackGatewayConfig : localAuthNone)();
    await nodeList(auth === "shared" ? { token: "explicit-token" } : {});
    expect(getOptions()).toMatchObject(backend);
    if (auth === "none") {
      expect([getOptions()?.token, getOptions()?.password]).toEqual([undefined, undefined]);
    }
  });

  it("keeps local auth-none CLI cron.status off device storage", async () => {
    localAuthNone();
    const { callGatewayFromCliRuntime } = await import("../cli/gateway-rpc.runtime.js");

    await callGatewayFromCliRuntime("cron.status", { json: true });

    expect(getOptions()).toMatchObject({ ...backend, scopes: ["operator.read"] });
    for (const load of [
      fixture.loadOrCreateDeviceIdentityMock,
      fixture.loadDeviceIdentityIfPresentMock,
      fixture.loadDeviceAuthTokenMock,
      fixture.loadDeviceAuthTokenReadOnlyMock,
    ]) {
      expect(load).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["url", { url, token: "fixture-override-token" }, () => ({})],
    ["device", {}, () => ({ deviceIdentity: fixture.getDeviceIdentity() })],
    ["stored auth", {}, () => ({ useStoredDeviceAuth: true })],
  ] as const)("keeps explicit %s auth for CLI auth-none", async (_kind, options, extra) => {
    localAuthNone();
    const { callGatewayFromCliRuntime } = await import("../cli/gateway-rpc.runtime.js");
    fixture.loadOriginDeviceTokenMock.mockReturnValue({
      token: "fixture-origin-token",
      role: "operator",
      scopes: ["operator.read"],
      updatedAtMs: 123,
    });

    await callGatewayFromCliRuntime(
      "cron.status",
      {
        json: true,
        config: fixture.getRuntimeConfig(),
        ...options,
      },
      undefined,
      extra(),
    );

    expect(getOptions()).toMatchObject({
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
      deviceIdentity: fixture.getDeviceIdentity(),
    });
  });

  it.each(["URL override", "remote-mode tunnel"])(
    "rejects required local backend auth for %s",
    async (kind) => {
      if (kind === "remote-mode tunnel") {
        fixture.setGatewayConfig({ mode: "remote", remote: { url, token: "remote-token" } });
        fixture.setGatewayNetworkDefaults();
      }
      await expect(
        nodeList(kind === "URL override" ? { url, token: "explicit-token" } : {}),
      ).rejects.toMatchObject({ name: "GatewayLocalBackendSharedAuthUnavailableError" });
      expect(getOptions()).toBeNull();
    },
  );
}
