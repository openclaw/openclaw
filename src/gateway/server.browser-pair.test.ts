import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { signDevicePayload } from "../infra/device-identity.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { buildBrowserPairPayload, type BrowserPairAction } from "../shared/browser-pair.js";
import { CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES } from "../shared/device-bootstrap-profile.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { loadDeviceIdentity } from "./device-authz.test-helpers.js";
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

beforeAll(async () => {
  testState.gatewayAuth = {
    mode: "token",
    token: "secret",
    rateLimit: { maxAttempts: 100, windowMs: 60_000, lockoutMs: 60_000 },
  };
  harness = await createGatewaySuiteHarness({ serverOptions: { controlUiEnabled: true } });
  adminSocket = await harness.openWs();
  await connectOk(adminSocket, { token: "secret", scopes: ["operator.admin"] });
});

afterAll(async () => {
  adminSocket?.close();
  await harness?.close();
});

function post(
  action: BrowserPairAction,
  body: unknown,
  headers: Record<string, string> = { origin: originForPort(harness.port) },
) {
  return fetch(`http://127.0.0.1:${harness.port}/__openclaw__/browser-pair/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Sends headers fetch forbids, so a test can claim any Host. */
function postWithHeaders(headers: Record<string, string>, body: unknown) {
  return new Promise<number>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: harness.port,
        path: "/__openclaw__/browser-pair/start",
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
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

async function waitForDecision(browser: Browser, requestId: string) {
  // Consecutive polls of one request are paced by the route.
  await delay(1_100);
  return await collect(browser, requestId);
}

async function approve(code: string, requestId: string) {
  return await rpcReq(adminSocket, "device.pair.code", { code, requestId, decision: "approve" });
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
  runOpenClawStateWriteTransaction(({ db }) => {
    const table = "device_pairing_browser_requests";
    const rows = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, typeof table>>(db);
    executeSqliteQuerySync(
      db,
      rows
        .updateTable(table)
        .set({ expires_at_ms: expiresAtMs })
        .where("request_id", "=", requestId),
    );
  });
}

describe("browser device-code pairing", () => {
  it("accepts a same-origin page on a LAN address", async () => {
    const lanHost = "192.168.1.20:18789";
    const status = await postWithHeaders(
      { host: lanHost, origin: `http://${lanHost}` },
      signedBody(newBrowser(), "start"),
    );
    expect(status).toBe(200);
  });

  it("connects only the browser that holds the requesting key", async () => {
    const browser = newBrowser();
    const stranger = newBrowser();
    const { requestId, code } = await start(browser);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/u);

    const pending = await collect(browser, requestId);
    expect(pending.body).toEqual({ status: "pending" });

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

    expect((await approve(code, requestId)).ok).toBe(true);

    // A stranger signing for the request id neither collects nor learns its state.
    const strangerCollect = await collect(stranger, requestId);
    expect(strangerCollect).toEqual({ status: 404, body: { error: "not_found" } });

    const collected = await waitForDecision(browser, requestId);
    expect(collected.status).toBe(200);
    const bootstrapToken = collected.body.bootstrapToken as string;
    expect(bootstrapToken).toBeTruthy();

    // The handoff is useless to anyone else, even when they obtain the bytes.
    const stolen = await connectBrowser(stranger, bootstrapToken);
    expect(stolen.ok).toBe(false);
    expect(await getPairedDevice(stranger.identity.deviceId)).toBeNull();

    const connected = await connectBrowser(browser, bootstrapToken);
    expect(connected.ok).toBe(true);
    const paired = await getPairedDevice(browser.identity.deviceId);
    expect(paired?.approvedScopes).toEqual([...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES]);
    expect(paired?.approvedVia).toBe("bootstrap");
  });

  it("refuses a code nobody is waiting on", async () => {
    const refused = await rpcReq(adminSocket, "device.pair.code", { code: "ZZZZ-ZZZZ" });
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toContain("No browser is waiting for this code");
  });

  it("refuses an expired code and tells the waiting browser", async () => {
    const browser = newBrowser();
    const { requestId, code } = await start(browser);
    setExpiry(requestId, Date.now() - 1);

    const refused = await rpcReq(adminSocket, "device.pair.code", { code });
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toContain("expired");
    expect((await approve(code, requestId)).ok).toBe(false);
    expect((await collect(browser, requestId)).status).toBe(404);
  });

  it("does not issue a credential for an expired request under approval", async () => {
    const browser = newBrowser();
    const { requestId, code } = await start(browser);
    await collect(browser, requestId);
    setExpiry(requestId, Date.now() - 1);
    const refused = await approve(code, requestId);
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toContain("expired");
  });

  it("reports a host rejection to the browser and spends the code", async () => {
    const browser = newBrowser();
    const { requestId, code } = await start(browser);
    const rejected = await rpcReq(adminSocket, "device.pair.code", {
      code,
      requestId,
      decision: "reject",
    });
    expect(rejected.ok).toBe(true);
    expect((await collect(browser, requestId)).body).toEqual({ status: "rejected" });
    expect((await approve(code, requestId)).ok).toBe(false);
  });

  it("will not approve a request the operator did not inspect", async () => {
    const browser = newBrowser();
    const { code } = await start(browser);
    const refused = await approve(code, "another-request");
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toContain("No browser is waiting");
  });

  it("requires operator.admin to see or decide a request", async () => {
    const browser = newBrowser();
    const { requestId, code } = await start(browser);
    const limited = await harness.openWs();
    await connectOk(limited, { token: "secret", scopes: ["operator.pairing"] });
    const inspect = await rpcReq(limited, "device.pair.code", { code });
    const decide = await rpcReq(limited, "device.pair.code", {
      code,
      requestId,
      decision: "approve",
    });
    limited.close();
    expect(inspect.error?.message).toContain("operator.admin");
    expect(decide.error?.message).toContain("operator.admin");
  });

  it("keeps one code across repeated clicks", async () => {
    const browser = newBrowser();
    const first = await start(browser);
    expect(await start(browser)).toEqual(first);
  });

  it("gives a removed browser a fresh code instead of its spent request", async () => {
    const browser = newBrowser();
    const first = await start(browser);
    expect((await approve(first.code, first.requestId)).ok).toBe(true);
    const collected = await collect(browser, first.requestId);
    expect((await connectBrowser(browser, collected.body.bootstrapToken as string)).ok).toBe(true);
    await rpcReq(adminSocket, "device.pair.remove", { deviceId: browser.identity.deviceId });

    const second = await start(browser);
    expect(second.requestId).not.toBe(first.requestId);
    expect((await approve(second.code, second.requestId)).ok).toBe(true);
    const again = await collect(browser, second.requestId);
    expect((await connectBrowser(browser, again.body.bootstrapToken as string)).ok).toBe(true);
    expect(await getPairedDevice(browser.identity.deviceId)).not.toBeNull();
  });

  it("refuses a browser that cannot prove its key", async () => {
    const browser = newBrowser();
    const stranger = newBrowser();
    const forged = { ...signedBody(stranger, "start"), deviceId: browser.identity.deviceId };
    expect((await post("start", forged)).status).toBe(400);
    const replayed = {
      ...signedBody(browser, "start"),
      signature: signedBody(browser, "collect", "request").signature,
    };
    expect((await post("start", replayed)).status).toBe(400);
  });

  it("paces repeated polls without answering for another browser", async () => {
    const browser = newBrowser();
    const stranger = newBrowser();
    const { requestId } = await start(browser);
    expect((await collect(browser, requestId)).body).toEqual({ status: "pending" });
    expect((await collect(browser, requestId)).body).toEqual({ status: "pending" });
    expect((await collect(stranger, requestId)).status).toBe(404);
  });

  it("refuses requests from another site", async () => {
    const browser = newBrowser();
    const response = await post("start", signedBody(browser, "start"), {
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
    const noOrigin = await post("start", signedBody(browser, "start"), {});
    expect(noOrigin.status).toBe(403);
  });
});
