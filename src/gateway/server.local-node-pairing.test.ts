import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import { writeConfigFile } from "../config/config.js";
import { revokeDeviceToken } from "../infra/device-pairing-tokens.js";
import {
  getPairedDevice,
  listDevicePairing,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { loadDeviceIdentity, openTrackedWs } from "./device-authz.test-helpers.js";
import { connectReq, installGatewayTestHooks, startServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const MAC_CLIENT = {
  id: GATEWAY_CLIENT_IDS.MACOS_APP,
  version: "1.0.0",
  platform: "macOS 26.0",
  deviceFamily: "Mac",
  mode: GATEWAY_CLIENT_MODES.UI,
};

describe("same-machine native node device pairing", () => {
  let started: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    started = await startServer("secret", { bind: "loopback" });
  });
  afterAll(async () => {
    await started.server.close();
    started.envSnapshot.restore();
  });

  async function connect(
    identityPath: string,
    role: "operator" | "node",
    headers?: Record<string, string>,
    client: ConnectParams["client"] = MAC_CLIENT,
  ) {
    const ws = await openTrackedWs(started.port, headers);
    try {
      return await connectReq(ws, {
        token: "secret",
        role,
        scopes: role === "operator" ? ["operator.read"] : [],
        client: {
          ...client,
          mode: role === "node" ? GATEWAY_CLIENT_MODES.NODE : client.mode,
        },
        deviceIdentityPath: identityPath,
        prePairDevice: false,
      });
    } finally {
      ws.close();
    }
  }

  test("silently adds the node role after the native operator handshake", async () => {
    await writeConfigFile({
      gateway: { nodes: { pairing: { autoApproveCidrs: ["127.0.0.1/32"] } } },
    });
    const loaded = loadDeviceIdentity("local-native-role-upgrade");
    expect(await connect(loaded.identityPath, "operator")).toMatchObject({ ok: true });
    const before = await getPairedDevice(loaded.identity.deviceId);
    expect(before?.roles).toEqual(["operator"]);

    const response = await connect(loaded.identityPath, "node");
    const pending = (await listDevicePairing()).pending.filter(
      (request) => request.deviceId === loaded.identity.deviceId,
    );
    expect({ response, pending }).toMatchObject({
      response: { ok: true, payload: { type: "hello-ok", auth: { role: "node", scopes: [] } } },
      pending: [],
    });
    const after = await getPairedDevice(loaded.identity.deviceId);
    expect(after?.roles).toEqual(expect.arrayContaining(["operator", "node"]));
    expect(after?.tokens?.operator?.token === before?.tokens?.operator?.token).toBe(true);
    expect(after?.approvedScopes).toEqual(before?.approvedScopes);
  });

  test("keeps an explicitly revoked native node token pending", async () => {
    const loaded = loadDeviceIdentity("local-native-node-repair");
    expect(await connect(loaded.identityPath, "node")).toMatchObject({ ok: true });
    expect(await connect(loaded.identityPath, "operator")).toMatchObject({ ok: true });
    const before = await getPairedDevice(loaded.identity.deviceId);
    expect(
      await revokeDeviceToken({ deviceId: loaded.identity.deviceId, role: "node" }),
    ).toMatchObject({ ok: true });

    const response = await connect(loaded.identityPath, "node");
    const pending = (await listDevicePairing()).pending.filter(
      (request) => request.deviceId === loaded.identity.deviceId,
    );
    expect(response).toMatchObject({ ok: false, error: { details: { reason: "role-upgrade" } } });
    expect(pending).toMatchObject([{ isRepair: true, silent: false }]);
    const after = await getPairedDevice(loaded.identity.deviceId);
    expect(after?.tokens?.node?.revokedAtMs).toBeTypeOf("number");
    expect(after?.tokens?.node?.token === before?.tokens?.node?.token).toBe(true);
    expect(after?.tokens?.operator?.token === before?.tokens?.operator?.token).toBe(true);
  });

  test("silently resolves an existing role-upgrade repair when local approval is enabled", async () => {
    const loaded = loadDeviceIdentity("local-native-pending-repair");
    expect(await connect(loaded.identityPath, "operator")).toMatchObject({ ok: true });
    const before = await getPairedDevice(loaded.identity.deviceId);
    await writeConfigFile({ gateway: { nodes: { pairing: { autoApproveLocal: false } } } });
    expect(await connect(loaded.identityPath, "node")).toMatchObject({ ok: false });
    const pending = (await listDevicePairing()).pending.filter(
      (request) => request.deviceId === loaded.identity.deviceId,
    );
    expect(pending).toMatchObject([{ role: "node", isRepair: true, silent: false }]);

    await writeConfigFile({ gateway: { nodes: { pairing: { autoApproveLocal: true } } } });
    const response = await connect(loaded.identityPath, "node");
    expect(response.ok).toBe(true);
    expect(
      (await listDevicePairing()).pending.filter(
        (request) => request.deviceId === loaded.identity.deviceId,
      ),
    ).toEqual([]);
    const after = await getPairedDevice(loaded.identity.deviceId);
    expect(after?.tokens?.operator?.token === before?.tokens?.operator?.token).toBe(true);
  });

  test.each<{ name: string; headers?: Record<string, string>; client?: ConnectParams["client"] }>([
    { name: "browser origin", headers: { origin: "https://localhost" } },
    {
      name: "trusted proxy",
      headers: { "x-forwarded-for": "192.0.2.5", "x-forwarded-proto": "https" },
    },
    { name: "Control UI", client: { ...MAC_CLIENT, id: GATEWAY_CLIENT_IDS.CONTROL_UI } },
    { name: "WebChat", client: { ...MAC_CLIENT, id: GATEWAY_CLIENT_IDS.WEBCHAT_UI } },
  ])("keeps $name node role upgrades pending", async ({ name, headers, client }) => {
    const loaded = loadDeviceIdentity(`local-native-boundary-${name}`);
    expect(await connect(loaded.identityPath, "operator")).toMatchObject({ ok: true });
    await writeConfigFile({
      gateway: {
        trustedProxies: ["127.0.0.1"],
        controlUi: { allowedOrigins: ["https://localhost"] },
        nodes: { pairing: { autoApproveCidrs: ["192.0.2.0/24"] } },
      },
    });
    const response = await connect(loaded.identityPath, "node", headers, client);
    expect(response.ok).toBe(false);
    expect((await getPairedDevice(loaded.identity.deviceId))?.tokens?.node).toBeUndefined();
  });

  test.each([{ scopes: [] }, { scopes: ["operator.admin"] }])(
    "does not approve merged operator scopes $scopes during node repair",
    async ({ scopes }) => {
      const loaded = loadDeviceIdentity("local-native-merged-repair");
      expect(await connect(loaded.identityPath, "operator")).toMatchObject({ ok: true });
      const before = await getPairedDevice(loaded.identity.deviceId);
      await requestDevicePairing({
        deviceId: loaded.identity.deviceId,
        publicKey: loaded.publicKey,
        role: "operator",
        scopes,
        silent: false,
      });
      const response = await connect(loaded.identityPath, "node");
      expect(response.ok).toBe(false);
      const after = await getPairedDevice(loaded.identity.deviceId);
      expect(after?.tokens?.node).toBeUndefined();
      expect(after?.tokens?.operator?.token === before?.tokens?.operator?.token).toBe(true);
      expect(after?.approvedScopes).toEqual(before?.approvedScopes);
    },
  );
});
