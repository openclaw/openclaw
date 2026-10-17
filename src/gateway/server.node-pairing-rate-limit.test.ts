// Node pairing rate-limit tests protect repeated pairing attempts, pending
// request cleanup, and protocol error details for node clients.
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { GATEWAY_STARTUP_UNAVAILABLE_REASON } from "../../packages/gateway-protocol/src/startup-unavailable.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import {
  approveNodePairing,
  listNodePairing,
  requestNodePairing,
} from "../infra/device-pairing-node.js";
import { listDevicePairing, requestDevicePairing } from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { useAuthIdentityFixture } from "./server.auth.identity-fixture.test-support.js";
import * as gatewayWsConnection from "./server/ws-connection.js";
import {
  connectReq,
  installGatewayTestHooks,
  testState,
  trackConnectChallengeNonce,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const makeIdentityPath = useAuthIdentityFixture();

const NODE_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.NODE_HOST,
  version: "1.0.0",
  platform: "macos",
  mode: GATEWAY_CLIENT_MODES.NODE,
  deviceFamily: "Mac",
};

async function openWs(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => {
    ws.once("open", resolve);
  });
  return ws;
}

async function attemptNodePairing(
  port: number,
  identityPath: string,
  surface: { caps?: string[]; commands?: string[]; device?: null } = {},
) {
  const ws = await openWs(port);
  try {
    return await connectReq(ws, {
      token: "secret",
      role: "node",
      scopes: [],
      client: NODE_CLIENT,
      commands: surface.commands ?? ["system.run"],
      ...(surface.device === null ? { device: null } : { deviceIdentityPath: identityPath }),
      ...(surface.caps ? { caps: surface.caps } : {}),
    });
  } finally {
    ws.close();
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
    });
  }
}

async function approveNodeIdentity(params: { identityPath: string; caps: string[] }) {
  const identity = loadOrCreateDeviceIdentity({ path: params.identityPath });
  // Node surfaces attach to paired devices, so device pairing comes first.
  // The stored key must match what the reconnect presents or the handshake
  // restarts pairing and burns the rate-limit budget under test.
  const devicePairing = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    role: "node",
    roles: ["node"],
    scopes: [],
  });
  await approveDevicePairing(devicePairing.request.requestId, { callerScopes: [] });
  const request = await requestNodePairing({
    nodeId: identity.deviceId,
    platform: NODE_CLIENT.platform,
    deviceFamily: NODE_CLIENT.deviceFamily,
    caps: params.caps,
  });
  const approved = await approveNodePairing(request.request.requestId, {
    callerScopes: ["operator.pairing"],
  });
  expect(approved && !("status" in approved)).toBe(true);
  return identity;
}

describe("node pairing rate limit", () => {
  test.each([
    ["unpaired", false, false],
    ["device-paired without an approved node surface", true, false],
    ["without a device identity", false, true],
  ] as const)(
    "rejects a %s shared-token node during startup without creating pairing requests",
    async (_pairingState, approveDevice, omitDevice) => {
      testState.gatewayAuth = { mode: "token", token: "secret" };
      const identityPath = makeIdentityPath("openclaw-node-startup-unpaired");
      const attachGatewayWsConnectionHandler = gatewayWsConnection.attachGatewayWsConnectionHandler;
      const startupAdmission = vi
        .spyOn(gatewayWsConnection, "attachGatewayWsConnectionHandler")
        .mockImplementation((params) =>
          attachGatewayWsConnectionHandler({ ...params, isStartupPending: () => true }),
        );

      try {
        await withGatewayServer(async ({ port }) => {
          if (approveDevice) {
            const identity = loadOrCreateDeviceIdentity({ path: identityPath });
            const pairing = await requestDevicePairing({
              deviceId: identity.deviceId,
              publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
              role: "node",
              roles: ["node"],
              scopes: [],
            });
            await approveDevicePairing(pairing.request.requestId, { callerScopes: [] });
          }
          const response = await attemptNodePairing(
            port,
            identityPath,
            omitDevice ? { device: null } : {},
          );

          expect(response).toMatchObject({
            ok: false,
            error: {
              code: "UNAVAILABLE",
              details: { reason: GATEWAY_STARTUP_UNAVAILABLE_REASON },
            },
          });
          expect((await listDevicePairing()).pending).toHaveLength(0);
          expect((await listNodePairing()).pending).toHaveLength(0);
        });
      } finally {
        startupAdmission.mockRestore();
      }
    },
  );

  test("limits concurrent first-time node pairing requests before the pairing lock", async () => {
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: {
        maxAttempts: 3,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: false,
      },
    };
    await withGatewayServer(async ({ port }) => {
      const responses = await Promise.all(
        Array.from(
          { length: 8 },
          async (_, index) =>
            await attemptNodePairing(port, makeIdentityPath(`openclaw-node-pairing-${index}`)),
        ),
      );
      const rateLimited = responses.filter((res) => {
        const details = res.error?.details as { code?: unknown; authReason?: unknown } | undefined;
        return (
          details?.code === ConnectErrorDetailCodes.AUTH_RATE_LIMITED &&
          details.authReason === "rate_limited"
        );
      });
      const connected = responses.filter((res) => res.ok);

      expect(connected).toHaveLength(3);
      expect(rateLimited).toHaveLength(5);
      const pairing = await listNodePairing();
      expect(pairing.pending).toHaveLength(0);
      expect(pairing.paired).toHaveLength(3);
    });
  });

  test("records paired reconnect reapproval despite first-time pairing limits", async () => {
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: {
        maxAttempts: 3,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: false,
      },
    };
    await withGatewayServer(async ({ port }) => {
      const pairedIdentityPath = makeIdentityPath("openclaw-node-pairing-upgrade-paired");
      const pairedIdentity = await approveNodeIdentity({
        identityPath: pairedIdentityPath,
        caps: ["camera"],
      });

      const firstTimeResponses = await Promise.all(
        Array.from(
          { length: 3 },
          async (_, index) =>
            await attemptNodePairing(
              port,
              makeIdentityPath(`openclaw-node-pairing-upgrade-${index}`),
            ),
        ),
      );
      expect(firstTimeResponses.filter((res) => res.ok)).toHaveLength(3);

      const ws = await openWs(port);
      try {
        const reconnect = await connectReq(ws, {
          token: "secret",
          role: "node",
          scopes: [],
          client: NODE_CLIENT,
          caps: ["camera", "screen"],
          deviceIdentityPath: pairedIdentityPath,
        });
        expect(reconnect.ok).toBe(true);
      } finally {
        ws.close();
        await new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          ws.once("close", () => resolve());
        });
      }

      const pending = (await listNodePairing()).pending;
      expect(pending).toHaveLength(1);
      expect(pending.find((entry) => entry.nodeId === pairedIdentity.deviceId)?.caps).toEqual([
        "camera",
        "screen",
      ]);
    });
  });

  test("reuses identical paired reapproval without rejecting the node", async () => {
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: {
        maxAttempts: 1,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: true,
      },
    };
    await withGatewayServer(async ({ port }) => {
      const identityPath = makeIdentityPath("openclaw-node-reapproval");
      const identity = await approveNodeIdentity({ identityPath, caps: ["camera"] });

      const responses = await Promise.all(
        Array.from(
          { length: 20 },
          async () =>
            await attemptNodePairing(port, identityPath, {
              caps: ["camera", "screen"],
              commands: [],
            }),
        ),
      );
      expect(responses.every((res) => res.ok)).toBe(true);
      const pendingBeforeReuse = (await listNodePairing()).pending.find(
        (entry) => entry.nodeId === identity.deviceId,
      );
      expect(pendingBeforeReuse).toBeDefined();

      await expect(
        attemptNodePairing(port, identityPath, {
          caps: ["camera", "screen"],
          commands: [],
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(
        (await listNodePairing()).pending.find((entry) => entry.nodeId === identity.deviceId),
      ).toMatchObject({
        requestId: pendingBeforeReuse!.requestId,
        ts: pendingBeforeReuse!.ts,
      });

      const changedSurface = await attemptNodePairing(port, identityPath, {
        caps: ["camera", "microphone"],
        commands: [],
      });
      expect(changedSurface.ok).toBe(true);
      expect(
        (await listNodePairing()).pending.find((entry) => entry.nodeId === identity.deviceId),
      ).toMatchObject({
        requestId: pendingBeforeReuse!.requestId,
        caps: ["camera", "screen"],
      });
    });
  });
});
