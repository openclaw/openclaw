import { expectDefined } from "@openclaw/normalization-core";
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
import { openTrackedWs } from "./device-authz.test-helpers.js";
import { useAuthIdentityFixture } from "./server.auth.identity-fixture.test-support.js";
import * as gatewayWsConnection from "./server/ws-connection.js";
import {
  connectReq,
  installGatewayTestHooks,
  testState,
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

function setPairingLimit(maxAttempts = 3, exemptLoopback = false) {
  testState.gatewayAuth = {
    mode: "token",
    token: "secret",
    rateLimit: { maxAttempts, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback },
  };
}

function requestDevice(identity: ReturnType<typeof loadOrCreateDeviceIdentity>) {
  return requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    role: "node",
    roles: ["node"],
    scopes: [],
  });
}

async function attemptNodePairing(
  port: number,
  identityPath: string,
  surface: { caps?: string[]; commands?: string[]; device?: null } = { commands: ["system.run"] },
) {
  const ws = await openTrackedWs(port);
  try {
    return await connectReq(ws, {
      token: "secret",
      role: "node",
      scopes: [],
      client: NODE_CLIENT,
      deviceIdentityPath: identityPath,
      ...surface,
    });
  } finally {
    ws.close();
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
      } else {
        ws.once("close", () => resolve());
      }
    });
  }
}

async function approveNodeIdentity(params: { identityPath: string; caps: string[] }) {
  const identity = loadOrCreateDeviceIdentity({ path: params.identityPath });
  // Pair the reconnect's exact key before approving its node surface.
  const devicePairing = await requestDevice(identity);
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

function pairFirstTimeNodes(port: number, count: number) {
  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      attemptNodePairing(port, makeIdentityPath(`openclaw-node-pairing-${index}`)),
    ),
  );
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
      const attachGatewayWsConnectionHandler = gatewayWsConnection.attachGatewayWsConnectionHandler;
      const startupAdmission = vi
        .spyOn(gatewayWsConnection, "attachGatewayWsConnectionHandler")
        .mockImplementation((params) =>
          attachGatewayWsConnectionHandler({ ...params, isStartupPending: () => true }),
        );

      using startup = {
        identityPath: makeIdentityPath("openclaw-node-startup-unpaired"),
        [Symbol.dispose]() {
          startupAdmission.mockRestore();
        },
      };
      await withGatewayServer(async ({ port }) => {
        const { identityPath } = startup;
        if (approveDevice) {
          const pairing = await requestDevice(loadOrCreateDeviceIdentity({ path: identityPath }));
          await approveDevicePairing(pairing.request.requestId, { callerScopes: [] });
        }
        const response = await attemptNodePairing(
          port,
          identityPath,
          omitDevice ? { device: null, commands: ["system.run"] } : undefined,
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
    },
  );

  test("limits concurrent first-time node pairing requests before the pairing lock", async () => {
    setPairingLimit();
    await withGatewayServer(async ({ port }) => {
      const responses = await pairFirstTimeNodes(port, 8);
      const rateLimited = responses.filter((res) => {
        const details = res.error?.details as { code?: unknown; authReason?: unknown } | undefined;
        return (
          details?.code === ConnectErrorDetailCodes.AUTH_RATE_LIMITED &&
          details.authReason === "rate_limited"
        );
      });
      expect(responses.filter((res) => res.ok)).toHaveLength(3);
      expect(rateLimited).toHaveLength(5);
      const pairing = await listNodePairing();
      expect(pairing.pending).toHaveLength(0);
      expect(pairing.paired).toHaveLength(3);
    });
  });

  test("records paired reconnect reapproval despite first-time pairing limits", async () => {
    setPairingLimit();
    await withGatewayServer(async ({ port }) => {
      const identityPath = makeIdentityPath("openclaw-node-pairing-upgrade-paired");
      const paired = await approveNodeIdentity({ identityPath, caps: ["camera"] });

      const firstTimeResponses = await pairFirstTimeNodes(port, 3);
      expect(firstTimeResponses.filter((res) => res.ok)).toHaveLength(3);

      expect(
        await attemptNodePairing(port, identityPath, { caps: ["camera", "screen"] }),
      ).toMatchObject({ ok: true });

      const pending = (await listNodePairing()).pending;
      expect(pending).toMatchObject([{ nodeId: paired.deviceId, caps: ["camera", "screen"] }]);
    });
  });

  test("reuses identical paired reapproval without rejecting the node", async () => {
    setPairingLimit(1, true);
    await withGatewayServer(async ({ port }) => {
      const identityPath = makeIdentityPath("openclaw-node-reapproval");
      const identity = await approveNodeIdentity({ identityPath, caps: ["camera"] });
      const pending = async () =>
        (await listNodePairing()).pending.find((entry) => entry.nodeId === identity.deviceId);
      const reapprove = (caps = ["camera", "screen"]) =>
        attemptNodePairing(port, identityPath, { caps, commands: [] });

      const responses = await Promise.all(Array.from({ length: 20 }, () => reapprove()));
      expect(responses.every((res) => res.ok)).toBe(true);
      const { requestId, ts } = expectDefined(await pending(), "pending reapproval");

      await expect(reapprove()).resolves.toMatchObject({ ok: true });
      expect(await pending()).toMatchObject({ requestId, ts });

      const changedSurface = await reapprove(["camera", "microphone"]);
      expect(changedSurface.ok).toBe(true);
      expect(await pending()).toMatchObject({ requestId, caps: ["camera", "screen"] });
    });
  });
});
