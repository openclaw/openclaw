import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import * as devicePairingApprovalModule from "../infra/device-pairing-approval.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import * as devicePairingModule from "../infra/device-pairing.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { callGateway } from "./call.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
} from "./device-authz.test-helpers.js";
import { withOperatorApprovalsGatewayClient } from "./operator-approvals-client.js";
import {
  connectOk,
  connectReq,
  installGatewayTestHooks,
  onceMessage,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

await import("./server.js");

type ScopeUpgradeAttempt = {
  ok?: unknown;
  error?: { message?: unknown; details?: unknown };
};

async function approveReadScopedDevice(
  clientId: (typeof GATEWAY_CLIENT_NAMES)[keyof typeof GATEWAY_CLIENT_NAMES] = GATEWAY_CLIENT_NAMES.CLI,
  clientMode: (typeof GATEWAY_CLIENT_MODES)[keyof typeof GATEWAY_CLIENT_MODES] = GATEWAY_CLIENT_MODES.CLI,
) {
  const identity = loadOrCreateDeviceIdentity();
  const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  const request = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey,
    role: "operator",
    scopes: ["operator.read"],
    clientId,
    clientMode,
  });
  await approveDevicePairing(request.request.requestId, {
    callerScopes: ["operator.read"],
  });
  return identity;
}

function responseRequestId(response: ScopeUpgradeAttempt) {
  return (response.error?.details as { requestId?: unknown; code?: string } | undefined)?.requestId;
}

async function expectReadScopedPairing(deviceId: string) {
  const paired = await getPairedDevice(deviceId);
  expect(paired?.approvedScopes).toEqual(["operator.read"]);
  return paired;
}

describe("gateway silent scope-upgrade reconnect", () => {
  let started: Awaited<ReturnType<typeof startServerWithClient>>;
  const sockets = new Set<Awaited<ReturnType<typeof openTrackedWs>>>();
  async function openWs() {
    const ws = await openTrackedWs(started.port);
    sockets.add(ws);
    return ws;
  }
  async function connectIdentity(loaded: ReturnType<typeof loadDeviceIdentity>) {
    return connectReq(await openWs(), { token: "secret", deviceIdentityPath: loaded.identityPath });
  }
  beforeEach(async () => {
    started = await startServerWithClient("secret");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const ws of sockets) {
      ws.close();
    }
    sockets.clear();
    started.ws.close();
    await started.server.close();
    started.envSnapshot.restore();
  });
  function callLocal(method: string, options: Partial<Parameters<typeof callGateway>[0]> = {}) {
    return callGateway({
      url: `ws://127.0.0.1:${started.port}`,
      token: "secret",
      method,
      timeoutMs: 2_000,
      ...options,
    });
  }
  test("keeps scope upgrades on manual approval when autoApproveLocal is disabled", async () => {
    const { replaceConfigFile } = await import("../config/config.js");
    const paired = await issueOperatorToken({
      name: "silent-scope-upgrade-reconnect-poc",
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
      approvedScopes: ["operator.read"],
    });
    const watcherWs = await openWs();
    await connectOk(watcherWs, { scopes: ["operator.admin"] });
    const requestedEvent = onceMessage(
      watcherWs,
      (obj) => obj.type === "event" && obj.event === "device.pair.requested",
    );
    // Flip after the watcher connects so only the upgrade is gated.
    await replaceConfigFile({
      nextConfig: { gateway: { nodes: { pairing: { autoApproveLocal: false } } } },
      afterWrite: { mode: "auto" },
    });
    const sharedAuthUpgradeAttempt = await connectReq(await openWs(), {
      token: "secret",
      deviceIdentityPath: paired.identityPath,
      scopes: ["operator.admin"],
    });
    expect(sharedAuthUpgradeAttempt.ok).toBe(false);
    expect(sharedAuthUpgradeAttempt.error?.message).toBe(
      "pairing required: device is asking for more scopes than currently approved",
    );

    const pending = await devicePairingModule.listDevicePairing();
    expect(pending.pending).toHaveLength(1);
    expect(sharedAuthUpgradeAttempt.error?.details).toMatchObject({
      requestId: pending.pending[0]?.requestId,
      reason: "scope-upgrade",
      requestedRole: "operator",
      requestedScopes: ["operator.admin"],
      approvedScopes: ["operator.read"],
      remediationHint: "Review the requested scopes, then approve the pending upgrade.",
    });
    expect(await requestedEvent).toMatchObject({
      payload: {
        requestId: pending.pending[0]?.requestId,
        deviceId: paired.deviceId,
        scopes: ["operator.admin"],
      },
    });
    expect(await getPairedDevice(paired.deviceId)).toMatchObject({
      approvedScopes: ["operator.read"],
      tokens: { operator: { scopes: ["operator.read"], token: paired.token } },
    });

    const afterUpgrade = await connectReq(await openWs(), {
      skipDefaultAuth: true,
      deviceToken: paired.token,
      deviceIdentityPath: paired.identityPath,
      scopes: ["operator.admin"],
    });
    expect(afterUpgrade.ok).toBe(false);
  });

  test("keeps direct-local backend callGateway scoped calls off stale paired CLI baseline", async () => {
    const identity = await approveReadScopedDevice();

    const health = await callLocal("health", { scopes: ["operator.admin"] });
    expect(health.ok).toBe(true);
    await expectReadScopedPairing(identity.deviceId);
  });

  test("keeps direct-local CLI shared-token calls off stale paired CLI baseline", async () => {
    const identity = await approveReadScopedDevice();

    const cli = { clientName: GATEWAY_CLIENT_NAMES.CLI, mode: GATEWAY_CLIENT_MODES.CLI };
    const health = await callLocal("health", cli);
    expect(health.ok).toBe(true);
    const admin = await callLocal("set-heartbeats", {
      ...cli,
      params: { enabled: false },
      scopes: ["operator.admin"],
    });
    expect(admin.ok).toBe(true);
    const pending = await devicePairingModule.listDevicePairing();
    expect(pending.pending).toHaveLength(0);
    await expectReadScopedPairing(identity.deviceId);
  });

  test("keeps local native approval clients off stale paired gateway-client baseline", async () => {
    const identity = await approveReadScopedDevice(
      GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      GATEWAY_CLIENT_MODES.BACKEND,
    );

    await expect(
      withOperatorApprovalsGatewayClient(
        {
          config: {
            gateway: { port: started.port, auth: { mode: "token", token: "secret" } },
          } as never,
          clientDisplayName: "test native approvals",
        },
        async () => undefined,
      ),
    ).resolves.toBeUndefined();

    const pending = await devicePairingModule.listDevicePairing();
    expect(pending.pending).toHaveLength(0);
    await expectReadScopedPairing(identity.deviceId);
  });

  test("accepts local silent reconnect when pairing was concurrently approved", async () => {
    const loaded = loadDeviceIdentity("silent-reconnect-race");
    const approveOriginal = devicePairingApprovalModule.approveDevicePairing;
    let simulatedRace = false;
    const forwardApprove = async (requestId: string, optionsOrBaseDir?: unknown) => {
      if (optionsOrBaseDir && typeof optionsOrBaseDir === "object") {
        return await approveOriginal(
          requestId,
          optionsOrBaseDir as { callerScopes?: readonly string[] },
        );
      }
      return await approveOriginal(requestId);
    };
    vi.spyOn(devicePairingApprovalModule, "approveDevicePairing").mockImplementation(
      async (requestId: string, optionsOrBaseDir?: unknown) => {
        if (simulatedRace) {
          return await forwardApprove(requestId, optionsOrBaseDir);
        }
        simulatedRace = true;
        await forwardApprove(requestId, optionsOrBaseDir);
        return null;
      },
    );

    const res = await connectIdentity(loaded);
    expect(res.ok).toBe(true);

    const paired = await getPairedDevice(loaded.identity.deviceId);
    expect(paired?.publicKey).toBe(loaded.publicKey);
    const operatorToken = paired?.tokens?.operator?.token;
    if (typeof operatorToken !== "string") {
      throw new Error("expected approved device operator token");
    }
    expect(operatorToken.length).toBeGreaterThan(0);
  });

  test("does not rebroadcast a deleted silent pairing request after a concurrent rejection", async () => {
    const loaded = loadDeviceIdentity("silent-reconnect-reject-race");
    vi.spyOn(devicePairingApprovalModule, "approveDevicePairing").mockImplementation(
      async (requestId: string) => {
        await devicePairingModule.rejectDevicePairing(requestId);
        return null;
      },
    );

    await connectOk(started.ws, { scopes: ["operator.pairing"], device: null });
    const requestedEvent = onceMessage(
      started.ws,
      (obj) => obj.type === "event" && obj.event === "device.pair.requested",
      300,
    )
      .then((event) => ({ ok: true as const, event }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    const res = await connectIdentity(loaded);

    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe("pairing required: device is not approved yet");
    expect(responseRequestId(res)).toBeUndefined();
    const requested = await requestedEvent;
    expect(requested.ok).toBe(false);
    if (requested.ok) {
      throw new Error("expected pairing request watcher to time out");
    }
    expect(requested.error).toBeInstanceOf(Error);
    expect((requested.error as Error).message).toContain("timeout");

    const pending = await devicePairingModule.listDevicePairing();
    expect(pending.pending).toStrictEqual([]);
  });

  test("returns the replacement pending request id when a silent request is superseded", async () => {
    const loaded = loadDeviceIdentity("silent-reconnect-supersede-race");
    let replacementRequestId = "";

    vi.spyOn(devicePairingApprovalModule, "approveDevicePairing").mockImplementation(
      async (_requestId: string) => {
        const replacement = await devicePairingModule.requestDevicePairing({
          deviceId: loaded.identity.deviceId,
          publicKey: loaded.publicKey,
          role: "operator",
          scopes: ["operator.read"],
          clientId: GATEWAY_CLIENT_NAMES.TEST,
          clientMode: GATEWAY_CLIENT_MODES.TEST,
          silent: false,
        });
        replacementRequestId = replacement.request.requestId;
        return null;
      },
    );

    const res = await connectIdentity(loaded);

    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe("pairing required: device is not approved yet");
    expect(replacementRequestId).toBeTypeOf("string");
    expect(replacementRequestId.length).toBeGreaterThan(0);
    expect(responseRequestId(res)).toBe(replacementRequestId);

    const pending = await devicePairingModule.listDevicePairing();
    expect(pending.pending.map((entry) => entry.requestId)).toContain(replacementRequestId);
  });
});
