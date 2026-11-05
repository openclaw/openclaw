import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { signDevicePayload } from "../infra/device-identity.js";
import { decideBrowserPairRequest } from "../infra/device-pairing-browser-code.js";
import { withDevicePairingLock } from "../infra/device-pairing-lock.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { buildBrowserPairPayload, type BrowserPairAction } from "../shared/browser-pair.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { CONTROL_UI_OPERATOR_SCOPES } from "./control-ui-bootstrap-contract.js";
import { issueOperatorToken, loadDeviceIdentity } from "./device-authz.test-helpers.js";
import { CONTROL_UI_CLIENT, openWs, originForPort } from "./server.auth.test-helpers.js";
import {
  connectOk,
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type Browser = ReturnType<typeof loadDeviceIdentity>;
type Started = { requestId: string; code: string; expiresAtMs: number };

let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let adminSocket: WebSocket;
let browserCount = 0;

function newBrowser(): Browser {
  browserCount += 1;
  return loadDeviceIdentity(`browser-pair-${browserCount}`);
}

function startGateway(maxAttempts: number) {
  testState.gatewayAuth = {
    mode: "token",
    token: "secret",
    rateLimit: { maxAttempts, windowMs: 60_000, lockoutMs: 60_000 },
  };
  return createGatewaySuiteHarness({ serverOptions: { controlUiEnabled: true } });
}

async function openOperator(scopes: string[]): Promise<WebSocket> {
  const socket = await harness.openWs();
  await connectOk(socket, { token: "secret", scopes });
  return socket;
}

beforeAll(async () => {
  harness = await startGateway(100);
  adminSocket = await openOperator(["operator.admin"]);
});

afterAll(async () => {
  adminSocket?.close();
  await harness?.close();
});

function post(
  action: BrowserPairAction,
  body: unknown,
  { port = harness.port, headers = { origin: originForPort(port) } as Record<string, string> } = {},
) {
  return fetch(`http://127.0.0.1:${port}/__openclaw__/browser-pair/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function signedBody(browser: Browser, action: BrowserPairAction, requestId?: string) {
  const { deviceId, privateKeyPem } = browser.identity;
  return {
    deviceId,
    publicKey: browser.publicKey,
    signature: signDevicePayload(
      privateKeyPem,
      buildBrowserPairPayload({ action, deviceId, requestId }),
    ),
    ...(requestId ? { requestId } : {}),
  };
}

async function start(browser: Browser): Promise<Started> {
  const response = await post("start", signedBody(browser, "start"));
  expect(response.status).toBe(200);
  return (await response.json()) as Started;
}

async function collect(browser: Browser, requestId: string) {
  const response = await post("collect", signedBody(browser, "collect", requestId));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function decide(code: string, requestId: string, decision = "approve", socket = adminSocket) {
  return rpcReq(socket, "device.pair.code", { code, requestId, decision });
}

async function approveAndCollect(browser: Browser): Promise<string> {
  const { requestId, code } = await start(browser);
  expect((await decide(code, requestId)).ok).toBe(true);
  const collected = await collect(browser, requestId);
  expect(collected.body).toMatchObject({ status: "approved", role: "operator" });
  return collected.body.deviceToken as string;
}

function connectBrowser(browser: Browser, deviceToken: string) {
  return openWs(harness.port, { origin: originForPort(harness.port) }).then(async (socket) => {
    const result = await connectReq(socket, {
      skipDefaultAuth: true,
      deviceToken,
      role: "operator",
      scopes: [...CONTROL_UI_OPERATOR_SCOPES],
      client: CONTROL_UI_CLIENT,
      deviceIdentityPath: browser.identityPath,
    });
    socket.close();
    return result;
  });
}

function setExpiry(requestId: string, expiresAtMs: number) {
  runOpenClawStateWriteTransaction(({ db }) =>
    db
      .prepare("UPDATE device_pairing_browser_requests SET expires_at_ms = ? WHERE request_id = ?")
      .run(expiresAtMs, requestId),
  );
}

/** Facts at the final effect: the request row and the requesting device's pairing rows. */
function readFinalEffect(requestId: string) {
  const device = "(SELECT device_id FROM device_pairing_browser_requests WHERE request_id = ?)";
  return runOpenClawStateWriteTransaction(({ db }) => ({
    request: db
      .prepare("SELECT status FROM device_pairing_browser_requests WHERE request_id = ?")
      .get(requestId),
    paired: db
      .prepare(`SELECT count(*) AS total FROM device_pairing_paired WHERE device_id = ${device}`)
      .get(requestId),
    pending: db
      .prepare(`SELECT count(*) AS total FROM device_pairing_pending WHERE device_id = ${device}`)
      .get(requestId),
  }));
}

const untouched = { request: { status: "pending" }, paired: { total: 0 }, pending: { total: 0 } };

describe("browser device-code pairing", () => {
  it("pairs a first-time browser as an ordinary admin device only for its own key", async () => {
    const browser = newBrowser();
    const stranger = newBrowser();
    const started = await start(browser);
    const { requestId, code } = started;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/u);
    expect(await start(browser)).toEqual(started);

    // Repeated polls are paced without answering for another browser.
    expect((await collect(browser, requestId)).body).toEqual({ status: "pending" });
    expect((await collect(browser, requestId)).body).toEqual({ status: "pending" });
    expect((await collect(stranger, requestId)).status).toBe(404);

    const inspected = await rpcReq<Record<string, unknown>>(adminSocket, "device.pair.code", {
      code: `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`,
    });
    expect(inspected.payload).toMatchObject({
      status: "pending",
      requestId,
      code,
      deviceId: browser.identity.deviceId,
      origin: originForPort(harness.port),
    });
    expect(inspected.payload?.remoteIp).toBeTruthy();
    expect(JSON.stringify(inspected.payload)).not.toContain(browser.publicKey);

    expect((await decide(code, requestId)).ok).toBe(true);

    // A stranger signing for the request id neither collects nor learns its state.
    expect(await collect(stranger, requestId)).toEqual({
      status: 404,
      body: { error: "not_found" },
    });

    // Approval alone pairs the device through the owner approval rules, with no handoff.
    const paired = await getPairedDevice(browser.identity.deviceId);
    expect(paired).toMatchObject({
      publicKey: browser.publicKey,
      approvedVia: "owner",
      roles: ["operator"],
      approvedScopes: expect.arrayContaining([...CONTROL_UI_OPERATOR_SCOPES]),
    });
    expect(readFinalEffect(requestId)).toMatchObject({
      paired: { total: 1 },
      pending: { total: 0 },
    });
    // Like tokens issued at connect, it retires when the shared Gateway secret rotates.
    expect(paired?.tokens?.operator?.issuer?.kind).toBe("shared-gateway-auth");

    // Consecutive polls of one request are paced by the route.
    await delay(1_100);
    const collected = await collect(browser, requestId);
    expect(collected.status).toBe(200);
    const deviceToken = collected.body.deviceToken as string;
    expect(deviceToken).toBe(paired?.tokens?.operator?.token);
    // A dropped reply can be collected again until expiry; the token stays key-bound.
    expect((await collect(browser, requestId)).body).toMatchObject({ deviceToken });

    // The token is useless to anyone else, even when they obtain the bytes.
    expect((await connectBrowser(stranger, deviceToken)).ok).toBe(false);
    expect(await getPairedDevice(stranger.identity.deviceId)).toBeNull();
    expect((await connectBrowser(browser, deviceToken)).ok).toBe(true);
  });

  it("refuses a code nobody is waiting on", async () => {
    const refused = await rpcReq(adminSocket, "device.pair.code", { code: "ZZZZ-ZZZZ" });
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toContain("No browser is waiting for this code");
  });

  it("refuses an expired code at inspection and tells the waiting browser", async () => {
    const browser = newBrowser();
    const { requestId, code } = await start(browser);
    setExpiry(requestId, Date.now() - 1);
    const refused = await rpcReq(adminSocket, "device.pair.code", { code });
    expect(refused.error?.message).toContain("expired");
    expect((await decide(code, requestId)).ok).toBe(false);
    expect((await collect(browser, requestId)).status).toBe(404);
  });

  it("does not issue a credential for an expired request under approval", async () => {
    const { requestId, code } = await start(newBrowser());
    setExpiry(requestId, Date.now() - 1);
    expect((await decide(code, requestId)).error?.message).toContain("expired");
  });

  it("does not pair when the request expires while approval waits in the writer queue", async () => {
    const browser = newBrowser();
    const { requestId, code } = await start(browser);
    const expiresAtMs = Date.now() + 60_000;
    setExpiry(requestId, expiresAtMs);
    const before = readFinalEffect(requestId);
    let now = expiresAtMs - 1;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      // The decision reads its clock before the deadline; the first authority check
      // runs after that read and before the writer admits it, so time passes there.
      const approval = decideBrowserPairRequest({
        code,
        requestId,
        decision: "approve",
        callerScopes: ["operator.admin"],
        assertCurrent: () => {
          now = expiresAtMs + 1;
        },
      });
      expect(await approval).toEqual({ status: "expired" });
    } finally {
      clock.mockRestore();
    }
    expect(readFinalEffect(requestId)).toEqual(before);
    expect(await getPairedDevice(browser.identity.deviceId)).toBeNull();
  });

  it("reports a host rejection to the browser and spends the code", async () => {
    const browser = newBrowser();
    const { requestId, code } = await start(browser);
    expect((await decide(code, requestId, "reject")).ok).toBe(true);
    expect((await collect(browser, requestId)).body).toEqual({ status: "rejected" });
    expect((await decide(code, requestId)).ok).toBe(false);
  });

  it("will not approve a request the operator did not inspect", async () => {
    const { code } = await start(newBrowser());
    expect((await decide(code, "another-request")).error?.message).toContain("No browser");
  });

  it("pairs a removed browser again with a fresh code", async () => {
    const browser = newBrowser();
    expect((await connectBrowser(browser, await approveAndCollect(browser))).ok).toBe(true);
    await rpcReq(adminSocket, "device.pair.remove", { deviceId: browser.identity.deviceId });

    expect((await connectBrowser(browser, await approveAndCollect(browser))).ok).toBe(true);
    expect(await getPairedDevice(browser.identity.deviceId)).not.toBeNull();
  });

  it("approves only operator access over the browser's own earlier pending request", async () => {
    const browser = newBrowser();
    // An unauthenticated handshake from the same key asked for more than a code grants.
    await requestDevicePairing({
      deviceId: browser.identity.deviceId,
      publicKey: browser.publicKey,
      role: "node",
      roles: ["node", "operator"],
      scopes: ["operator.talk.secrets"],
    });
    const { requestId, code } = await start(browser);
    expect(readFinalEffect(requestId).pending).toEqual({ total: 1 });
    expect((await decide(code, requestId)).ok).toBe(true);
    const paired = await getPairedDevice(browser.identity.deviceId);
    expect(paired?.roles).toEqual(["operator"]);
    expect(paired?.tokens?.node).toBeUndefined();
    expect(paired?.approvedScopes).not.toContain("operator.talk.secrets");
    expect(readFinalEffect(requestId).pending).toEqual({ total: 0 });
  });

  it("refuses to restore an operator token an administrator reduced", async () => {
    const browser = newBrowser();
    await approveAndCollect(browser);
    const deviceId = browser.identity.deviceId;
    const rotated = await rpcReq(adminSocket, "device.token.rotate", {
      deviceId,
      role: "operator",
      scopes: ["operator.read"],
    });
    expect(rotated.ok).toBe(true);
    const reduced = await getPairedDevice(deviceId);

    const { requestId, code } = await start(browser);
    const refused = await decide(code, requestId);
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toContain("does not lift that limit");
    expect(refused.error?.message).toContain(`openclaw devices remove ${deviceId}`);
    expect(await getPairedDevice(deviceId)).toEqual(reduced);
    // Still pending, so the same code works once the owner removes the device.
    expect(readFinalEffect(requestId).request).toEqual({ status: "pending" });
  });

  it("refuses a browser without its key and a page from another site", async () => {
    const browser = newBrowser();
    const signed = signedBody(browser, "start");
    const forged = { ...signedBody(newBrowser(), "start"), deviceId: browser.identity.deviceId };
    const replayed = { ...signed, signature: signedBody(browser, "collect", "request").signature };
    expect((await post("start", forged)).status).toBe(400);
    expect((await post("start", replayed)).status).toBe(400);
    const evil = { headers: { origin: "https://evil.example" } };
    expect((await post("start", signed, evil)).status).toBe(403);
    expect((await post("start", signed, { headers: {} })).status).toBe(403);
  });

  it.each([["operator.pairing"], ["operator.read"], ["operator.write"]])(
    "shows and issues nothing to a caller holding only %s",
    async (scope) => {
      const browser = newBrowser();
      const { requestId, code } = await start(browser);
      const before = readFinalEffect(requestId);
      const caller = await openOperator([scope]);
      const inspected = await rpcReq(caller, "device.pair.code", { code });
      const refused = await decide(code, requestId, "approve", caller);
      caller.close();
      expect(inspected.error?.message).toContain("operator.admin");
      expect(refused.error?.message).toContain("operator.admin");
      expect(readFinalEffect(requestId)).toEqual(before);
      expect(before).toMatchObject(untouched);
      expect((await collect(browser, requestId)).body).toEqual({ status: "pending" });
    },
  );

  it("issues nothing when the administrator is revoked while approval is queued", async () => {
    const browser = newBrowser();
    const { requestId, code } = await start(browser);
    const before = readFinalEffect(requestId);
    const admin = await issueOperatorToken({
      name: `browser-pair-revoked-admin-${browserCount}`,
      approvedScopes: ["operator.admin"],
    });
    const revokedAdmin = await harness.openWs();
    await connectOk(revokedAdmin, {
      skipDefaultAuth: true,
      deviceToken: admin.token,
      deviceIdentityPath: admin.identityPath,
      scopes: ["operator.admin"],
    });

    // Both requests park behind the pairing lock in this order, so the revocation
    // commits first and the approval reaches its final effect with authority gone.
    let revocation: ReturnType<typeof rpcReq> | undefined;
    let approval: ReturnType<typeof rpcReq> | undefined;
    await withDevicePairingLock(async () => {
      revocation = rpcReq(adminSocket, "device.token.revoke", {
        deviceId: admin.deviceId,
        role: "operator",
      });
      await delay(100);
      approval = decide(code, requestId, "approve", revokedAdmin);
      await delay(100);
    }, "browser-pair-authority-test");

    expect((await revocation)?.ok).toBe(true);
    const outcome = await Promise.race([
      approval?.catch(() => null),
      delay(2_000).then(() => null),
    ]);
    revokedAdmin.close();
    expect(outcome?.ok ?? false).toBe(false);
    expect(readFinalEffect(requestId)).toEqual(before);
    expect(before).toMatchObject(untouched);
    expect((await collect(browser, requestId)).body).toEqual({ status: "pending" });
  });

  it("rolls back when authority ends at any check of the approval", async () => {
    const approve = (started: Started, assertCurrent: () => void) =>
      decideBrowserPairRequest({
        code: started.code,
        requestId: started.requestId,
        decision: "approve",
        callerScopes: ["operator.admin"],
        assertCurrent,
      });
    let total = 0;
    await approve(await start(newBrowser()), () => {
      total += 1;
    });
    expect(total).toBeGreaterThanOrEqual(3);
    for (let failAtCheck = 1; failAtCheck <= total; failAtCheck += 1) {
      const browser = newBrowser();
      const started = await start(browser);
      const before = readFinalEffect(started.requestId);
      let checks = 0;
      await expect(
        approve(started, () => {
          checks += 1;
          if (checks === failAtCheck) {
            throw new Error("administrator revoked");
          }
        }),
      ).rejects.toThrow("administrator revoked");
      expect(readFinalEffect(started.requestId)).toEqual(before);
      expect(await getPairedDevice(browser.identity.deviceId)).toBeNull();
    }
  });

  // Last: a second Gateway replaces the shared auth state this file's sockets rely on.
  it("limits how many requests one source can file", async () => {
    const limited = await startGateway(2);
    const file = () => post("start", signedBody(newBrowser(), "start"), { port: limited.port });
    expect((await file()).status).toBe(200);
    expect((await file()).status).toBe(200);
    const refused = await file();
    await limited.close();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBeTruthy();
    expect(await refused.json()).toEqual({ error: "rate_limited" });
  });
});
