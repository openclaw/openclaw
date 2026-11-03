import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { revokeDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import { signDevicePayload } from "../infra/device-identity.js";
import { decideBrowserPairRequest } from "../infra/device-pairing-browser-code.js";
import { withDevicePairingLock } from "../infra/device-pairing-lock.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { buildBrowserPairPayload, type BrowserPairAction } from "../shared/browser-pair.js";
import { CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES } from "../shared/device-bootstrap-profile.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
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
type StateTables = Pick<
  OpenClawStateKyselyDatabase,
  "device_bootstrap_tokens" | "device_pairing_browser_requests"
>;

let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let browserCount = 0;

beforeAll(async () => {
  testState.gatewayAuth = {
    mode: "token",
    token: "secret",
    rateLimit: { maxAttempts: 100, windowMs: 60_000, lockoutMs: 60_000 },
  };
  harness = await createGatewaySuiteHarness({ serverOptions: { controlUiEnabled: true } });
});

afterAll(async () => {
  await harness?.close();
});

function newBrowser(): Browser {
  browserCount += 1;
  return loadDeviceIdentity(`browser-pair-authority-${browserCount}`);
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

async function post(action: BrowserPairAction, body: unknown) {
  const response = await fetch(
    `http://127.0.0.1:${harness.port}/__openclaw__/browser-pair/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: originForPort(harness.port) },
      body: JSON.stringify(body),
    },
  );
  return (await response.json()) as Record<string, string>;
}

async function start(browser: Browser) {
  const { requestId, code } = await post("start", signedBody(browser, "start"));
  return { requestId: requestId as string, code: code as string };
}

/** Owner-credential facts at the final effect: the request row and every issued bootstrap row. */
function readFinalEffect(requestId: string) {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const rows = getNodeSqliteKysely<StateTables>(db);
    const request = executeSqliteQuerySync(
      db,
      rows
        .selectFrom("device_pairing_browser_requests")
        .select(["status", "bootstrap_token"])
        .where("request_id", "=", requestId),
    ).rows[0];
    const issued = executeSqliteQuerySync(
      db,
      rows.selectFrom("device_bootstrap_tokens").select("token"),
    ).rows.length;
    return { status: request?.status, bootstrapToken: request?.bootstrap_token ?? null, issued };
  });
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

async function openOperator(scopes: string[]): Promise<WebSocket> {
  const socket = await harness.openWs();
  await connectOk(socket, { token: "secret", scopes });
  return socket;
}

describe("browser pairing authority at the final effect", () => {
  it.each([["operator.pairing"], ["operator.read"], ["operator.write"]])(
    "issues nothing to a caller holding only %s",
    async (scope) => {
      const browser = newBrowser();
      const { requestId, code } = await start(browser);
      const before = readFinalEffect(requestId);
      const caller = await openOperator([scope]);
      const refused = await rpcReq(caller, "device.pair.code", {
        code,
        requestId,
        decision: "approve",
      });
      caller.close();
      expect(refused.ok).toBe(false);
      expect(refused.error?.message).toContain("operator.admin");
      expect(readFinalEffect(requestId)).toEqual(before);
      expect(before).toMatchObject({ status: "pending", bootstrapToken: null });
      expect(await post("collect", signedBody(browser, "collect", requestId))).toEqual({
        status: "pending",
      });
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
    const otherAdmin = await openOperator(["operator.admin"]);

    // Both requests park behind the pairing lock in this order, so the revocation
    // commits first and the approval reaches its final effect with authority gone.
    let revocation: ReturnType<typeof rpcReq> | undefined;
    let approval: ReturnType<typeof rpcReq> | undefined;
    await withDevicePairingLock(async () => {
      revocation = rpcReq(otherAdmin, "device.token.revoke", {
        deviceId: admin.deviceId,
        role: "operator",
      });
      await delay(100);
      approval = rpcReq(revokedAdmin, "device.pair.code", {
        code,
        requestId,
        decision: "approve",
      });
      await delay(100);
    }, "browser-pair-authority-test");

    expect((await revocation)?.ok).toBe(true);
    const outcome = await Promise.race([
      approval?.catch(() => null),
      delay(2_000).then(() => null),
    ]);
    otherAdmin.close();
    revokedAdmin.close();
    expect(outcome?.ok ?? false).toBe(false);
    expect(readFinalEffect(requestId)).toEqual(before);
    expect(before).toMatchObject({ status: "pending", bootstrapToken: null });
    expect(await post("collect", signedBody(browser, "collect", requestId))).toEqual({
      status: "pending",
    });
  });

  it.each([1, 2, 3])(
    "rolls back when authority ends at check %i of the approval",
    async (failAtCheck) => {
      const browser = newBrowser();
      const { requestId, code } = await start(browser);
      const before = readFinalEffect(requestId);
      let checks = 0;
      await expect(
        decideBrowserPairRequest({
          code,
          requestId,
          decision: "approve",
          assertCurrent: () => {
            checks += 1;
            if (checks === failAtCheck) {
              throw new Error("administrator revoked");
            }
          },
        }),
      ).rejects.toThrow("administrator revoked");
      expect(readFinalEffect(requestId)).toEqual(before);
      expect(await getPairedDevice(browser.identity.deviceId)).toBeNull();
    },
  );

  it("creates no paired device from a revoked bootstrap credential", async () => {
    const browser = newBrowser();
    const { requestId, code } = await start(browser);
    const admin = await openOperator(["operator.admin"]);
    const approved = await rpcReq(admin, "device.pair.code", {
      code,
      requestId,
      decision: "approve",
    });
    admin.close();
    expect(approved.ok).toBe(true);
    const collected = await post("collect", signedBody(browser, "collect", requestId));
    expect(collected.status).toBe("approved");
    const bootstrapToken = collected.bootstrapToken as string;
    expect((await revokeDeviceBootstrapToken({ token: bootstrapToken })).removed).toBe(true);

    const redeemed = await connectBrowser(browser, bootstrapToken);
    expect(redeemed.ok).toBe(false);
    expect(await getPairedDevice(browser.identity.deviceId)).toBeNull();
  });
});
