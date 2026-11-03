import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { revokeDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import { signDevicePayload } from "../infra/device-identity.js";
import { decideBrowserPairRequest } from "../infra/device-pairing-browser-code.js";
import { withDevicePairingLock } from "../infra/device-pairing-lock.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import { buildBrowserPairPayload, type BrowserPairAction } from "../shared/browser-pair.js";
import { CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES } from "../shared/device-bootstrap-profile.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
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

function connectBrowser(browser: Browser, bootstrapToken: string) {
  return openWs(harness.port, { origin: originForPort(harness.port) }).then(async (socket) => {
    const result = await connectReq(socket, {
      skipDefaultAuth: true,
      bootstrapToken,
      role: "operator",
      scopes: [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES],
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

/** Owner-credential facts at the final effect: the request row and every issued bootstrap row. */
function readFinalEffect(requestId: string) {
  return runOpenClawStateWriteTransaction(({ db }) => ({
    request: db
      .prepare(
        "SELECT status, bootstrap_token FROM device_pairing_browser_requests WHERE request_id = ?",
      )
      .get(requestId),
    issued: db.prepare("SELECT count(*) AS total FROM device_bootstrap_tokens").get(),
  }));
}

const untouched = { request: { status: "pending", bootstrap_token: null } };

describe("browser device-code pairing", () => {
  it("connects only the browser that holds the requesting key", async () => {
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

    // Consecutive polls of one request are paced by the route.
    await delay(1_100);
    const collected = await collect(browser, requestId);
    expect(collected.status).toBe(200);
    const bootstrapToken = collected.body.bootstrapToken as string;
    expect(bootstrapToken).toBeTruthy();

    // The handoff is useless to anyone else, even when they obtain the bytes.
    expect((await connectBrowser(stranger, bootstrapToken)).ok).toBe(false);
    expect(await getPairedDevice(stranger.identity.deviceId)).toBeNull();

    expect((await connectBrowser(browser, bootstrapToken)).ok).toBe(true);
    const paired = await getPairedDevice(browser.identity.deviceId);
    expect(paired?.approvedScopes).toEqual([...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES]);
    expect(paired?.approvedVia).toBe("bootstrap");
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

  it("does not issue a credential when the request expires while approval waits for the lock", async () => {
    const browser = newBrowser();
    const { requestId, code } = await start(browser);
    const expiresAtMs = Date.now() + 60_000;
    setExpiry(requestId, expiresAtMs);
    const held = Promise.withResolvers<void>();
    const locked = Promise.withResolvers<void>();
    const holder = withDevicePairingLock(async () => {
      locked.resolve();
      await held.promise;
    }, "browser-pair-expiry-test");
    await locked.promise;
    // Queued before expiry; the clock passes the deadline before the lock is released.
    const approval = decideBrowserPairRequest({ code, requestId, decision: "approve" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAtMs + 1);
    try {
      held.resolve();
      await holder;
      expect(await approval).toEqual({ status: "expired" });
    } finally {
      clock.mockRestore();
    }
    expect(readFinalEffect(requestId).request).toBeUndefined();
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

  it("gives a removed browser a fresh code instead of its spent request", async () => {
    const browser = newBrowser();
    const first = await start(browser);
    expect((await decide(first.code, first.requestId)).ok).toBe(true);
    const collected = await collect(browser, first.requestId);
    expect((await connectBrowser(browser, collected.body.bootstrapToken as string)).ok).toBe(true);
    await rpcReq(adminSocket, "device.pair.remove", { deviceId: browser.identity.deviceId });

    const second = await start(browser);
    expect(second.requestId).not.toBe(first.requestId);
    expect((await decide(second.code, second.requestId)).ok).toBe(true);
    const again = await collect(browser, second.requestId);
    expect((await connectBrowser(browser, again.body.bootstrapToken as string)).ok).toBe(true);
    expect(await getPairedDevice(browser.identity.deviceId)).not.toBeNull();
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

  it.each([1, 2, 3])(
    "rolls back when authority ends at check %i of the approval",
    async (failAtCheck) => {
      const browser = newBrowser();
      const { requestId, code } = await start(browser);
      const before = readFinalEffect(requestId);
      let checks = 0;
      const assertCurrent = () => {
        checks += 1;
        if (checks === failAtCheck) {
          throw new Error("administrator revoked");
        }
      };
      await expect(
        decideBrowserPairRequest({ code, requestId, decision: "approve", assertCurrent }),
      ).rejects.toThrow("administrator revoked");
      expect(readFinalEffect(requestId)).toEqual(before);
      expect(await getPairedDevice(browser.identity.deviceId)).toBeNull();
    },
  );

  it("creates no paired device from a revoked bootstrap credential", async () => {
    const browser = newBrowser();
    const { requestId, code } = await start(browser);
    expect((await decide(code, requestId)).ok).toBe(true);
    const collected = await collect(browser, requestId);
    expect(collected.body.status).toBe("approved");
    const bootstrapToken = collected.body.bootstrapToken as string;
    expect((await revokeDeviceBootstrapToken({ token: bootstrapToken })).removed).toBe(true);

    expect((await connectBrowser(browser, bootstrapToken)).ok).toBe(false);
    expect(await getPairedDevice(browser.identity.deviceId)).toBeNull();
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
