import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import type { WebSocket } from "ws";
import { getPairedDevice } from "../infra/device-pairing.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { decodePairingSetupCode } from "../pairing/setup-code.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import * as workerContext from "../state/openclaw-state-worker-context.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { loadDeviceIdentity } from "./device-authz.test-helpers.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type JoinSetupResult = { setupCode: string; joinUrl: string };
type NodeAuth = { bootstrapToken?: string; deviceToken?: string };
const opaqueNotFound = { error: "not_found" };

let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let adminSocket: WebSocket;

beforeAll(async () => {
  testState.gatewayAuth = {
    mode: "token",
    token: "secret",
    rateLimit: { maxAttempts: 2, windowMs: 60_000, lockoutMs: 60_000 },
  };
  harness = await createGatewaySuiteHarness();
  adminSocket = await harness.openWs();
  await connectOk(adminSocket, { token: "secret", scopes: ["operator.admin"] });
});

afterAll(async () => {
  adminSocket?.close();
  await harness?.close();
});

async function mintJoinUrl(contextPath = ""): Promise<JoinSetupResult> {
  const response = await rpcReq<JoinSetupResult>(adminSocket, "device.pair.setupCode", {
    bootstrapProfile: "node",
    includeQr: false,
    joinUrl: true,
    publicUrl: `ws://127.0.0.1:${harness.port}${contextPath}`,
  });
  if (!response.ok || !response.payload?.setupCode || !response.payload.joinUrl) {
    throw new Error(`join-code mint failed: ${JSON.stringify(response.error)}`);
  }
  return response.payload;
}

const shortcodeFromUrl = (joinUrl: string) => new URL(joinUrl).pathname.split("/").at(-1) ?? "";

function accessJoinCode(
  joinUrl: string,
  values?: { shortcode?: string; expires_at_ms?: number; payload_json?: string | null },
) {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const table = "device_pairing_join_codes";
    const codes = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, typeof table>>(db);
    const shortcode = shortcodeFromUrl(joinUrl);
    if (values) {
      const update = codes.updateTable(table).set(values).where("shortcode", "=", shortcode);
      return executeSqliteQuerySync(db, update).rows;
    }
    const read = codes.selectFrom(table).select("shortcode").where("shortcode", "=", shortcode);
    return executeSqliteQuerySync(db, read).rows;
  });
}

async function expectJoined({ joinUrl, setupCode }: JoinSetupResult) {
  const response = await fetch(joinUrl);
  expect(Buffer.from(shortcodeFromUrl(joinUrl), "base64url").byteLength).toBeGreaterThanOrEqual(16);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const payload = decodePairingSetupCode(setupCode);
  expect(await response.text()).toBe(JSON.stringify(payload));
  return payload;
}

async function expectConcurrent(url: string, statuses: number[], bodies: Record<number, unknown>) {
  const responses = await Promise.all(statuses.map(() => fetch(url)));
  expect(responses.map(({ status }) => status).toSorted((a, b) => a - b)).toEqual(statuses);
  for (const response of responses) {
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(JSON.stringify(bodies[response.status]));
  }
}

it("keeps the code-less /j route claimed by the join handler", async () => {
  // One miss only: a second recorded failure would trip the suite's
  // maxAttempts=2 limiter before the next test's successful reset.
  const response = await fetch(`http://127.0.0.1:${harness.port}/j`);
  expect([response.status, await response.json()]).toEqual([404, opaqueNotFound]);
});

it("mints by RPC and redeems by HTTP without caller-thread join-code SQL", async () => {
  const statements = (["prepare", "exec"] as const).map((method) =>
    vi.spyOn(DatabaseSync.prototype, method),
  );
  onTestFinished(() => statements.forEach((spy) => spy.mockRestore()));
  await expectJoined(await mintJoinUrl());
  const joinCodeSql = statements
    .flatMap((spy) => spy.mock.calls)
    .filter(([sql]) => /\bdevice_pairing_join_codes\b/u.test(sql));
  expect(joinCodeSql).toEqual([]);
});

it("routes advertised context paths when the shortcode begins with j", async () => {
  const setup = await mintJoinUrl("/public-gateway");
  const originalShortcode = shortcodeFromUrl(setup.joinUrl);
  const jPrefixedShortcode = `j${"a".repeat(21)}`;
  accessJoinCode(setup.joinUrl, { shortcode: jPrefixedShortcode });
  const joinUrl = new URL(setup.joinUrl);
  joinUrl.pathname = joinUrl.pathname.replace(originalShortcode, jPrefixedShortcode);

  await expectJoined({ ...setup, joinUrl: joinUrl.href });
});

it("approves the joined node's initial surface but gates a later manifest escalation", async () => {
  const payload = await expectJoined(await mintJoinUrl());
  const commands = ["system.run"];
  const loaded = loadDeviceIdentity("join-code-node-surface");
  const connectNode = async (auth: NodeAuth, requested: string[]) => {
    const socket = await harness.openWs();
    await connectOk(socket, {
      skipDefaultAuth: true,
      role: "node",
      scopes: [],
      client: {
        id: GATEWAY_CLIENT_NAMES.NODE_HOST,
        version: "1.0.0",
        platform: "macos",
        deviceFamily: "Mac",
        mode: GATEWAY_CLIENT_MODES.NODE,
      },
      deviceIdentityPath: loaded.identityPath,
      ...auth,
      commands: requested,
    });
    socket.close();
  };
  await connectNode({ bootstrapToken: payload.bootstrapToken }, commands);

  const paired = await getPairedDevice(loaded.identity.deviceId);
  expect(paired).toMatchObject({ approvedVia: "bootstrap", nodeSurface: { commands } });
  expect(paired?.pendingNodeSurface).toBeUndefined();

  await connectNode({ deviceToken: paired?.tokens?.node?.token }, ["system.run", "system.which"]);

  const escalated = await getPairedDevice(loaded.identity.deviceId);
  expect(escalated?.nodeSurface?.commands).toEqual(["system.run"]);
  expect(escalated?.pendingNodeSurface?.commands).toEqual(["system.run", "system.which"]);
});

it("burns once and malformed payloads, expires opaquely, and serializes concurrent misses", async () => {
  const expired = await mintJoinUrl();
  accessJoinCode(expired.joinUrl, { expires_at_ms: 0 });

  const expiredResponse = await fetch(expired.joinUrl);
  expect([expiredResponse.status, await expiredResponse.text()]).toEqual([
    404,
    JSON.stringify(opaqueNotFound),
  ]);
  expect(accessJoinCode(expired.joinUrl)).toEqual([]);

  for (const payloadJson of ["{malformed", null]) {
    await expectJoined(await mintJoinUrl("/public-gateway"));
    const malformed = await mintJoinUrl();
    accessJoinCode(malformed.joinUrl, { payload_json: payloadJson });
    const malformedResponse = await fetch(malformed.joinUrl);
    expect([malformedResponse.status, await malformedResponse.json()]).toEqual([
      404,
      opaqueNotFound,
    ]);
    expect(accessJoinCode(malformed.joinUrl)).toEqual([]);
  }

  const raced = await mintJoinUrl();
  await expectConcurrent(raced.joinUrl, [200, 404], {
    200: decodePairingSetupCode(raced.setupCode),
    404: opaqueNotFound,
  });

  const unknownUrl = `http://127.0.0.1:${harness.port}/j/${"z".repeat(22)}`;
  await expectConcurrent(unknownUrl, [404, 429, 429], {
    404: opaqueNotFound,
    429: { error: "rate_limited" },
  });

  // Rate limiting keeps precedence even if capturing storage fails.
  const blocked = await mintJoinUrl();
  const capture = vi
    .spyOn(workerContext, "captureOpenClawStateWorkerContext")
    .mockImplementation(() => {
      throw new Error("Synthetic storage failure");
    });
  onTestFinished(() => capture.mockRestore());
  const response = await fetch(blocked.joinUrl);
  expect([response.status, await response.text()]).toEqual([429, '{"error":"rate_limited"}']);
  expect(response.headers.get("cache-control")).toBe("no-store");
  capture.mockRestore();
  expect(accessJoinCode(blocked.joinUrl)).toEqual([
    { shortcode: shortcodeFromUrl(blocked.joinUrl) },
  ]);
});
