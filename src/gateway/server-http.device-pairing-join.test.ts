import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { getPairedDevice } from "../infra/device-pairing.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { decodePairingSetupCode } from "../pairing/setup-code.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { loadDeviceIdentity } from "./device-authz.test-helpers.js";
import {
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type JoinSetupResult = { setupCode: string; joinUrl: string };

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
  const connected = await connectReq(adminSocket, {
    token: "secret",
    scopes: ["operator.admin"],
  });
  expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
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

function shortcodeFromUrl(joinUrl: string): string {
  return new URL(joinUrl).pathname.split("/").at(-1) ?? "";
}

async function readJson(response: Response): Promise<unknown> {
  return JSON.parse(await response.text()) as unknown;
}

function joinCodes(db: EngineConnection) {
  return getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "device_pairing_join_codes">>(db);
}

function updateJoinCode(
  joinUrl: string,
  values: { shortcode?: string; expires_at_ms?: number; payload_json?: string | null },
) {
  runOpenClawStateWriteTransaction(({ db }) =>
    executeSqliteQuerySync(
      db,
      joinCodes(db)
        .updateTable("device_pairing_join_codes")
        .set(values)
        .where("shortcode", "=", shortcodeFromUrl(joinUrl)),
    ),
  );
}

async function expectJoined({ joinUrl, setupCode }: JoinSetupResult) {
  const response = await fetch(joinUrl);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const payload = (await readJson(response)) as ReturnType<typeof decodePairingSetupCode>;
  expect(payload).toEqual(decodePairingSetupCode(setupCode));
  return payload;
}

async function expectConcurrent(url: string, statuses: number[], bodies: Record<number, unknown>) {
  const responses = await Promise.all(statuses.map(() => fetch(url)));
  expect(responses.map(({ status }) => status).toSorted((a, b) => a - b)).toEqual(statuses);
  for (const response of responses) {
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await readJson(response)).toEqual(bodies[response.status]);
  }
}

describe("Gateway device join route", () => {
  it("keeps the code-less /j route claimed by the join handler", async () => {
    // One miss only: a second recorded failure would trip the suite's
    // maxAttempts=2 limiter before the next test's successful reset.
    const response = await fetch(`http://127.0.0.1:${harness.port}/j`);
    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "not_found" });
  });

  it("mints by RPC and redeems by HTTP without caller-thread join-code SQL", async () => {
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    try {
      await expectJoined(await mintJoinUrl());
      const joinCodeSql = [...prepare.mock.calls, ...exec.mock.calls].filter(([sql]) =>
        /\bdevice_pairing_join_codes\b/u.test(sql),
      );
      expect(joinCodeSql).toEqual([]);
    } finally {
      prepare.mockRestore();
      exec.mockRestore();
    }
  });

  it("routes advertised context paths when the shortcode begins with j", async () => {
    const setup = await mintJoinUrl("/public-gateway");
    const originalShortcode = shortcodeFromUrl(setup.joinUrl);
    const jPrefixedShortcode = `j${"a".repeat(21)}`;
    updateJoinCode(setup.joinUrl, { shortcode: jPrefixedShortcode });
    const joinUrl = new URL(setup.joinUrl);
    joinUrl.pathname = joinUrl.pathname.replace(originalShortcode, jPrefixedShortcode);

    await expectJoined({ ...setup, joinUrl: joinUrl.href });
  });

  it("approves the joined node's initial surface but gates a later manifest escalation", async () => {
    const payload = await expectJoined(await mintJoinUrl());
    const loaded = loadDeviceIdentity("join-code-node-surface");
    const client = {
      id: GATEWAY_CLIENT_NAMES.NODE_HOST,
      version: "1.0.0",
      platform: "macos",
      deviceFamily: "Mac",
      mode: GATEWAY_CLIENT_MODES.NODE,
    };
    const connectNode = async (
      auth: { bootstrapToken?: string; deviceToken?: string },
      commands: string[],
    ) => {
      const socket = await harness.openWs();
      const result = await connectReq(socket, {
        skipDefaultAuth: true,
        role: "node",
        scopes: [],
        client,
        deviceIdentityPath: loaded.identityPath,
        ...auth,
        commands,
      });
      expect(result.ok).toBe(true);
      socket.close();
    };
    await connectNode({ bootstrapToken: payload.bootstrapToken }, ["system.run"]);

    const paired = await getPairedDevice(loaded.identity.deviceId);
    expect(paired).toMatchObject({
      approvedVia: "bootstrap",
      nodeSurface: { commands: ["system.run"] },
    });
    expect(paired?.pendingNodeSurface).toBeUndefined();

    await connectNode({ deviceToken: paired?.tokens?.node?.token }, ["system.run", "system.which"]);

    const escalated = await getPairedDevice(loaded.identity.deviceId);
    expect(escalated?.nodeSurface?.commands).toEqual(["system.run"]);
    expect(escalated?.pendingNodeSurface?.commands).toEqual(["system.run", "system.which"]);
  });

  it("burns once and malformed payloads, expires opaquely, and serializes concurrent misses", async () => {
    const expired = await mintJoinUrl();
    updateJoinCode(expired.joinUrl, { expires_at_ms: 0 });

    const expiredResponse = await fetch(expired.joinUrl);
    expect(expiredResponse.status).toBe(404);
    const opaqueNotFound = await readJson(expiredResponse);
    expect(opaqueNotFound).toEqual({ error: "not_found" });

    for (const payloadJson of ["{malformed", null]) {
      const live = await mintJoinUrl("/public-gateway");
      const shortcode = shortcodeFromUrl(live.joinUrl);
      expect(Buffer.from(shortcode, "base64url").byteLength).toBeGreaterThanOrEqual(16);

      await expectJoined(live);

      const malformed = await mintJoinUrl();
      const malformedShortcode = shortcodeFromUrl(malformed.joinUrl);
      updateJoinCode(malformed.joinUrl, { payload_json: payloadJson });
      const malformedResponse = await fetch(malformed.joinUrl);
      expect(malformedResponse.status).toBe(404);
      expect(await readJson(malformedResponse)).toEqual(opaqueNotFound);
      const malformedRows = runOpenClawStateWriteTransaction(({ db }) =>
        executeSqliteQuerySync(
          db,
          joinCodes(db)
            .selectFrom("device_pairing_join_codes")
            .select("shortcode")
            .where("shortcode", "=", malformedShortcode),
        ),
      );
      expect(malformedRows.rows).toEqual([]);
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
  });
});
