import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as devicePairing from "../infra/device-pairing.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
} from "./device-authz.test-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startConnectedServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
await import("./server.js");

const FULL_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
];
const PAIRING_PENDING_TTL_MS = 5 * 60 * 1000;
const BROWSER_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const CONTROL_UI_CLIENT = {
  id: GATEWAY_CLIENT_IDS.CONTROL_UI,
  version: "test",
  platform: "web",
  mode: GATEWAY_CLIENT_MODES.WEBCHAT,
};
const BROWSER_CLIENT = {
  id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT,
  version: "test",
  platform: "chrome",
  deviceFamily: "extension",
  mode: GATEWAY_CLIENT_MODES.UI,
};
const BROWSER_CAPS = [
  GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS,
  GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS,
];
type Upgrade = { status: string; requestId: string; deviceToken: string; scopes: string[] };

describe("live device scope upgrade", () => {
  let started: Awaited<ReturnType<typeof startConnectedServerWithClient>>;
  const sockets = new Set<Awaited<ReturnType<typeof openTrackedWs>>>();
  async function openWs(headers?: Parameters<typeof openTrackedWs>[1]) {
    const ws = await openTrackedWs(started.port, headers);
    sockets.add(ws);
    return ws;
  }
  const requestUpgrade = (ws: Parameters<typeof rpcReq>[0], scopes = FULL_SCOPES) =>
    rpcReq<{ requestId: string }>(ws, "device.scopes.requestUpgrade", { scopes });
  const waitUpgrade = (ws: Parameters<typeof rpcReq>[0], requestId: string | undefined) =>
    rpcReq<Upgrade>(ws, "device.scopes.waitUpgrade", { requestId }, 10_000);
  async function decideUpgrade(requestId: string | undefined, decision = "approve") {
    expect((await rpcReq(started.ws, `device.pair.${decision}`, { requestId })).ok).toBe(true);
  }
  async function beginUpgrade(ws: Parameters<typeof rpcReq>[0]) {
    const registration = await requestUpgrade(ws);
    expect(registration).toMatchObject({ ok: true, payload: { requestId: expect.any(String) } });
    const requestId = registration.payload?.requestId;
    return { requestId, wait: waitUpgrade(ws, requestId) };
  }
  afterEach(() => {
    vi.restoreAllMocks();
    for (const ws of sockets) {
      ws.close();
    }
    sockets.clear();
  });
  beforeAll(async () => {
    started = await startConnectedServerWithClient("secret");
  });
  afterAll(async () => {
    started.ws.close();
    await started.server.close();
    started.envSnapshot.restore();
  });
  async function openLimitedDevice(
    name: string,
    controlUi = false,
    scopes = ["operator.read"],
    tokenScopes?: string[],
  ) {
    const paired = await issueOperatorToken({
      name,
      approvedScopes: scopes,
      tokenScopes,
      clientId: controlUi ? CONTROL_UI_CLIENT.id : GATEWAY_CLIENT_IDS.TEST,
      clientMode: controlUi ? CONTROL_UI_CLIENT.mode : GATEWAY_CLIENT_MODES.TEST,
    });
    const options = {
      deviceIdentityPath: paired.identityPath,
      scopes: tokenScopes ?? scopes,
      ...(controlUi ? { client: CONTROL_UI_CLIENT } : {}),
    };
    const headers = controlUi ? { origin: `http://127.0.0.1:${started.port}` } : undefined;
    if (controlUi) {
      const sharedAuthWs = await openWs(headers);
      await connectOk(sharedAuthWs, { token: "secret", ...options });
      const token = (await devicePairing.getPairedDevice(paired.deviceId))?.tokens?.operator?.token;
      if (!token) {
        throw new Error("expected shared-auth device token");
      }
      paired.token = token;
      sharedAuthWs.close();
    }
    const ws = await openWs(headers);
    await connectOk(ws, {
      skipDefaultAuth: true,
      deviceToken: paired.token,
      ...options,
    });
    return { ...paired, ws };
  }

  async function openLimitedBrowserDevice(name: string) {
    const { identityPath, identity } = loadDeviceIdentity(name);
    const ws = await openWs({ origin: BROWSER_ORIGIN });
    const hello = await connectOk(ws, {
      token: "secret",
      scopes: ["operator.read"],
      caps: BROWSER_CAPS,
      client: BROWSER_CLIENT,
      deviceIdentityPath: identityPath,
      prePairDevice: true,
      browserOrigin: BROWSER_ORIGIN,
    });
    const auth = (hello as { auth?: { deviceToken?: string } }).auth;
    expect(auth?.deviceToken).toBeTruthy();
    return { ws, identityPath, deviceId: identity.deviceId, token: auth?.deviceToken ?? "" };
  }

  test("lets a paired scope-less operator request access recovery", async () => {
    const limited = await openLimitedDevice("live-scope-upgrade-scope-less", false, []);
    const registration = await requestUpgrade(limited.ws);
    expect(registration.ok, JSON.stringify(registration.error)).toBe(true);
    expect(registration.payload?.requestId).toBeTypeOf("string");
  });

  test.each(["Control UI", "browser"])("upgrades and reconnects %s", async (kind) => {
    const browser = kind === "browser";
    const limited = browser
      ? await openLimitedBrowserDevice("live-scope-upgrade-browser-origin")
      : await openLimitedDevice("live-scope-upgrade-approved-control-ui", true);
    const { requestId, wait } = await beginUpgrade(limited.ws);
    if (!browser) {
      const pairingList = await rpcReq<{
        pending: Array<{ requestId: string; deviceId: string; scopes?: string[] }>;
      }>(started.ws, "device.pair.list", {});
      expect(
        pairingList.payload?.pending.find((entry) => entry.requestId === requestId),
      ).toMatchObject({
        deviceId: limited.deviceId,
        scopes: FULL_SCOPES.toSorted(),
      });
    }
    await decideUpgrade(requestId);
    const resolved = await wait;
    expect(resolved).toMatchObject({
      ok: true,
      payload: {
        status: "approved",
        requestId,
        scopes: expect.arrayContaining(["operator.admin"]),
      },
    });
    expect(resolved.payload?.deviceToken).not.toBe(limited.token);
    if (browser) {
      expect((await devicePairing.getPairedDevice(limited.deviceId))?.browserOrigin).toBe(
        BROWSER_ORIGIN,
      );
    }
    limited.ws.close();
    const reconnected = await openWs({
      origin: browser ? BROWSER_ORIGIN : `http://127.0.0.1:${started.port}`,
    });
    const hello = await connectOk(reconnected, {
      skipDefaultAuth: true,
      deviceToken: resolved.payload?.deviceToken,
      deviceIdentityPath: limited.identityPath,
      scopes: resolved.payload?.scopes,
      ...(browser ? { caps: BROWSER_CAPS, client: BROWSER_CLIENT } : { client: CONTROL_UI_CLIENT }),
    });
    expect((hello as { auth?: { scopes?: string[] } }).auth?.scopes).toContain("operator.admin");
  });

  test("explains approval that preserves a previously narrowed token without granting admin", async () => {
    const limited = await openLimitedDevice("narrowed", false, FULL_SCOPES, ["operator.read"]);
    const { requestId, wait } = await beginUpgrade(limited.ws);
    await decideUpgrade(requestId);
    const result = await wait;
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: expect.stringContaining("previously narrowed"),
      },
    });
    expect(result.error?.message).toContain("openclaw dashboard");
    expect(result.error).not.toMatchObject({ retryable: true });
    expect(result.payload).toBeUndefined();
    expect(
      (await devicePairing.getPairedDevice(limited.deviceId))?.tokens?.operator?.scopes,
    ).toEqual(["operator.read"]);
  });

  test("coalesces concurrent waits for the same device request", async () => {
    const limited = await openLimitedDevice("live-scope-upgrade-concurrent-waits");
    const readPending = devicePairing.getPendingDevicePairing;
    const { promise: readGate, resolve: releaseRead } = createDeferred();
    const pendingSpy = vi
      .spyOn(devicePairing, "getPendingDevicePairing")
      .mockImplementation(async (...args) => {
        await readGate;
        return await readPending(...args);
      });
    let requestId: string | undefined;
    let waits: Array<Promise<unknown>> = [];
    try {
      const registration = await requestUpgrade(limited.ws);
      requestId = registration.payload?.requestId;
      waits = [waitUpgrade(limited.ws, requestId), waitUpgrade(limited.ws, requestId)];
      await vi.waitFor(() => expect(pendingSpy).toHaveBeenCalled());
      expect(pendingSpy).toHaveBeenCalledTimes(1);
      releaseRead();
      await decideUpgrade(requestId, "reject");
      for (const wait of waits) {
        await expect(wait).resolves.toMatchObject({
          ok: true,
          payload: { status: "rejected", requestId },
        });
      }
    } finally {
      releaseRead();
      if (requestId) {
        await rpcReq(started.ws, "device.pair.reject", { requestId }).catch(() => undefined);
      }
      await Promise.allSettled(waits);
    }
  });

  test("requires a signed device identity", async () => {
    const ws = await openWs();
    await connectOk(ws, {
      token: "secret",
      device: null,
      scopes: ["operator.read"],
      client: {
        id: GATEWAY_CLIENT_IDS.CLI,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
    });
    const response = await requestUpgrade(ws);
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: {
          code: "DEVICE_IDENTITY_REQUIRED",
          recommendedNextStep: "reopen_control_ui_securely",
        },
      },
    });
  });

  test("rejects a requested scope set narrower than the live connection", async () => {
    const limited = await openLimitedDevice("live-scope-upgrade-narrower");
    const response = await requestUpgrade(limited.ws, ["operator.approvals"]);
    expect(response).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("current scopes") },
    });
  });

  test("uses the refreshed durable deadline when retrying an existing upgrade", async () => {
    const limited = await openLimitedDevice("live-scope-upgrade-refreshed-deadline");
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const first = await requestUpgrade(limited.ws);
    nowSpy.mockReturnValue(now + PAIRING_PENDING_TTL_MS - 1_000);
    const retry = await requestUpgrade(limited.ws);
    expect(retry.payload?.requestId).toBe(first.payload?.requestId);
    nowSpy.mockReturnValue(now + PAIRING_PENDING_TTL_MS + 1_000);
    const requestId = retry.payload?.requestId;
    const wait = waitUpgrade(limited.ws, requestId);
    await decideUpgrade(requestId);
    expect(await wait).toMatchObject({
      ok: true,
      payload: { status: "approved", requestId },
    });
  });

  test("does not disclose upgrade results to another authenticated device", async () => {
    const owner = await openLimitedDevice("live-scope-upgrade-owner");
    const other = await openLimitedDevice("live-scope-upgrade-other");
    const registration = await requestUpgrade(owner.ws);
    const requestId = registration.payload?.requestId;
    const crossDeviceWait = await rpcReq(other.ws, "device.scopes.waitUpgrade", { requestId });
    expect(crossDeviceWait).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "scope upgrade expired or not found" },
    });
    await decideUpgrade(requestId, "reject");
  });
});
