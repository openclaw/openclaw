import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { WebSocket } from "ws";
import {
  buildSignedDeviceForIdentity,
  createOperatorIdentityFixture,
  expectArrayIncludes,
  seedApprovedOperatorReadPairing,
  startControlUiServer,
  startControlUiServerWithOperatorIdentity,
  withControlUiServer,
} from "./server.auth.control-ui.fixtures.test-support.js";
import {
  BACKEND_GATEWAY_CLIENT,
  connectReq,
  createSignedDevice,
  CONTROL_UI_CLIENT,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  openTailscaleWs,
  openWs,
  onceMessage,
  originForPort,
  readConnectChallengeNonce,
  restoreGatewayToken,
  rpcReq,
  TEST_OPERATOR_CLIENT,
  testState,
} from "./server.auth.test-helpers.js";

export function registerControlUiPairingSuite(): void {
  test("delivers rejection to every exact pairing waiter without admitting pending browsers", async () => {
    const { mutateConfigFile } = await import("../config/config.js");
    const { listDevicePairing } = await import("../infra/device-pairing.js");
    const token = randomUUID();
    const origin = "https://control-ui.example.test";
    testState.gatewayControlUi = { allowedOrigins: [origin] };
    await mutateConfigFile({
      mutate(config) {
        config.gateway = { ...config.gateway, trustedProxies: ["127.0.0.1"], controlUi: { allowedOrigins: [origin] } };
      },
      afterWrite: { mode: "auto" },
    });
    await withControlUiServer(async ({ port }) => {
      const sockets: WebSocket[] = [];
      const first = await createOperatorIdentityFixture("declined-browser-");
      const second = await createOperatorIdentityFixture("unrelated-browser-");
      const connectBrowser = async (identityPath: string) => {
        const socket = await openWs(port, { origin, "x-forwarded-for": "203.0.113.50" });
        sockets.push(socket);
        const response = await connectReq(socket, {
          token,
          client: CONTROL_UI_CLIENT,
          caps: ["device-pairing-wait"],
          scopes: ["operator.admin"],
          device: (await createSignedDevice({
            identityPath,
            clientId: CONTROL_UI_CLIENT.id,
            clientMode: CONTROL_UI_CLIENT.mode,
            token,
            scopes: ["operator.admin"],
            nonce: await readConnectChallengeNonce(socket),
          })).device,
        });
        return { socket, response };
      };
      try {
        const admin = await openWs(port);
        sockets.push(admin);
        expect((await connectReq(admin, { token, client: BACKEND_GATEWAY_CLIENT })).ok).toBe(true);
        const requester = await connectBrowser(first.identityPath);
        const sibling = await connectBrowser(first.identityPath);
        const unrelated = await connectBrowser(second.identityPath);
        const pending = (await listDevicePairing()).pending;
        const request = pending.find((entry) => entry.deviceId === first.identity.deviceId)!;
        const other = pending.find((entry) => entry.deviceId === second.identity.deviceId)!;
        for (const waiter of [requester, sibling]) {
          expect(waiter.response.error?.details).toMatchObject({
            requestId: request.requestId,
            deviceId: first.identity.deviceId,
            waitForResolution: true,
          });
        }
        const resolutions = [requester, sibling].map(({ socket }) =>
          onceMessage(socket, (frame) => frame.event === "device.pair.resolved"),
        );
        expect((await rpcReq(admin, "device.pair.reject", { requestId: request.requestId })).ok).toBe(true);
        for (const event of await Promise.all(resolutions)) {
          expect(event.payload).toMatchObject({ requestId: request.requestId, deviceId: first.identity.deviceId, decision: "rejected" });
        }
        expect((await listDevicePairing()).pending.map((entry) => entry.requestId)).toEqual([other.requestId]);
        expect(unrelated.socket.readyState).toBe(1);

        const retried = await connectBrowser(first.identityPath);
        const retryRequest = (await listDevicePairing()).pending.find((entry) => entry.deviceId === first.identity.deviceId)!;
        expect(retryRequest.requestId).not.toBe(request.requestId);
        const approval = onceMessage(retried.socket, (frame) => frame.event === "device.pair.resolved");
        expect((await rpcReq(admin, "device.pair.approve", { requestId: retryRequest.requestId })).ok).toBe(true);
        expect((await approval).payload).toMatchObject({ requestId: retryRequest.requestId, decision: "approved" });
        expect((await connectBrowser(first.identityPath)).response.ok).toBe(true);

        const closed = new Promise<number>((resolve) => unrelated.socket.once("close", resolve));
        unrelated.socket.send(JSON.stringify({ type: "req", id: "pending-rpc", method: "device.pair.list", params: {} }));
        expect(await closed).toBe(1008);
      } finally {
        for (const socket of sockets) {
          socket.close();
        }
      }
    }, token);
  });

  test("keeps pending Control UI operator and node pairing reconnecting", async () => {
    const { mutateConfigFile } = await import("../config/config.js");
    const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
    const { approveDevicePairing } = await import("../infra/device-pairing-approval.js");
    const { listDevicePairing, requestDevicePairing } = await import("../infra/device-pairing.js");
    const origin = "https://control-ui.example.test";
    testState.gatewayControlUi = { allowedOrigins: [origin] };
    await mutateConfigFile({
      mutate(config) {
        config.gateway = {
          ...config.gateway,
          trustedProxies: ["127.0.0.1"],
          controlUi: { ...config.gateway?.controlUi, allowedOrigins: [origin] },
        };
      },
      afterWrite: { mode: "auto" },
    });
    await withControlUiServer(async ({ port }) => {
      const connectBrowser = async (
        identityPath: string,
        role: "operator" | "node",
        scopes: string[],
      ) => {
        const socket = await openWs(port, {
          origin,
          "x-forwarded-for": "203.0.113.50",
        });
        try {
          return await connectReq(socket, {
            token: "secret",
            role,
            scopes,
            client: CONTROL_UI_CLIENT,
            device: await buildSignedDeviceForIdentity({
              identityPath,
              client: CONTROL_UI_CLIENT,
              role,
              scopes,
              nonce: await readConnectChallengeNonce(socket),
            }),
          });
        } finally {
          socket.close();
        }
      };

      for (const reason of [
        "not-paired",
        "role-upgrade",
        "scope-upgrade",
        "metadata-upgrade",
      ] as const) {
        const { identityPath, identity } = await createOperatorIdentityFixture(
          `openclaw-control-ui-retry-${reason}-`,
        );
        if (reason !== "not-paired") {
          const seeded = await requestDevicePairing({
            deviceId: identity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
            role: reason === "role-upgrade" ? "node" : "operator",
            scopes:
              reason === "role-upgrade"
                ? []
                : reason === "scope-upgrade"
                  ? ["operator.read"]
                  : ["operator.admin"],
            clientId: CONTROL_UI_CLIENT.id,
            clientMode: CONTROL_UI_CLIENT.mode,
            platform:
              reason === "metadata-upgrade" ? "previous-platform" : CONTROL_UI_CLIENT.platform,
          });
          expect(
            (
              await approveDevicePairing(seeded.request.requestId, {
                callerScopes: ["operator.admin"],
              })
            )?.status,
          ).toBe("approved");
        }

        let requestId: string | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await connectBrowser(identityPath, "operator", ["operator.admin"]);
          expect(response.ok).toBe(false);
          const pending = (await listDevicePairing()).pending.filter(
            (entry) => entry.deviceId === identity.deviceId,
          );
          expect(pending).toHaveLength(1);
          requestId ??= pending[0]?.requestId;
          expect(pending[0]?.requestId).toBe(requestId);
          expect(response.error?.details).toMatchObject({
            code: "PAIRING_REQUIRED",
            reason,
            requestId,
            recommendedNextStep: "wait_then_retry",
            retryable: true,
            pauseReconnect: false,
          });
        }
      }
      const { identityPath } = await createOperatorIdentityFixture(
        "openclaw-control-ui-node-retry-",
      );
      const response = await connectBrowser(identityPath, "node", []);
      expect(response.ok).toBe(false);
      expect(response.error?.details).toMatchObject({
        code: "PAIRING_REQUIRED",
        reason: "not-paired",
        requestId: expect.any(String),
        recommendedNextStep: "wait_then_retry",
        retryable: true,
        pauseReconnect: false,
      });
    });
  });

  const tamperPairedMetadata = async (
    deviceId: string,
    mutate: (metadata: Record<string, unknown>) => void,
  ) => {
    const { withPairedDeviceRecords } = await import("../infra/device-pairing.js");
    await withPairedDeviceRecords(undefined, (pairedByDeviceId) => {
      const metadata = pairedByDeviceId[deviceId] as Record<string, unknown> | undefined;
      if (!metadata) {
        throw new Error(`Expected paired metadata for deviceId=${deviceId}`);
      }
      mutate(metadata);
      return { value: undefined, persist: true };
    });
  };

  const stripPairedMetadataRolesAndScopes = async (deviceId: string) => {
    await tamperPairedMetadata(deviceId, (metadata) => {
      delete metadata.roles;
      delete metadata.scopes;
    });
  };

  const overwritePairedPublicKey = async (deviceId: string, publicKey: string) => {
    await tamperPairedMetadata(deviceId, (metadata) => {
      metadata.publicKey = publicKey;
    });
  };

  const injectMalformedPairedAccessLists = async (deviceId: string) => {
    await tamperPairedMetadata(deviceId, (metadata) => {
      metadata.roles = ["operator", null, 42, ""];
      metadata.scopes = ["operator.read", null, 42, ""];
      metadata.approvedScopes = ["operator.read", null, 42, ""];
    });
  };
  test("auto-approves local-direct operator pairing and scope upgrades despite a remote-looking host header", async () => {
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, port, prevToken, identityPath, identity, client } =
      await startControlUiServerWithOperatorIdentity();

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
    expect(initial.ok).toBe(true);
    let pairing = await listDevicePairing();
    const pendingAfterRead = pairing.pending.filter(
      (entry) => entry.deviceId === identity.deviceId,
    );
    expect(pendingAfterRead).toHaveLength(0);
    const pairedAfterRead = await getPairedDevice(identity.deviceId);
    if (!pairedAfterRead) {
      throw new Error(`expected paired device ${identity.deviceId}`);
    }
    expect(pairedAfterRead.lastSeenReason).toBe("connect");
    expect(typeof pairedAfterRead.lastSeenAtMs).toBe("number");
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
    // A local shared-auth connect could pair a fresh identity at admin, so the
    // widening self-approves silently instead of queueing an unanswerable prompt.
    expect(res.ok).toBe(true);
    pairing = await listDevicePairing();
    const pendingAfterAdmin = pairing.pending.filter(
      (entry) => entry.deviceId === identity.deviceId,
    );
    expect(pendingAfterAdmin).toHaveLength(0);
    const widened = await getPairedDevice(identity.deviceId);
    expectArrayIncludes(widened?.approvedScopes, ["operator.admin", "operator.read"]);
    ws2.close();
    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("silently widens loopback control ui scope upgrades under shared auth", async () => {
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, port, prevToken } = await startControlUiServer("secret");
    const { identity, identityPath } = await seedApprovedOperatorReadPairing({
      identityPrefix: "openclaw-device-token-scope-",
      clientId: CONTROL_UI_CLIENT.id,
      clientMode: CONTROL_UI_CLIENT.mode,
      displayName: "loopback-control-ui-upgrade",
      platform: CONTROL_UI_CLIENT.platform,
    });

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
    // A fresh Control UI browser identity holding the shared secret could pair
    // at admin silently, so an existing row widens the same way.
    expect(upgraded.ok).toBe(true);
    const pending = await listDevicePairing();
    const pendingUpgrade = pending.pending.filter((entry) => entry.deviceId === identity.deviceId);
    expect(pendingUpgrade).toHaveLength(0);
    const updated = await getPairedDevice(identity.deviceId);
    expect(updated?.tokens?.operator?.scopes ?? []).toContain("operator.admin");

    ws2.close();
    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("silently repairs malformed persisted access lists on local re-approval", async () => {
    const { getPairedDevice } = await import("../infra/device-pairing.js");
    const { identity, identityPath } = await seedApprovedOperatorReadPairing({
      identityPrefix: "openclaw-device-malformed-access-",
      clientId: TEST_OPERATOR_CLIENT.id,
      clientMode: TEST_OPERATOR_CLIENT.mode,
      displayName: "malformed-access-upgrade",
      platform: TEST_OPERATOR_CLIENT.platform,
    });
    await injectMalformedPairedAccessLists(identity.deviceId);

    const { server, port, prevToken } = await startControlUiServer("secret");
    let ws: WebSocket | undefined;
    try {
      ws = await openWs(port);
      const nonce = await readConnectChallengeNonce(ws);
      const result = await connectReq(ws, {
        token: "secret",
        scopes: ["operator.admin"],
        client: { ...TEST_OPERATOR_CLIENT },
        device: await buildSignedDeviceForIdentity({
          identityPath,
          client: TEST_OPERATOR_CLIENT,
          scopes: ["operator.admin"],
          nonce,
        }),
      });

      // Malformed persisted access lists never grant access by themselves: the
      // connect is re-authorized by a fresh silent local approval, which also
      // rewrites the row with a clean scope list.
      expect(result.ok).toBe(true);
      const repaired = await getPairedDevice(identity.deviceId);
      expect(repaired?.approvedScopes ?? []).toContain("operator.admin");
    } finally {
      ws?.close();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("does not expose approved access when a paired device id reconnects with a different key", async () => {
    const { identity, identityPath } = await seedApprovedOperatorReadPairing({
      identityPrefix: "openclaw-device-key-mismatch-",
      clientId: TEST_OPERATOR_CLIENT.id,
      clientMode: TEST_OPERATOR_CLIENT.mode,
      displayName: "remote-key-mismatch",
      platform: TEST_OPERATOR_CLIENT.platform,
    });
    await overwritePairedPublicKey(identity.deviceId, "mismatched-public-key");

    const { server, prevToken } = await startControlUiServer("secret", {
      tailscale: { mode: "serve" },
    });
    const tailscaleEndpoint = server.getTailscaleIngressEndpoint();
    if (!tailscaleEndpoint) {
      throw new Error("expected managed Tailscale listener");
    }
    const ws2 = await openTailscaleWs(tailscaleEndpoint);
    try {
      const nonce2 = await readConnectChallengeNonce(ws2);
      const mismatched = await connectReq(ws2, {
        token: "secret",
        scopes: ["operator.admin"],
        client: { ...TEST_OPERATOR_CLIENT },
        device: await buildSignedDeviceForIdentity({
          identityPath,
          client: TEST_OPERATOR_CLIENT,
          scopes: ["operator.admin"],
          nonce: nonce2,
        }),
      });
      expect(mismatched.ok).toBe(false);
      expect(mismatched.error?.message ?? "").toContain("pairing required");
      const details = mismatched.error?.details as
        | {
            reason?: string;
            requestedRole?: string;
            requestedScopes?: string[];
            approvedRoles?: string[];
            approvedScopes?: string[];
          }
        | undefined;
      expect(details?.reason).toBe("not-paired");
      expect(details?.requestedRole).toBe("operator");
      expect(details?.requestedScopes).toEqual(["operator.admin"]);
      expect(details?.approvedRoles).toBeUndefined();
      expect(details?.approvedScopes).toBeUndefined();
    } finally {
      ws2.close();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test("auto-approves local-direct node pairing, then silently grants operator scopes", async () => {
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { identityPath, identity, client } =
      await createOperatorIdentityFixture("openclaw-device-scope-");
    await withControlUiServer(async ({ port }) => {
      const connectWithNonce = async (role: "operator" | "node", scopes: string[]) => {
        const socket = await openWs(port, { host: "gateway.example" });
        try {
          const nonce = await readConnectChallengeNonce(socket);
          return await connectReq(socket, {
            token: "secret",
            role,
            scopes,
            client,
            device: await buildSignedDeviceForIdentity({
              identityPath,
              client,
              role,
              scopes,
              nonce,
            }),
          });
        } finally {
          socket.close();
        }
      };

      const nodeConnect = await connectWithNonce("node", []);
      expect(nodeConnect.ok).toBe(true);

      const operatorConnect = await connectWithNonce("operator", [
        "operator.read",
        "operator.write",
      ]);
      expect(operatorConnect.ok).toBe(true);

      const pending = await listDevicePairing();
      const pendingForTestDevice = pending.pending.filter(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pendingForTestDevice).toHaveLength(0);

      const paired = await getPairedDevice(identity.deviceId);
      expectArrayIncludes(paired?.roles, ["node", "operator"]);
      expectArrayIncludes(paired?.approvedScopes, ["operator.read", "operator.write"]);

      const approvedOperatorConnect = await connectWithNonce("operator", ["operator.read"]);
      expect(approvedOperatorConnect.ok).toBe(true);
    });
  });

  test("silently widens local scope upgrades even when paired metadata is legacy-shaped", async () => {
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { identity, identityPath } = await seedApprovedOperatorReadPairing({
      identityPrefix: "openclaw-device-legacy-",
      clientId: TEST_OPERATOR_CLIENT.id,
      clientMode: TEST_OPERATOR_CLIENT.mode,
      displayName: "legacy-upgrade-test",
      platform: "test",
    });

    await stripPairedMetadataRolesAndScopes(identity.deviceId);

    const { server, port, prevToken } = await startControlUiServer("secret");
    let ws2: WebSocket | undefined;
    try {
      const client = { ...TEST_OPERATOR_CLIENT };

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
      // Legacy-shaped rows must not break the upgrade flow: the silent local
      // approval rewrites the row with the widened, normalized scope list.
      expect(upgraded.ok).toBe(true);
      wsUpgrade.close();

      const pendingUpgrade = (await listDevicePairing()).pending.find(
        (entry) => entry.deviceId === identity.deviceId,
      );
      expect(pendingUpgrade).toBeUndefined();
      const repaired = await getPairedDevice(identity.deviceId);
      expect(repaired?.role).toBe("operator");
      expectArrayIncludes(repaired?.approvedScopes, ["operator.admin", "operator.read"]);
    } finally {
      ws2?.close();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });

  test.each([
    {
      name: "allows gateway backend loopback shared-auth connections without device pairing",
      client: BACKEND_GATEWAY_CLIENT,
      hosts: [undefined, "gateway.example", "172.17.0.2:18789"],
    },
  ])("$name", async ({ client, hosts }) => {
    await withControlUiServer(async ({ port }) => {
      for (const host of hosts) {
        const socket = await openWs(port, host ? { host } : undefined);
        try {
          const result = await connectReq(socket, { token: "secret", client });
          expect(result.ok, host ?? "default host").toBe(true);
        } finally {
          socket.close();
        }
      }
    });
  });

  test("auto-approves Docker-style CLI connects on loopback with a private host header", async () => {
    const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
    const { server, port, prevToken } = await startControlUiServer("secret");
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
      expect(pending.pending.filter((entry) => entry.deviceId === identity.deviceId)).toEqual([]);
      if (!(await getPairedDevice(identity.deviceId))) {
        throw new Error(`expected paired device ${identity.deviceId}`);
      }
    } finally {
      wsDockerCli.close();
      await server.close();
      restoreGatewayToken(prevToken);
    }
  });
}
