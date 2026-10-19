import { expect, it } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import {
  ensureDeviceToken,
  rotateDeviceToken,
  verifyDeviceToken,
} from "../infra/device-pairing-tokens.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { setTestEnvValue } from "../test-utils/env.js";
import type { GatewayClient } from "./client.js";
import { startGatewayServerCore } from "./server-start.js";
import { installHotReloadFixture } from "./server.hot-reload-fixture.test-support.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

const OLD_TOKEN = "shared-token-old";
const NEW_TOKEN = "shared-token-new";
const SECRET_REF_TOKEN_ID = "OPENCLAW_SHARED_AUTH_ROTATION_SECRET_REF";
const scopes = ["operator.admin"];
const hotReloadAck = {
  hash: expect.any(String),
  sentinel: { payload: { stats: { requiresRestart: false } } },
};
type ConfigSnapshot = { hash: string; config: OpenClawConfig };
type ConfigAck = { hash: string; sentinel: { payload: { stats: { requiresRestart: boolean } } } };

const fixture = installHotReloadFixture("shared-auth-rotation", {
  env: { [SECRET_REF_TOKEN_ID]: undefined },
});
const connect = fixture.connect;

async function startGateway(token: GatewayAuthConfig["token"] = OLD_TOKEN) {
  const { state, port } = fixture;
  await state.writeConfig({
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token },
      controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
      reload: { mode: "hybrid" },
    },
    logging: { level: "silent", consoleLevel: "silent" },
    agents: { defaults: { workspace: state.workspaceDir } },
  });
  const server = fixture.ownServer(await startGatewayServerCore(port, { controlUiEnabled: false }));
  await server.startupSettled;
}

async function openDeviceTokenClient(
  params: { issuerGeneration?: string; browserClient?: boolean } = {},
) {
  const { state, port } = fixture;
  const identity = loadOrCreateDeviceIdentity({ path: state.path("device-identity.sqlite") });
  const clientName = params.browserClient ? "openclaw-control-ui" : "test";
  const mode = params.browserClient ? "webchat" : "test";
  const device = { deviceId: identity.deviceId, role: "operator", scopes };
  const pending = await requestDevicePairing({
    ...device,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    clientId: clientName,
    clientMode: mode,
  });
  await approveDevicePairing(pending.request.requestId, { callerScopes: scopes });
  let issued;
  if (params.issuerGeneration) {
    issued = await ensureDeviceToken({
      ...device,
      issuer: { kind: "shared-gateway-auth", generation: params.issuerGeneration },
    });
  } else {
    const rotated = await rotateDeviceToken(device);
    expect(rotated.ok).toBe(true);
    issued = rotated.ok ? rotated.entry : undefined;
  }
  expect(issued?.token).toBeTypeOf("string");
  if (!issued) {
    throw new Error("expected issued device token");
  }
  const connection = await connect({
    clientName,
    mode,
    deviceIdentity: identity,
    deviceToken: issued.token,
    ...(params.browserClient ? { origin: `http://127.0.0.1:${port}` } : {}),
  });
  return { ...connection, deviceId: identity.deviceId };
}

function requiredSharedGeneration() {
  const generation = resolveSharedGatewaySessionGeneration({
    mode: "token",
    token: OLD_TOKEN,
    allowTailscale: false,
  });
  expect(generation).toBeTypeOf("string");
  if (!generation) {
    throw new Error("expected shared gateway generation");
  }
  return generation;
}

async function rotateSharedToken(client: GatewayClient) {
  const before = await client.request<ConfigSnapshot>("config.get");
  const ack = await client.request<ConfigAck>("config.patch", {
    baseHash: before.hash,
    raw: JSON.stringify({ gateway: { auth: { token: NEW_TOKEN } } }),
    restartDelayMs: 1_000,
  });
  expect(ack).toMatchObject(hotReloadAck);
  return ack;
}

async function expectAuthChangedClose(connection: Awaited<ReturnType<typeof connect>>) {
  await expect(
    withTestTimeout(connection.closed, 10_000, "gateway auth rotation did not close socket"),
  ).resolves.toEqual({ code: 4001, reason: "gateway auth changed" });
  await connection.client.stopAndWait();
}

it.each(["config.patch", "config.apply"] as const)(
  "disconnects shared-token sessions after %s rotation",
  async (method) => {
    const secretRef = method === "config.apply";
    if (secretRef) {
      setTestEnvValue(SECRET_REF_TOKEN_ID, OLD_TOKEN);
    }
    await startGateway(
      secretRef ? { source: "env", provider: "default", id: SECRET_REF_TOKEN_ID } : OLD_TOKEN,
    );
    const connection = await connect({ token: OLD_TOKEN });
    if (secretRef) {
      const before = await connection.client.request<ConfigSnapshot>("config.get");
      setTestEnvValue(SECRET_REF_TOKEN_ID, NEW_TOKEN);
      const ack = await connection.client.request<ConfigAck>(method, {
        baseHash: before.hash,
        raw: JSON.stringify(before.config),
      });
      expect(ack).toMatchObject(hotReloadAck);
    } else {
      await rotateSharedToken(connection.client);
    }
    await expectAuthChangedClose(connection);
  },
);

it("keeps existing device-token websocket sessions connected after shared token rotation", async () => {
  await startGateway();
  const connection = await openDeviceTokenClient();
  const ack = await rotateSharedToken(connection.client);
  const followUp = await connection.client.request<ConfigSnapshot>("config.get");
  expect(followUp.hash).toBe(ack.hash);
  expect(connection.closeEvents).toEqual([]);
  expect(connection.hellos).toHaveLength(1);
});

it.each([
  { label: "browser", browserClient: true },
  { label: "non-browser", browserClient: false },
])(
  "preserves $label token issuers on reconnect and revokes sessions on rotation",
  async ({ browserClient }) => {
    await startGateway();
    const issuerGeneration = requiredSharedGeneration();
    const connection = await openDeviceTokenClient({ issuerGeneration, browserClient });
    const { deviceId, hello } = connection;
    const issuer = { kind: "shared-gateway-auth", generation: issuerGeneration };
    const token = hello.auth?.deviceToken;
    expect(token).toBeTypeOf("string");
    if (typeof token !== "string") {
      throw new Error("expected hello device token");
    }
    expect((await getPairedDevice(deviceId))?.tokens?.operator?.issuer).toEqual(issuer);
    await expect(
      verifyDeviceToken({
        deviceId,
        token,
        role: "operator",
        scopes,
        requiredSharedGatewaySessionGeneration: issuerGeneration,
      }),
    ).resolves.toEqual({ ok: true, issuer });
    await rotateSharedToken(connection.client);
    await expectAuthChangedClose(connection);
  },
);
