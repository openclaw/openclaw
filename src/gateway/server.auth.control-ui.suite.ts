import { expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  approvePendingPairingIfNeeded,
  BACKEND_GATEWAY_CLIENT,
  buildDeviceAuthPayload,
  connectReq,
  configureTrustedProxyControlUiAuth,
  CONTROL_UI_CLIENT,
  ConnectErrorDetailCodes,
  createSignedDevice,
  ensurePairedDeviceTokenForCurrentIdentity,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  onceMessage,
  openWs,
  originForPort,
  readConnectChallengeNonce,
  restoreGatewayToken,
  rpcReq,
  startRateLimitedTokenServerWithPairedDeviceToken,
  startServerWithClient,
  TEST_OPERATOR_CLIENT,
  testState,
  TRUSTED_PROXY_CONTROL_UI_HEADERS,
  withGatewayServer,
  writeTrustedProxyControlUiConfig,
} from "./server.auth.shared.js";

export function registerControlUiAndPairingSuite(): void {
  const trustedProxyControlUiCases: Array<{
    name: string;
    role: "operator" | "node";
    withUnpairedNodeDevice: boolean;
    expectedOk: boolean;
    expectedErrorSubstring?: string;
    expectedErrorCode?: string;
    expectStatusChecks: boolean;
  }> = [
    {
      name: "allows trusted-proxy control ui operator without device identity",
      role: "operator",
      withUnpairedNodeDevice: false,
      expectedOk: true,
      expectStatusChecks: true,
    },
    {
      name: "rejects trusted-proxy control ui node role without device identity",
      role: "node",
      withUnpairedNodeDevice: false,
      expectedOk: false,
      expectedErrorSubstring: "control ui requires device identity",
      expectedErrorCode: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
      expectStatusChecks: false,
    },
    {
      name: "requires pairing for trusted-proxy control ui node role with unpaired device",
      role: "node",
      withUnpairedNodeDevice: true,
      expectedOk: false,
      expectedErrorSubstring: "pairing required",
      expectedErrorCode: ConnectErrorDetailCodes.PAIRING_REQUIRED,
      expectStatusChecks: false,
    },
  ];

  for (const tc of trustedProxyControlUiCases) {
    test(tc.name, async () => {
      await configureTrustedProxyControlUiAuth();
      await withGatewayServer(async ({ port }) => {
        const ws = await openWs(port, TRUSTED_PROXY_CONTROL_UI_HEADERS);
        const scopes = tc.withUnpairedNodeDevice ? [] : undefined;
        let device: Awaited<ReturnType<typeof createSignedDevice>>["device"] | null = null;
        if (tc.withUnpairedNodeDevice) {
          const challengeNonce = await readConnectChallengeNonce(ws);
          expect(challengeNonce).toBeTruthy();
          ({ device } = await createSignedDevice({
            token: null,
            role: "node",
            scopes: [],
            clientId: GATEWAY_CLIENT_NAMES.CONTROL_UI,
            clientMode: GATEWAY_CLIENT_MODES.WEBCHAT,
            nonce: String(challengeNonce),
          }));
        }
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          role: tc.role,
          scopes,
          device,
          client: { ...CONTROL_UI_CLIENT },
        });
        expect(res.ok).toBe(tc.expectedOk);
        if (!tc.expectedOk) {
          if (tc.expectedErrorSubstring) {
            expect(res.error?.message ?? "").toContain(tc.expectedErrorSubstring);
          }
          if (tc.expectedErrorCode) {
            expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
              tc.expectedErrorCode,
            );
          }
          ws.close();
          return;
        }
        if (tc.expectStatusChecks) {
          const status = await rpcReq(ws, "status");
          expect(status.ok).toBe(true);
          const health = await rpcReq(ws, "health");
          expect(health.ok).toBe(true);
        }
        ws.close();
      });
    });
  }

  test("allows localhost control ui without device identity when insecure auth is enabled", async () => {
    testState.gatewayControlUi = { allowInsecureAuth: true };
    const { server, ws, prevToken } = await startServerWithClient("secret", {
      wsHeaders: { origin: "http://127.0.0.1" },
    });
    const res = await connectReq(ws, {
      token: "secret",
      device: null,
      client: {
        id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        version: "1.0.0",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });
    expect(res.ok).toBe(true);
    const status = await rpcReq(ws, "status");
    expect(status.ok).toBe(true);
    const health = await rpcReq(ws, "health");
    expect(health.ok).toBe(true);
    ws.close();
    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("allows control ui password-only auth on localhost when insecure auth is enabled", async () => {
    testState.gatewayControlUi = { allowInsecureAuth: true };
    testState.gatewayAuth = { mode: "password", password: "secret" };
    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, { origin: originForPort(port) });
      const res = await connectReq(ws, {
        password: "secret",
        device: null,
        client: {
          ...CONTROL_UI_CLIENT,
        },
      });
      expect(res.ok).toBe(true);
      const status = await rpcReq(ws, "status");
      expect(status.ok).toBe(true);
      const health = await rpcReq(ws, "health");
      expect(health.ok).toBe(true);
      ws.close();
    });
  });

  test("does not bypass pairing for control ui device identity when insecure auth is enabled", async () => {
    testState.gatewayControlUi = {
      allowInsecureAuth: true,
      allowedOrigins: ["https://localhost"],
    };
    testState.gatewayAuth = { mode: "token", token: "secret" };
    await writeTrustedProxyControlUiConfig({ allowInsecureAuth: true });
    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
    try {
      await withGatewayServer(async ({ port }) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: {
            origin: "https://localhost",
            "x-forwarded-for": "203.0.113.10",
          },
        });
        const challengePromise = onceMessage<{
          type?: string;
          event?: string;
          payload?: Record<string, unknown> | null;
        }>(ws, (o) => o.type === "event" && o.event === "connect.challenge");
        await new Promise<void>((resolve) => ws.once("open", resolve));
        const challenge = await challengePromise;
        const nonce = (challenge.payload as { nonce?: unknown } | undefined)?.nonce;
        expect(typeof nonce).toBe("string");
        const { randomUUID } = await import("node:crypto");
        const os = await import("node:os");
        const path = await import("node:path");
        const scopes = [
          "operator.admin",
          "operator.read",
          "operator.write",
          "operator.approvals",
          "operator.pairing",
        ];
        const { device } = await createSignedDevice({
          token: "secret",
          scopes,
          clientId: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          clientMode: GATEWAY_CLIENT_MODES.WEBCHAT,
          identityPath: path.join(os.tmpdir(), `openclaw-controlui-device-${randomUUID()}.json`),
          nonce: String(nonce),
        });
        const res = await connectReq(ws, {
          token: "secret",
          scopes,
          device,
          client: {
            ...CONTROL_UI_CLIENT,
          },
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("pairing required");
        expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
          ConnectErrorDetailCodes.PAIRING_REQUIRED,
        );
        ws.close();
      });
    } finally {
      restoreGatewayToken(prevToken);
    }
  });

  test("allows control ui with stale device identity when device auth is disabled", async () => {
    testState.gatewayControlUi = { dangerouslyDisableDeviceAuth: true };
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
    try {
      await withGatewayServer(async ({ port }) => {
        const ws = await openWs(port, { origin: originForPort(port) });
        const challengeNonce = await readConnectChallengeNonce(ws);
        expect(challengeNonce).toBeTruthy();
        const { device } = await createSignedDevice({
          token: "secret",
          scopes: [],
          clientId: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          clientMode: GATEWAY_CLIENT_MODES.WEBCHAT,
          signedAtMs: Date.now() - 60 * 60 * 1000,
          nonce: String(challengeNonce),
        });
        const res = await connectReq(ws, {
          token: "secret",
          scopes: ["operator.read"],
          device,
          client: {
            ...CONTROL_UI_CLIENT,
          },
        });
        expect(res.ok).toBe(true);
        expect((res.payload as { auth?: unknown } | undefined)?.auth).toBeUndefined();
        const health = await rpcReq(ws, "health");
        expect(health.ok).toBe(true);
        ws.close();
      });
    } finally {
      restoreGatewayToken(prevToken);
    }
  });

  test("device token auth matrix", async () => {
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    const { deviceToken, deviceIdentityPath } = await ensurePairedDeviceTokenForCurrentIdentity(ws);
    ws.close();

    const scenarios: Array<{
      name: string;
      opts: Parameters<typeof connectReq>[1];
      assert: (res: Awaited<ReturnType<typeof connectReq>>) => void;
    }> = [
      {
        name: "accepts device token auth for paired device",
        opts: { token: deviceToken },
        assert: (res) => {
          expect(res.ok).toBe(true);
        },
      },
      {
        name: "accepts explicit auth.deviceToken when shared token is omitted",
        opts: {
          skipDefaultAuth: true,
          deviceToken,
        },
        assert: (res) => {
          expect(res.ok).toBe(true);
        },
      },
      {
        name: "uses explicit auth.deviceToken fallback when shared token is wrong",
        opts: {
          token: "wrong",
          deviceToken,
        },
        assert: (res) => {
          expect(res.ok).toBe(true);
        },
      },
      {
        name: "keeps shared token mismatch reason when fallback device-token check fails",
        opts: { token: "wrong" },
        assert: (res) => {
          expect(res.ok).toBe(false);
          expect(res.error?.message ?? "").toContain("gateway token mismatch");
          expect(res.error?.message ?? "").not.toContain("device token mismatch");
          expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
            ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
          );
        },
      },
      {
        name: "reports device token mismatch when explicit auth.deviceToken is wrong",
        opts: {
          skipDefaultAuth: true,
          deviceToken: "not-a-valid-device-token",
        },
        assert: (res) => {
          expect(res.ok).toBe(false);
          expect(res.error?.message ?? "").toContain("device token mismatch");
          expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
            ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH,
          );
        },
      },
    ];

    try {
      for (const scenario of scenarios) {
        const ws2 = await openWs(port);
        try {
          const res = await connectReq(ws2, {
            ...scenario.opts,
            deviceIdentityPath,
          });
          scenario.assert(res);
        } finally {
          ws2.close();
        }
      }
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("keeps shared-secret lockout separate from device-token auth", async () => {
    const { server, port, prevToken, deviceToken, deviceIdentityPath } =
      await startRateLimitedTokenServerWithPairedDeviceToken();
    try {
      const wsBadShared = await openWs(port);
      const badShared = await connectReq(wsBadShared, { token: "wrong", device: null });
      expect(badShared.ok).toBe(false);
      wsBadShared.close();

      const wsSharedLocked = await openWs(port);
      const sharedLocked = await connectReq(wsSharedLocked, { token: "secret", device: null });
      expect(sharedLocked.ok).toBe(false);
      expect(sharedLocked.error?.message ?? "").toContain("retry later");
      wsSharedLocked.close();

      const wsDevice = await openWs(port);
      const deviceOk = await connectReq(wsDevice, { token: deviceToken, deviceIdentityPath });
      expect(deviceOk.ok).toBe(true);
      wsDevice.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("keeps device-token lockout separate from shared-secret auth", async () => {
    const { server, port, prevToken, deviceToken, deviceIdentityPath } =
      await startRateLimitedTokenServerWithPairedDeviceToken();
    try {
      const wsBadDevice = await openWs(port);
      const badDevice = await connectReq(wsBadDevice, { token: "wrong", deviceIdentityPath });
      expect(badDevice.ok).toBe(false);
      wsBadDevice.close();

      const wsDeviceLocked = await openWs(port);
      const deviceLocked = await connectReq(wsDeviceLocked, { token: "wrong", deviceIdentityPath });
      expect(deviceLocked.ok).toBe(false);
      expect(deviceLocked.error?.message ?? "").toContain("retry later");
      wsDeviceLocked.close();

      const wsShared = await openWs(port);
      const sharedOk = await connectReq(wsShared, { token: "secret", device: null });
      expect(sharedOk.ok).toBe(true);
      wsShared.close();

      const wsDeviceReal = await openWs(port);
      const deviceStillLocked = await connectReq(wsDeviceReal, {
        token: deviceToken,
        deviceIdentityPath,
      });
      expect(deviceStillLocked.ok).toBe(false);
      expect(deviceStillLocked.error?.message ?? "").toContain("retry later");
      wsDeviceReal.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("requires pairing for remote operator device identity with shared token auth", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { buildDeviceAuthPayload } = await import("./device-auth.js");
    const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
      await import("../infra/device-identity.js");
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    const identityDir = await mkdtemp(join(tmpdir(), "openclaw-device-scope-"));
    const identity = loadOrCreateDeviceIdentity(join(identityDir, "device.json"));
    const client = {
      id: GATEWAY_CLIENT_NAMES.TEST,
      version: "1.0.0",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.TEST,
    };
    const buildDevice = (scopes: string[], nonce: string) => {
      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayload({
        deviceId: identity.deviceId,
        clientId: client.id,
        clientMode: client.mode,
        role: "operator",
        scopes,
        signedAtMs,
        token: "secret",
        nonce,
      });
      return {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt: signedAtMs,
        nonce,
      };
    };
    ws.close();

    const wsRemoteRead = await openWs(port, { host: "gateway.example" });
    const initialNonce = await readConnectChallengeNonce(wsRemoteRead);
    const initial = await connectReq(wsRemoteRead, {
      token: "secret",
      scopes: ["operator.read"],
      client,
      device: buildDevice(["operator.read"], initialNonce),
    });
    expect(initial.ok).toBe(false);
    expect(initial.error?.message ?? "").toContain("pairing required");
    let pairing = await listDevicePairing();
    const pendingAfterRead = pairing.pending.filter(
      (entry) => entry.deviceId === identity.deviceId,
    );
    expect(pendingAfterRead).toHaveLength(1);
    expect(pendingAfterRead[0]?.role).toBe("operator");
    expect(pendingAfterRead[0]?.scopes ?? []).toContain("operator.read");
    expect(await getPairedDevice(identity.deviceId)).toBeNull();
    wsRemoteRead.close();

    const ws2 = await openWs(port, { host: "gateway.example" });
    const nonce2 = await readConnectChallengeNonce(ws2);
    const res = await connectReq(ws2, {
      token: "secret",
      scopes: ["operator.admin"],
      client,
      device: buildDevice(["operator.admin"], nonce2),
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("pairing required");
    pairing = await listDevicePairing();
    const pendingAfterAdmin = pairing.pending.filter(
      (entry) => entry.deviceId === identity.deviceId,
    );
    expect(pendingAfterAdmin).toHaveLength(1);
    expect(pendingAfterAdmin[0]?.scopes ?? []).toEqual(
      expect.arrayContaining(["operator.read", "operator.admin"]),
    );
    expect(await getPairedDevice(identity.deviceId)).toBeNull();
    ws2.close();
    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("auto-approves loopback scope upgrades for control ui clients", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { buildDeviceAuthPayload } = await import("./device-auth.js");
    const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
      await import("../infra/device-identity.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    const identityDir = await mkdtemp(join(tmpdir(), "openclaw-device-token-scope-"));
    const identity = loadOrCreateDeviceIdentity(join(identityDir, "device.json"));
    const devicePublicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
    const buildDevice = (scopes: string[], nonce: string) => {
      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayload({
        deviceId: identity.deviceId,
        clientId: CONTROL_UI_CLIENT.id,
        clientMode: CONTROL_UI_CLIENT.mode,
        role: "operator",
        scopes,
        signedAtMs,
        token: "secret",
        nonce,
      });
      return {
        id: identity.deviceId,
        publicKey: devicePublicKey,
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt: signedAtMs,
        nonce,
      };
    };
    const seeded = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey: devicePublicKey,
      role: "operator",
      scopes: ["operator.read"],
      clientId: CONTROL_UI_CLIENT.id,
      clientMode: CONTROL_UI_CLIENT.mode,
      displayName: "loopback-control-ui-upgrade",
      platform: CONTROL_UI_CLIENT.platform,
    });
    await approveDevicePairing(seeded.request.requestId);

    ws.close();

    const ws2 = await openWs(port, { origin: originForPort(port) });
    const nonce2 = await readConnectChallengeNonce(ws2);
    const upgraded = await connectReq(ws2, {
      token: "secret",
      scopes: ["operator.admin"],
      client: { ...CONTROL_UI_CLIENT },
      device: buildDevice(["operator.admin"], nonce2),
    });
    expect(upgraded.ok).toBe(true);
    const pending = await listDevicePairing();
    expect(pending.pending.filter((entry) => entry.deviceId === identity.deviceId)).toEqual([]);
    const updated = await getPairedDevice(identity.deviceId);
    expect(updated?.tokens?.operator?.scopes).toContain("operator.admin");

    ws2.close();
    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("merges remote node/operator pairing requests for the same unpaired device", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
      await import("../infra/device-identity.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing } =
      await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    ws.close();
    const identityDir = await mkdtemp(join(tmpdir(), "openclaw-device-scope-"));
    const identity = loadOrCreateDeviceIdentity(join(identityDir, "device.json"));
    const client = {
      id: GATEWAY_CLIENT_NAMES.TEST,
      version: "1.0.0",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.TEST,
    };
    const buildDevice = (role: "operator" | "node", scopes: string[], nonce: string) => {
      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayload({
        deviceId: identity.deviceId,
        clientId: client.id,
        clientMode: client.mode,
        role,
        scopes,
        signedAtMs,
        token: "secret",
        nonce,
      });
      return {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt: signedAtMs,
        nonce,
      };
    };
    const connectWithNonce = async (role: "operator" | "node", scopes: string[]) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { host: "gateway.example" },
      });
      const challengePromise = onceMessage<{
        type?: string;
        event?: string;
        payload?: Record<string, unknown> | null;
      }>(socket, (o) => o.type === "event" && o.event === "connect.challenge");
      await new Promise<void>((resolve) => socket.once("open", resolve));
      const challenge = await challengePromise;
      const nonce = (challenge.payload as { nonce?: unknown } | undefined)?.nonce;
      expect(typeof nonce).toBe("string");
      const result = await connectReq(socket, {
        token: "secret",
        role,
        scopes,
        client,
        device: buildDevice(role, scopes, String(nonce)),
      });
      socket.close();
      return result;
    };

    const nodeConnect = await connectWithNonce("node", []);
    expect(nodeConnect.ok).toBe(false);
    expect(nodeConnect.error?.message ?? "").toContain("pairing required");

    const operatorConnect = await connectWithNonce("operator", ["operator.read", "operator.write"]);
    expect(operatorConnect.ok).toBe(false);
    expect(operatorConnect.error?.message ?? "").toContain("pairing required");

    const pending = await listDevicePairing();
    const pendingForTestDevice = pending.pending.filter(
      (entry) => entry.deviceId === identity.deviceId,
    );
    expect(pendingForTestDevice).toHaveLength(1);
    expect(pendingForTestDevice[0]?.roles).toEqual(expect.arrayContaining(["node", "operator"]));
    expect(pendingForTestDevice[0]?.scopes ?? []).toEqual(
      expect.arrayContaining(["operator.read", "operator.write"]),
    );
    if (!pendingForTestDevice[0]) {
      throw new Error("expected pending pairing request");
    }
    await approveDevicePairing(pendingForTestDevice[0].requestId);

    const paired = await getPairedDevice(identity.deviceId);
    expect(paired?.roles).toEqual(expect.arrayContaining(["node", "operator"]));

    const approvedOperatorConnect = await connectWithNonce("operator", ["operator.read"]);
    expect(approvedOperatorConnect.ok).toBe(true);

    const afterApproval = await listDevicePairing();
    expect(afterApproval.pending.filter((entry) => entry.deviceId === identity.deviceId)).toEqual(
      [],
    );

    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("allows operator.read connect when device is paired with operator.admin", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
      await import("../infra/device-identity.js");
    const { listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    const identityDir = await mkdtemp(join(tmpdir(), "openclaw-device-scope-"));
    const identity = loadOrCreateDeviceIdentity(join(identityDir, "device.json"));
    const client = {
      id: GATEWAY_CLIENT_NAMES.TEST,
      version: "1.0.0",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.TEST,
    };
    const buildDevice = (scopes: string[], nonce: string) => {
      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayload({
        deviceId: identity.deviceId,
        clientId: client.id,
        clientMode: client.mode,
        role: "operator",
        scopes,
        signedAtMs,
        token: "secret",
        nonce,
      });
      return {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt: signedAtMs,
        nonce,
      };
    };

    const initialNonce = await readConnectChallengeNonce(ws);
    const initial = await connectReq(ws, {
      token: "secret",
      scopes: ["operator.admin"],
      client,
      device: buildDevice(["operator.admin"], initialNonce),
    });
    if (!initial.ok) {
      await approvePendingPairingIfNeeded();
    }

    ws.close();

    const ws2 = await openWs(port);
    const nonce2 = await readConnectChallengeNonce(ws2);
    const res = await connectReq(ws2, {
      token: "secret",
      scopes: ["operator.read"],
      client,
      device: buildDevice(["operator.read"], nonce2),
    });
    expect(res.ok).toBe(true);
    ws2.close();

    const list = await listDevicePairing();
    expect(list.pending.filter((entry) => entry.deviceId === identity.deviceId)).toEqual([]);

    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("allows operator shared auth with legacy paired metadata", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { buildDeviceAuthPayload } = await import("./device-auth.js");
    const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
      await import("../infra/device-identity.js");
    const { resolvePairingPaths, readJsonFile } = await import("../infra/pairing-files.js");
    const { writeJsonAtomic } = await import("../infra/json-files.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const identityDir = await mkdtemp(join(tmpdir(), "openclaw-device-legacy-meta-"));
    const identity = loadOrCreateDeviceIdentity(join(identityDir, "device.json"));
    const deviceId = identity.deviceId;
    const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
    const pending = await requestDevicePairing({
      deviceId,
      publicKey,
      role: "operator",
      scopes: ["operator.read"],
      clientId: TEST_OPERATOR_CLIENT.id,
      clientMode: TEST_OPERATOR_CLIENT.mode,
      displayName: "legacy-test",
      platform: "test",
    });
    await approveDevicePairing(pending.request.requestId);

    const { pairedPath } = resolvePairingPaths(undefined, "devices");
    const paired = (await readJsonFile<Record<string, Record<string, unknown>>>(pairedPath)) ?? {};
    const legacy = paired[deviceId];
    if (!legacy) {
      throw new Error(`Expected paired metadata for deviceId=${deviceId}`);
    }
    delete legacy.roles;
    delete legacy.scopes;
    await writeJsonAtomic(pairedPath, paired);

    const buildDevice = (nonce: string) => {
      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayload({
        deviceId,
        clientId: TEST_OPERATOR_CLIENT.id,
        clientMode: TEST_OPERATOR_CLIENT.mode,
        role: "operator",
        scopes: ["operator.read"],
        signedAtMs,
        token: "secret",
        nonce,
      });
      return {
        id: deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt: signedAtMs,
        nonce,
      };
    };
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    let ws2: WebSocket | undefined;
    try {
      ws.close();

      const wsReconnect = await openWs(port);
      ws2 = wsReconnect;
      const reconnectNonce = await readConnectChallengeNonce(wsReconnect);
      const reconnect = await connectReq(wsReconnect, {
        token: "secret",
        scopes: ["operator.read"],
        client: TEST_OPERATOR_CLIENT,
        device: buildDevice(reconnectNonce),
      });
      expect(reconnect.ok).toBe(true);

      const repaired = await getPairedDevice(deviceId);
      expect(repaired?.roles ?? []).toContain("operator");
      expect(repaired?.scopes ?? []).toContain("operator.read");
      const list = await listDevicePairing();
      expect(list.pending.filter((entry) => entry.deviceId === deviceId)).toEqual([]);
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
      ws.close();
      ws2?.close();
    }
  });

  test("auto-approves local scope upgrades even when paired metadata is legacy-shaped", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readJsonFile, resolvePairingPaths } = await import("../infra/pairing-files.js");
    const { writeJsonAtomic } = await import("../infra/json-files.js");
    const { buildDeviceAuthPayload } = await import("./device-auth.js");
    const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
      await import("../infra/device-identity.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } =
      await import("../utils/message-channel.js");
    const identityDir = await mkdtemp(join(tmpdir(), "openclaw-device-legacy-"));
    const identity = loadOrCreateDeviceIdentity(join(identityDir, "device.json"));
    const devicePublicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
    const seeded = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey: devicePublicKey,
      role: "operator",
      scopes: ["operator.read"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
      displayName: "legacy-upgrade-test",
      platform: "test",
    });
    await approveDevicePairing(seeded.request.requestId);

    const { pairedPath } = resolvePairingPaths(undefined, "devices");
    const paired = (await readJsonFile<Record<string, Record<string, unknown>>>(pairedPath)) ?? {};
    const legacy = paired[identity.deviceId];
    expect(legacy).toBeTruthy();
    if (!legacy) {
      throw new Error(`Expected paired metadata for deviceId=${identity.deviceId}`);
    }
    delete legacy.roles;
    delete legacy.scopes;
    await writeJsonAtomic(pairedPath, paired);

    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    let ws2: WebSocket | undefined;
    try {
      const client = {
        id: GATEWAY_CLIENT_NAMES.TEST,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.TEST,
      };
      const buildDevice = (scopes: string[], nonce: string) => {
        const signedAtMs = Date.now();
        const payload = buildDeviceAuthPayload({
          deviceId: identity.deviceId,
          clientId: client.id,
          clientMode: client.mode,
          role: "operator",
          scopes,
          signedAtMs,
          token: "secret",
          nonce,
        });
        return {
          id: identity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
          signature: signDevicePayload(identity.privateKeyPem, payload),
          signedAt: signedAtMs,
          nonce,
        };
      };

      ws.close();

      const wsUpgrade = await openWs(port);
      ws2 = wsUpgrade;
      const upgradeNonce = await readConnectChallengeNonce(wsUpgrade);
      const upgraded = await connectReq(wsUpgrade, {
        token: "secret",
        scopes: ["operator.admin"],
        client,
        device: buildDevice(["operator.admin"], upgradeNonce),
      });
      expect(upgraded.ok).toBe(true);
      wsUpgrade.close();

      const pendingUpgrade = (await listDevicePairing()).pending.find(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pendingUpgrade).toBeUndefined();
      const repaired = await getPairedDevice(identity.deviceId);
      expect(repaired?.role).toBe("operator");
      expect(repaired?.roles ?? []).toContain("operator");
      expect(repaired?.scopes ?? []).toEqual(
        expect.arrayContaining(["operator.read", "operator.admin"]),
      );
      expect(repaired?.approvedScopes ?? []).toEqual(
        expect.arrayContaining(["operator.read", "operator.admin"]),
      );
    } finally {
      ws.close();
      ws2?.close();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("rejects revoked device token", async () => {
    const { revokeDeviceToken } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    const { identity, deviceToken, deviceIdentityPath } =
      await ensurePairedDeviceTokenForCurrentIdentity(ws);

    await revokeDeviceToken({ deviceId: identity.deviceId, role: "operator" });

    ws.close();

    const ws2 = await openWs(port);
    const res2 = await connectReq(ws2, { token: deviceToken, deviceIdentityPath });
    expect(res2.ok).toBe(false);

    ws2.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
    }
  });

  test("allows local gateway backend shared-auth connections without device pairing", async () => {
    const { server, ws, prevToken } = await startServerWithClient("secret");
    try {
      const localBackend = await connectReq(ws, {
        token: "secret",
        client: BACKEND_GATEWAY_CLIENT,
      });
      expect(localBackend.ok).toBe(true);
    } finally {
      ws.close();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("requires pairing for gateway backend clients when connection is not local-direct", async () => {
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    ws.close();
    const wsRemoteLike = await openWs(port, { host: "gateway.example" });
    try {
      const remoteLikeBackend = await connectReq(wsRemoteLike, {
        token: "secret",
        client: BACKEND_GATEWAY_CLIENT,
      });
      expect(remoteLikeBackend.ok).toBe(false);
      expect(remoteLikeBackend.error?.message ?? "").toContain("pairing required");
    } finally {
      wsRemoteLike.close();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });
}
