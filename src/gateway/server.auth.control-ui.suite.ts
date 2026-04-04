import { expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import {
  approvePendingPairingIfNeeded,
  BACKEND_GATEWAY_CLIENT,
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
  waitForWsClose,
  withGatewayServer,
  writeTrustedProxyControlUiConfig,
} from "./server.auth.shared.js";

let controlUiIdentityPathSeq = 0;

export function registerControlUiAndPairingSuite(): void {
  const trustedProxyControlUiCases: Array<{
    name: string;
    role: "operator" | "node";
    withUnpairedNodeDevice: boolean;
    expectedOk: boolean;
    expectedErrorSubstring?: string;
    expectedErrorCode?: string;
  }> = [
    {
      name: "allows trusted-proxy control ui operator without device identity",
      role: "operator",
      withUnpairedNodeDevice: false,
      expectedOk: true,
    },
    {
      name: "rejects trusted-proxy control ui node role without device identity",
      role: "node",
      withUnpairedNodeDevice: false,
      expectedOk: false,
      expectedErrorSubstring: "control ui requires device identity",
      expectedErrorCode: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
    },
    {
      name: "requires pairing for trusted-proxy control ui node role with unpaired device",
      role: "node",
      withUnpairedNodeDevice: true,
      expectedOk: false,
      expectedErrorSubstring: "pairing required",
      expectedErrorCode: ConnectErrorDetailCodes.PAIRING_REQUIRED,
    },
  ];

  const buildSignedDeviceForIdentity = async (params: {
    identityPath: string;
    client: { id: string; mode: string };
    nonce: string;
    scopes: string[];
    role?: "operator" | "node";
  }) => {
    const { device } = await createSignedDevice({
      token: "secret",
      scopes: params.scopes,
      clientId: params.client.id,
      clientMode: params.client.mode,
      role: params.role ?? "operator",
      identityPath: params.identityPath,
      nonce: params.nonce,
    });
    return device;
  };

  const REMOTE_BOOTSTRAP_HEADERS = {
    "x-forwarded-for": "10.0.0.14",
  };

  const expectStatusAndHealthOk = async (ws: WebSocket) => {
    const status = await rpcReq(ws, "status");
    expect(status.ok).toBe(true);
    const health = await rpcReq(ws, "health");
    expect(health.ok).toBe(true);
  };

  const expectAdminRpcOk = async (ws: WebSocket) => {
    const admin = await rpcReq(ws, "set-heartbeats", { enabled: false });
    expect(admin.ok).toBe(true);
  };

  const expectStatusMissingScopeButHealthOk = async (ws: WebSocket) => {
    const status = await rpcReq(ws, "status");
    expect(status.ok).toBe(false);
    expect(status.error?.message ?? "").toContain("missing scope");
    const health = await rpcReq(ws, "health");
    expect(health.ok).toBe(true);
  };

  const expectAdminRpcDenied = async (ws: WebSocket) => {
    const admin = await rpcReq(ws, "set-heartbeats", { enabled: false });
    expect(admin.ok).toBe(false);
    expect(admin.error?.message).toBe("missing scope: operator.admin");
  };

  const expectTalkSecretsDenied = async (ws: WebSocket) => {
    const talk = await rpcReq(ws, "talk.config", { includeSecrets: true });
    expect(talk.ok).toBe(false);
    expect(talk.error?.message).toBe("missing scope: operator.read");
  };

  const expectDevicePairApproveDenied = async (ws: WebSocket, requestId: string) => {
    const approve = await rpcReq(ws, "device.pair.approve", { requestId });
    expect(approve.ok).toBe(false);
    expect(approve.error?.message ?? "").toMatch(/^missing scope: operator\.(admin|pairing)$/);
  };

  const connectControlUiWithoutDeviceAndExpectOk = async (params: {
    ws: WebSocket;
    token?: string;
    password?: string;
    client?: { id: string; version: string; platform: string; mode: string };
  }) => {
    const res = await connectReq(params.ws, {
      ...(params.token ? { token: params.token } : {}),
      ...(params.password ? { password: params.password } : {}),
      device: null,
      client: { ...(params.client ?? CONTROL_UI_CLIENT) },
    });
    expect(res.ok).toBe(true);
    await expectStatusAndHealthOk(params.ws);
    await expectAdminRpcOk(params.ws);
  };

  const createOperatorIdentityFixture = async (identityPrefix: string) => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
    const identityDir = await mkdtemp(join(tmpdir(), identityPrefix));
    const identityPath = join(identityDir, "device.json");
    const identity = loadOrCreateDeviceIdentity(identityPath);
    return {
      identityPath,
      identity,
      client: { ...TEST_OPERATOR_CLIENT },
    };
  };

  const startServerWithOperatorIdentity = async (identityPrefix = "openclaw-device-scope-") => {
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    const { identityPath, identity, client } = await createOperatorIdentityFixture(identityPrefix);
    return { server, ws, port, prevToken, identityPath, identity, client };
  };

  const getRequiredPairedMetadata = (
    paired: Record<string, Record<string, unknown>>,
    deviceId: string,
  ) => {
    const metadata = paired[deviceId];
    expect(metadata).toBeTruthy();
    if (!metadata) {
      throw new Error(`Expected paired metadata for deviceId=${deviceId}`);
    }
    return metadata;
  };

  const stripPairedMetadataRolesAndScopes = async (deviceId: string) => {
    const { resolvePairingPaths, readJsonFile } = await import("../infra/pairing-files.js");
    const { writeJsonAtomic } = await import("../infra/json-files.js");
    const { pairedPath } = resolvePairingPaths(undefined, "devices");
    const paired = (await readJsonFile<Record<string, Record<string, unknown>>>(pairedPath)) ?? {};
    const legacy = getRequiredPairedMetadata(paired, deviceId);
    delete legacy.roles;
    delete legacy.scopes;
    await writeJsonAtomic(pairedPath, paired);
  };

  const seedApprovedOperatorReadPairing = async (params: {
    identityPrefix: string;
    clientId: string;
    clientMode: string;
    displayName: string;
    platform: string;
  }): Promise<{ identityPath: string; identity: { deviceId: string } }> => {
    const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
    const { approveDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const { identityPath, identity } = await createOperatorIdentityFixture(params.identityPrefix);
    const devicePublicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
    const seeded = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey: devicePublicKey,
      role: "operator",
      scopes: ["operator.read"],
      clientId: params.clientId,
      clientMode: params.clientMode,
      displayName: params.displayName,
      platform: params.platform,
    });
    await approveDevicePairing(seeded.request.requestId, {
      callerScopes: ["operator.admin"],
    });
    return { identityPath, identity: { deviceId: identity.deviceId } };
  };

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
        ws.close();
      });
    });
  }

  test("clears self-declared scopes for trusted-proxy control ui without device identity", async () => {
    await configureTrustedProxyControlUiAuth();
    const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
    const { rejectDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const { identity } = await createOperatorIdentityFixture("openclaw-control-ui-trusted-proxy-");
    const pendingRequest = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      role: "operator",
      scopes: ["operator.admin"],
      clientId: CONTROL_UI_CLIENT.id,
      clientMode: CONTROL_UI_CLIENT.mode,
    });
    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, TRUSTED_PROXY_CONTROL_UI_HEADERS);
      try {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          scopes: ["operator.admin"],
          device: null,
          client: { ...CONTROL_UI_CLIENT },
        });
        expect(res.ok).toBe(true);
        expect((res.payload as { auth?: unknown } | undefined)?.auth).toBeUndefined();

        await expectStatusMissingScopeButHealthOk(ws);
        await expectAdminRpcDenied(ws);
        await expectTalkSecretsDenied(ws);
        await expectDevicePairApproveDenied(ws, pendingRequest.request.requestId);
      } finally {
        ws.close();
        await rejectDevicePairing(pendingRequest.request.requestId);
      }
    });
  });

  test("allows localhost control ui without device identity when insecure auth is enabled", async () => {
    testState.gatewayControlUi = { allowInsecureAuth: true };
    const { server, ws, prevToken } = await startServerWithClient("secret", {
      wsHeaders: { origin: "http://127.0.0.1" },
    });
    await connectControlUiWithoutDeviceAndExpectOk({ ws, token: "secret" });
    ws.close();
    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("allows localhost tui without device identity when insecure auth is enabled", async () => {
    testState.gatewayControlUi = { allowInsecureAuth: true };
    const { server, ws, prevToken } = await startServerWithClient("secret");
    await connectControlUiWithoutDeviceAndExpectOk({
      ws,
      token: "secret",
      client: {
        id: GATEWAY_CLIENT_NAMES.TUI,
        version: "1.0.0",
        platform: "darwin",
        mode: GATEWAY_CLIENT_MODES.UI,
      },
    });
    ws.close();
    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("allows control ui password-only auth on localhost when insecure auth is enabled", async () => {
    testState.gatewayControlUi = { allowInsecureAuth: true };
    testState.gatewayAuth = { mode: "password", password: "secret" }; // pragma: allowlist secret
    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, { origin: originForPort(port) });
      await connectControlUiWithoutDeviceAndExpectOk({ ws, password: "secret" }); // pragma: allowlist secret
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
          identityPath: path.join(
            os.tmpdir(),
            `openclaw-controlui-device-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}-${controlUiIdentityPathSeq++}.json`,
          ),
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

  test("preserves requested control ui scopes when dangerouslyDisableDeviceAuth bypasses device identity", async () => {
    testState.gatewayControlUi = { dangerouslyDisableDeviceAuth: true };
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "secret";
    try {
      await withGatewayServer(async ({ port }) => {
        const ws = await openWs(port, { origin: originForPort(port) });
        const res = await connectReq(ws, {
          token: "secret",
          scopes: ["operator.read"],
          client: {
            ...CONTROL_UI_CLIENT,
          },
        });
        expect(res.ok).toBe(true);

        const health = await rpcReq(ws, "health");
        expect(health.ok).toBe(true);

        const talk = await rpcReq(ws, "chat.history", { sessionKey: "main", limit: 1 });
        expect(talk.ok).toBe(true);
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
          const details = res.error?.details as
            | {
                code?: string;
                canRetryWithDeviceToken?: boolean;
                recommendedNextStep?: string;
              }
            | undefined;
          expect(details?.code).toBe(ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH);
          expect(details?.canRetryWithDeviceToken).toBe(true);
          expect(details?.recommendedNextStep).toBe("retry_with_device_token");
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
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken, identityPath, identity, client } =
      await startServerWithOperatorIdentity();
    ws.close();

    const wsRemoteRead = await openWs(port, { host: "gateway.example" });
    const initialNonce = await readConnectChallengeNonce(wsRemoteRead);
    const initial = await connectReq(wsRemoteRead, {
      token: "secret",
      scopes: ["operator.read"],
      client,
      device: await buildSignedDeviceForIdentity({
        identityPath,
        client,
        scopes: ["operator.read"],
        nonce: initialNonce,
      }),
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
      device: await buildSignedDeviceForIdentity({
        identityPath,
        client,
        scopes: ["operator.admin"],
        nonce: nonce2,
      }),
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
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    const { identity, identityPath } = await seedApprovedOperatorReadPairing({
      identityPrefix: "openclaw-device-token-scope-",
      clientId: CONTROL_UI_CLIENT.id,
      clientMode: CONTROL_UI_CLIENT.mode,
      displayName: "loopback-control-ui-upgrade",
      platform: CONTROL_UI_CLIENT.platform,
    });

    ws.close();

    const ws2 = await openWs(port, { origin: originForPort(port) });
    const nonce2 = await readConnectChallengeNonce(ws2);
    const upgraded = await connectReq(ws2, {
      token: "secret",
      scopes: ["operator.admin"],
      client: { ...CONTROL_UI_CLIENT },
      device: await buildSignedDeviceForIdentity({
        identityPath,
        client: CONTROL_UI_CLIENT,
        scopes: ["operator.admin"],
        nonce: nonce2,
      }),
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

  test("auto-approves fresh node-only bootstrap pairing and revokes the token after connect", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    ws.close();

    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-node-",
    );
    const client = {
      id: "openclaw-ios",
      version: "2026.3.30",
      platform: "iOS 26.3.1",
      mode: "node",
      deviceFamily: "iPhone",
    };

    try {
      const issued = await issueDeviceBootstrapToken({
        profile: {
          roles: ["node"],
          scopes: [],
        },
      });
      const wsBootstrap = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const initial = await connectReq(wsBootstrap, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client,
        deviceIdentityPath: identityPath,
      });
      expect(initial.ok).toBe(true);
      const initialPayload = initial.payload as
        | {
            type?: string;
            auth?: {
              deviceToken?: string;
              role?: string;
              scopes?: string[];
            };
          }
        | undefined;
      expect(initialPayload?.type).toBe("hello-ok");
      const issuedDeviceToken = initialPayload?.auth?.deviceToken;
      expect(issuedDeviceToken).toBeDefined();
      expect(initialPayload?.auth?.role).toBe("node");
      expect(initialPayload?.auth?.scopes ?? []).toEqual([]);

      const afterBootstrap = await listDevicePairing();
      expect(
        afterBootstrap.pending.filter((entry) => entry.deviceId === identity.deviceId),
      ).toEqual([]);
      const paired = await getPairedDevice(identity.deviceId);
      expect(paired?.roles).toEqual(expect.arrayContaining(["node"]));
      expect(paired?.tokens?.node?.token).toBe(issuedDeviceToken);
      if (!issuedDeviceToken) {
        throw new Error("expected hello-ok auth.deviceToken for bootstrap onboarding");
      }

      wsBootstrap.close();

      const wsReplay = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const replay = await connectReq(wsReplay, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client,
        deviceIdentityPath: identityPath,
      });
      expect(replay.ok).toBe(false);
      expect((replay.error?.details as { code?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID,
      );
      wsReplay.close();

      const wsReconnect = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const reconnect = await connectReq(wsReconnect, {
        skipDefaultAuth: true,
        deviceToken: issuedDeviceToken,
        role: "node",
        scopes: [],
        client,
        deviceIdentityPath: identityPath,
      });
      expect(reconnect.ok).toBe(true);
      wsReconnect.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("keeps setup bootstrap tokens valid until operator approval completes", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing } =
      await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    ws.close();

    const { identityPath, identity, client } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-setup-profile-",
    );
    const nodeClient = {
      ...client,
      id: "openclaw-android",
      mode: "node",
    };
    const operatorClient = {
      ...client,
      id: "openclaw-android",
      mode: "ui",
    };
    const operatorScopes = ["operator.read", "operator.write", "operator.talk.secrets"];

    try {
      const issued = await issueDeviceBootstrapToken();

      const wsNode = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const nodeConnect = await connectReq(wsNode, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client: nodeClient,
        deviceIdentityPath: identityPath,
      });
      expect(nodeConnect.ok).toBe(true);
      wsNode.close();

      const pairedAfterNode = await getPairedDevice(identity.deviceId);
      expect(pairedAfterNode?.roles).toEqual(expect.arrayContaining(["node"]));

      const wsOperatorPending = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const operatorPending = await connectReq(wsOperatorPending, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "operator",
        scopes: operatorScopes,
        client: operatorClient,
        deviceIdentityPath: identityPath,
      });
      expect(operatorPending.ok).toBe(false);
      expect((operatorPending.error?.details as { code?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.PAIRING_REQUIRED,
      );
      wsOperatorPending.close();

      const pending = (await listDevicePairing()).pending.filter(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pending).toHaveLength(1);
      const pendingRequest = pending[0];
      if (!pendingRequest) {
        throw new Error("expected pending pairing request");
      }
      await approveDevicePairing(pendingRequest.requestId, {
        callerScopes: pendingRequest.scopes ?? ["operator.admin"],
      });

      const wsNodeReconnect = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const nodeReconnect = await connectReq(wsNodeReconnect, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client: nodeClient,
        deviceIdentityPath: identityPath,
      });
      expect(nodeReconnect.ok).toBe(true);
      wsNodeReconnect.close();

      const wsOperatorApproved = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const operatorApproved = await connectReq(wsOperatorApproved, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "operator",
        scopes: operatorScopes,
        client: operatorClient,
        deviceIdentityPath: identityPath,
      });
      expect(operatorApproved.ok).toBe(true);
      wsOperatorApproved.close();

      const pairedAfterOperator = await getPairedDevice(identity.deviceId);
      expect(pairedAfterOperator?.roles).toEqual(expect.arrayContaining(["node", "operator"]));

      const wsReplay = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const replay = await connectReq(wsReplay, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "operator",
        scopes: operatorScopes,
        client: operatorClient,
        deviceIdentityPath: identityPath,
      });
      expect(replay.ok).toBe(false);
      expect((replay.error?.details as { code?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID,
      );
      wsReplay.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("does not consume bootstrap token when node reconcile fails before hello-ok", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const reconcileModule = await import("./node-connect-reconcile.js");
    const reconcileSpy = vi
      .spyOn(reconcileModule, "reconcileNodePairingOnConnect")
      .mockRejectedValueOnce(new Error("boom"));
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    ws.close();

    const { identityPath, client } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-reconcile-fail-",
    );
    const nodeClient = {
      ...client,
      id: "openclaw-android",
      mode: "node",
    };

    try {
      const issued = await issueDeviceBootstrapToken({
        profile: {
          roles: ["node"],
          scopes: [],
        },
      });

      const wsFail = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      await expect(
        connectReq(wsFail, {
          skipDefaultAuth: true,
          bootstrapToken: issued.token,
          role: "node",
          scopes: [],
          client: nodeClient,
          deviceIdentityPath: identityPath,
          timeoutMs: 500,
        }),
      ).rejects.toThrow();
      await expect(waitForWsClose(wsFail, 1_000)).resolves.toBe(true);

      const wsRetry = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const retry = await connectReq(wsRetry, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client: nodeClient,
        deviceIdentityPath: identityPath,
      });
      expect(retry.ok).toBe(true);
      wsRetry.close();
    } finally {
      reconcileSpy.mockRestore();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("requires approval for bootstrap-auth role upgrades on already-paired devices", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    ws.close();

    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-role-upgrade-",
    );
    const client = {
      id: "openclaw-ios",
      version: "2026.3.30",
      platform: "iOS 26.3.1",
      mode: "node",
      deviceFamily: "iPhone",
    };

    try {
      const seededRequest = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        role: "operator",
        scopes: ["operator.read"],
        clientId: client.id,
        clientMode: client.mode,
        platform: client.platform,
        deviceFamily: client.deviceFamily,
      });
      await approveDevicePairing(seededRequest.request.requestId, {
        callerScopes: ["operator.read"],
      });

      const issued = await issueDeviceBootstrapToken({
        profile: {
          roles: ["node"],
          scopes: [],
        },
      });
      const wsUpgrade = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const upgrade = await connectReq(wsUpgrade, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "node",
        scopes: [],
        client,
        deviceIdentityPath: identityPath,
      });
      expect(upgrade.ok).toBe(false);
      expect(upgrade.error?.message ?? "").toContain("pairing required");
      expect((upgrade.error?.details as { code?: string; reason?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.PAIRING_REQUIRED,
      );
      expect(
        (upgrade.error?.details as { code?: string; reason?: string } | undefined)?.reason,
      ).toBe("role-upgrade");

      const pending = (await listDevicePairing()).pending.filter(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]?.role).toBe("node");
      expect(pending[0]?.roles).toEqual(["node"]);
      const paired = await getPairedDevice(identity.deviceId);
      expect(paired?.roles).toEqual(expect.arrayContaining(["operator"]));
      wsUpgrade.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("requires approval for bootstrap-auth operator pairing outside the qr baseline profile", async () => {
    const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    ws.close();

    const { identityPath, identity, client } = await createOperatorIdentityFixture(
      "openclaw-bootstrap-operator-",
    );

    try {
      const issued = await issueDeviceBootstrapToken({
        profile: {
          roles: ["operator"],
          scopes: ["operator.read"],
        },
      });
      const wsBootstrap = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const initial = await connectReq(wsBootstrap, {
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
        role: "operator",
        scopes: ["operator.read"],
        client,
        deviceIdentityPath: identityPath,
      });
      expect(initial.ok).toBe(false);
      expect(initial.error?.message ?? "").toContain("pairing required");
      expect((initial.error?.details as { code?: string } | undefined)?.code).toBe(
        ConnectErrorDetailCodes.PAIRING_REQUIRED,
      );

      const pending = (await listDevicePairing()).pending.filter(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]?.role).toBe("operator");
      expect(pending[0]?.scopes ?? []).toEqual(expect.arrayContaining(["operator.read"]));
      expect(await getPairedDevice(identity.deviceId)).toBeNull();
      wsBootstrap.close();
    } finally {
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("merges remote node/operator pairing requests for the same unpaired device", async () => {
    const { approveDevicePairing, getPairedDevice, listDevicePairing } =
      await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    ws.close();
    const { identityPath, identity, client } =
      await createOperatorIdentityFixture("openclaw-device-scope-");
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
        device: await buildSignedDeviceForIdentity({
          identityPath,
          client,
          role,
          scopes,
          nonce: String(nonce),
        }),
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
    await approveDevicePairing(pendingForTestDevice[0].requestId, {
      callerScopes: pendingForTestDevice[0].scopes ?? ["operator.admin"],
    });

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
    const { listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken, identityPath, identity, client } =
      await startServerWithOperatorIdentity();

    const initialNonce = await readConnectChallengeNonce(ws);
    const initial = await connectReq(ws, {
      token: "secret",
      scopes: ["operator.admin"],
      client,
      device: await buildSignedDeviceForIdentity({
        identityPath,
        client,
        scopes: ["operator.admin"],
        nonce: initialNonce,
      }),
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
      device: await buildSignedDeviceForIdentity({
        identityPath,
        client,
        scopes: ["operator.read"],
        nonce: nonce2,
      }),
    });
    expect(res.ok).toBe(true);
    ws2.close();

    const list = await listDevicePairing();
    expect(list.pending.filter((entry) => entry.deviceId === identity.deviceId)).toEqual([]);

    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("allows operator shared auth with legacy paired metadata", async () => {
    const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing, requestDevicePairing } =
      await import("../infra/device-pairing.js");
    const { identityPath, identity } = await createOperatorIdentityFixture(
      "openclaw-device-legacy-meta-",
    );
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
    await approveDevicePairing(pending.request.requestId, {
      callerScopes: pending.request.scopes ?? ["operator.admin"],
    });

    await stripPairedMetadataRolesAndScopes(deviceId);

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
        device: await buildSignedDeviceForIdentity({
          identityPath,
          client: TEST_OPERATOR_CLIENT,
          scopes: ["operator.read"],
          nonce: reconnectNonce,
        }),
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
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { identity, identityPath } = await seedApprovedOperatorReadPairing({
      identityPrefix: "openclaw-device-legacy-",
      clientId: TEST_OPERATOR_CLIENT.id,
      clientMode: TEST_OPERATOR_CLIENT.mode,
      displayName: "legacy-upgrade-test",
      platform: "test",
    });

    await stripPairedMetadataRolesAndScopes(identity.deviceId);

    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    let ws2: WebSocket | undefined;
    try {
      const client = { ...TEST_OPERATOR_CLIENT };

      ws.close();

      const wsUpgrade = await openWs(port);
      ws2 = wsUpgrade;
      const upgradeNonce = await readConnectChallengeNonce(wsUpgrade);
      const upgraded = await connectReq(wsUpgrade, {
        token: "secret",
        scopes: ["operator.admin"],
        client,
        device: await buildSignedDeviceForIdentity({
          identityPath,
          client,
          scopes: ["operator.admin"],
          nonce: upgradeNonce,
        }),
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

  test("auto-approves Docker-style CLI connects on loopback with a private host header", async () => {
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    ws.close();
    const wsDockerCli = await openWs(port, { host: "172.17.0.2:18789" });
    try {
      const { identity, identityPath } =
        await createOperatorIdentityFixture("openclaw-cli-docker-");
      const nonce = await readConnectChallengeNonce(wsDockerCli);
      const dockerCli = await connectReq(wsDockerCli, {
        token: "secret",
        client: {
          id: GATEWAY_CLIENT_NAMES.CLI,
          version: "1.0.0",
          platform: "linux",
          mode: GATEWAY_CLIENT_MODES.CLI,
        },
        device: await buildSignedDeviceForIdentity({
          identityPath,
          client: {
            id: GATEWAY_CLIENT_NAMES.CLI,
            mode: GATEWAY_CLIENT_MODES.CLI,
          },
          scopes: ["operator.admin"],
          nonce,
        }),
      });
      expect(dockerCli.ok).toBe(true);
      const pending = await listDevicePairing();
      expect(pending.pending).toHaveLength(0);
      expect(await getPairedDevice(identity.deviceId)).toBeTruthy();
    } finally {
      wsDockerCli.close();
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

  test("requires pairing for gateway backend clients on loopback with a private host header", async () => {
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    ws.close();
    const wsPrivateHost = await openWs(port, { host: "172.17.0.2:18789" });
    try {
      const remoteLikeBackend = await connectReq(wsPrivateHost, {
        token: "secret",
        client: BACKEND_GATEWAY_CLIENT,
      });
      expect(remoteLikeBackend.ok).toBe(false);
      expect(remoteLikeBackend.error?.message ?? "").toContain("pairing required");
    } finally {
      wsPrivateHost.close();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("requires pairing for CLI clients when the host header is not private-or-loopback", async () => {
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    ws.close();
    const wsRemoteLike = await openWs(port, { host: "gateway.example" });
    try {
      const remoteCli = await connectReq(wsRemoteLike, {
        token: "secret",
        client: {
          id: GATEWAY_CLIENT_NAMES.CLI,
          version: "1.0.0",
          platform: "linux",
          mode: GATEWAY_CLIENT_MODES.CLI,
        },
      });
      expect(remoteCli.ok).toBe(false);
      expect(remoteCli.error?.message ?? "").toContain("pairing required");
    } finally {
      wsRemoteLike.close();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });
}
