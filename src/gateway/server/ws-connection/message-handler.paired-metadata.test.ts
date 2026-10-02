// Paired reconnect observations retain their admitting grant and connection lifetime.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import * as devicePairing from "../../../infra/device-pairing.js";
import type { GatewayWsClient } from "../ws-types.js";
import {
  attachGatewayHarness,
  BACKEND_CONNECT_PARAMS,
  createGatewayHarnessGate,
  createPairedGatewayConnectDevice,
  connectTrustedProxyUser,
  withGatewayTestState,
} from "./message-handler.post-connect-health.test-support.js";

const { loadConfigMock, resolveConnectAuthStateMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(() => ({
    gateway: {
      auth: { mode: "none" },
      controlUi: { allowedOrigins: ["http://127.0.0.1:19001"] },
    },
  })),
  resolveConnectAuthStateMock: vi.fn(),
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: loadConfigMock,
  loadConfig: loadConfigMock,
}));
vi.mock("../../../config/io.js", () => ({ getRuntimeConfig: loadConfigMock }));
vi.mock("./auth-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth-context.js")>();
  resolveConnectAuthStateMock.mockImplementation(actual.resolveConnectAuthState);
  return { ...actual, resolveConnectAuthState: resolveConnectAuthStateMock };
});
vi.mock("../../../infra/host-account-name.js", () => ({
  resolveHostAccountName: vi.fn(async () => "Gateway Person"),
}));
vi.mock("../../server-methods.js", () => ({ handleGatewayRequest: vi.fn() }));
vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: vi.fn(() => ({
    presence: [],
    health: {},
    stateVersion: { presence: 1, health: 1 },
    uptimeMs: 1,
    sessionDefaults: {
      defaultAgentId: "main",
      mainKey: "main",
      mainSessionKey: "main",
      scope: "per-sender",
    },
  })),
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
}));

beforeEach(() => {
  vi.clearAllMocks();
  loadConfigMock.mockReturnValue({
    gateway: {
      auth: { mode: "none" },
      controlUi: { allowedOrigins: ["http://127.0.0.1:19001"] },
    },
  });
});

describe("paired reconnect metadata", () => {
  it.each(["first pairing", "role upgrade", "scope reapproval"] as const)(
    "retains the original observation after external approval during %s",
    async (kind) => {
      await withGatewayTestState({ label: "gateway-approved-metadata" }, async () => {
        const connId = `approved-metadata-${kind}`;
        const client = { id: "openclaw-control-ui", mode: "ui" } as const;
        const scopes = kind === "scope reapproval" ? ["operator.read"] : [];
        const { device, pairing } = createPairedGatewayConnectDevice(connId, client, scopes);
        const previousRole = kind === "role upgrade" ? "node" : "operator";
        const previous: devicePairing.PairedDevice = {
          ...pairing,
          role: previousRole,
          scopes: [],
          displayName: "Previous desktop",
          remoteIp: "198.51.100.10",
          lastSeenAtMs: 1,
          lastSeenReason: "previous connection",
          tokens: {
            [previousRole]: {
              token: "synthetic-previous-token",
              role: previousRole,
              scopes: [],
              createdAtMs: 1,
            },
          },
        };
        // Another legitimate approval does not have this connection's access observation.
        const approved: devicePairing.PairedDevice = {
          ...(kind === "first pairing" ? pairing : previous),
          role: "operator",
          roles: previousRole === "node" ? ["node", "operator"] : ["operator"],
          scopes,
          approvedAtMs: 2,
          approvedVia: "owner",
          tokens: {
            ...(kind === "first pairing" ? {} : previous.tokens),
            operator: { ...pairing.tokens!.operator!, token: "synthetic-approved-token", scopes },
          },
        };
        let currentPairing = kind === "first pairing" ? null : previous;
        const observedAt = Date.now();
        const now = vi.spyOn(Date, "now").mockReturnValue(observedAt);
        const requested = createGatewayHarnessGate();
        const approval = createGatewayHarnessGate();
        const paired = vi
          .spyOn(devicePairing, "getPairedDevice")
          .mockImplementation(async () => currentPairing);
        const request = vi
          .spyOn(devicePairing, "requestDevicePairing")
          .mockImplementation(async (req) => {
            requested.resolve();
            await approval.promise;
            return {
              status: "pending",
              request: { ...req, requestId: "approved-request", ts: observedAt },
              expiresAtMs: observedAt + 60_000,
              created: true,
            };
          });
        const list = vi
          .spyOn(devicePairing, "listDevicePairing")
          .mockResolvedValue({ pending: [], paired: [approved] });
        let refreshed = false;
        const update = vi
          .spyOn(devicePairing, "updatePairedDeviceMetadata")
          .mockImplementation(async (_id, _patch, _baseDir, options) => {
            options?.assertCurrent();
            refreshed = true;
            return true;
          });
        const harness = connectTrustedProxyUser(
          loadConfigMock,
          connId,
          { displayName: "Current desktop" },
          scopes,
          undefined,
          device,
        );
        try {
          await awaitGateBeforeSettlement(
            requested.promise,
            harness.whenAttached,
            "Connection completed without requesting pairing approval",
          );
          currentPairing = approved;
          now.mockReturnValue(observedAt + 1_000);
          approval.resolve();
          await harness.runWhenIdle();
          expect(harness.socketSend).toHaveBeenCalledOnce();
          expect(JSON.parse(harness.socketSend.mock.calls[0]![0])).toMatchObject({
            ok: true,
            payload: { type: "hello-ok", auth: { role: "operator", scopes } },
          });
          expect(request).toHaveBeenCalledOnce();
          expect(update).toHaveBeenCalledExactlyOnceWith(
            device.id,
            {
              displayName: "Current desktop",
              remoteIp: "203.0.113.10",
              lastSeenAtMs: observedAt,
              lastSeenReason: "connect",
            },
            undefined,
            expect.objectContaining({
              expectedPairing: {
                publicKey: approved.publicKey,
                createdAtMs: approved.createdAtMs,
                approvedAtMs: approved.approvedAtMs,
                grant: { role: "operator", token: approved.tokens!.operator!.token },
              },
              assertCurrent: expect.any(Function),
            }),
          );
          expect(refreshed).toBe(true);
        } finally {
          approval.resolve();
          try {
            await harness.runWhenIdle();
          } finally {
            update.mockRestore();
            list.mockRestore();
            request.mockRestore();
            paired.mockRestore();
            now.mockRestore();
          }
        }
      });
    },
  );

  it.each([
    ...(["trusted-proxy", "device-token", "token", "none"] as const).flatMap((authMethod) =>
      [false, true].map((closed) => ({ authMethod, closed, missingToken: false })),
    ),
    { authMethod: "device-token" as const, closed: false, missingToken: true },
  ])(
    "sends hello before paired metadata settles ($authMethod, closed=$closed, missingToken=$missingToken)",
    async ({ authMethod, closed, missingToken }) => {
      await withGatewayTestState({ label: "gateway-paired-metadata" }, async () => {
        const connId = "paired-metadata";
        const trustedProxy = authMethod === "trusted-proxy";
        const client = trustedProxy
          ? ({ id: "openclaw-control-ui", mode: "ui" } as const)
          : BACKEND_CONNECT_PARAMS.client;
        const { device, pairing } = createPairedGatewayConnectDevice(connId, client);
        if (missingToken) {
          delete pairing.tokens?.operator;
        }
        const metadataStarted = createGatewayHarnessGate();
        const metadata = createGatewayHarnessGate<boolean>();
        const paired = vi.spyOn(devicePairing, "getPairedDevice").mockResolvedValue(pairing);
        let refreshed = false;
        const update = vi
          .spyOn(devicePairing, "updatePairedDeviceMetadata")
          .mockImplementation(async (_id, _patch, _baseDir, options) => {
            metadataStarted.resolve();
            await metadata.promise;
            options?.assertCurrent();
            refreshed = true;
            return true;
          });
        if (!trustedProxy) {
          resolveConnectAuthStateMock.mockResolvedValueOnce({
            authResult: { ok: true, method: authMethod },
            authOk: true,
            authMethod,
            sharedAuthOk: authMethod === "token",
          });
        }
        const harness = trustedProxy
          ? connectTrustedProxyUser(loadConfigMock, connId, {}, [], undefined, device)
          : attachGatewayHarness({ connId, connectNonce: `nonce-${connId}` });
        if (!trustedProxy) {
          harness.sendConnect(`connect-${connId}`, { ...BACKEND_CONNECT_PARAMS, device });
        }
        try {
          if (missingToken) {
            metadata.resolve(true);
            await harness.runWhenIdle();
          } else {
            await metadataStarted.promise;
          }
          expect(harness.socketSend).toHaveBeenCalledOnce();
          expect(JSON.parse(harness.socketSend.mock.calls[0]![0])).toMatchObject({
            ok: true,
            payload: { type: "hello-ok", auth: { role: "operator" } },
          });
          expect(harness.clearHandshakeTimer).toHaveBeenCalledOnce();
          if (missingToken) {
            expect(update).not.toHaveBeenCalled();
          } else {
            expect(update.mock.calls[0]?.[3]?.expectedPairing.grant).toEqual(
              trustedProxy || authMethod === "device-token"
                ? { role: "operator", token: pairing.tokens!.operator!.token }
                : undefined,
            );
          }
          if (closed) {
            (harness.client as GatewayWsClient).invalidated = true;
          }
        } finally {
          metadata.resolve(true);
          await harness.runWhenIdle();
          update.mockRestore();
          paired.mockRestore();
        }
        expect(refreshed).toBe(!closed && !missingToken);
      });
    },
  );
});
