// Real Gateway lifecycle proof for admin mint -> public single-use join exchange.
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { getPairedDevice } from "../infra/device-pairing.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
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

type JoinSetupResult = {
  setupCode: string;
  joinUrl: string;
};

let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let adminSocket: WebSocket;

beforeAll(async () => {
  testState.gatewayAuth = {
    mode: "token",
    token: "secret",
    rateLimit: {
      maxAttempts: 2,
      windowMs: 60_000,
      lockoutMs: 60_000,
    },
  };
  harness = await createGatewaySuiteHarness();
  adminSocket = await harness.openWs();
  const connected = await connectReq(adminSocket, {
    token: "secret",
    scopes: ["operator.admin"],
  });
  if (!connected.ok) {
    throw new Error(`admin test client failed to connect: ${JSON.stringify(connected.error)}`);
  }
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
      const setup = await mintJoinUrl();
      const response = await fetch(setup.joinUrl);
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual(decodePairingSetupCode(setup.setupCode));
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
    runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "device_pairing_join_codes">>(db)
          .updateTable("device_pairing_join_codes")
          .set({ shortcode: jPrefixedShortcode })
          .where("shortcode", "=", originalShortcode),
      );
    });
    const joinUrl = new URL(setup.joinUrl);
    joinUrl.pathname = joinUrl.pathname.replace(originalShortcode, jPrefixedShortcode);

    const response = await fetch(joinUrl);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(decodePairingSetupCode(setup.setupCode));
  });

  it("approves the joined node's initial surface but gates a later manifest escalation", async () => {
    const setup = await mintJoinUrl();
    const joined = await fetch(setup.joinUrl);
    expect(joined.status).toBe(200);
    const payload = (await readJson(joined)) as ReturnType<typeof decodePairingSetupCode>;
    const loaded = loadDeviceIdentity("join-code-node-surface");
    const client = {
      id: GATEWAY_CLIENT_NAMES.NODE_HOST,
      version: "1.0.0",
      platform: "macos",
      deviceFamily: "Mac",
      mode: GATEWAY_CLIENT_MODES.NODE,
    };

    const firstNode = await harness.openWs();
    const first = await connectReq(firstNode, {
      skipDefaultAuth: true,
      bootstrapToken: payload.bootstrapToken,
      role: "node",
      scopes: [],
      client,
      deviceIdentityPath: loaded.identityPath,
      commands: ["system.run"],
    });
    expect(first.ok).toBe(true);
    firstNode.close();

    const paired = await getPairedDevice(loaded.identity.deviceId);
    expect(paired).toMatchObject({
      approvedVia: "bootstrap",
      nodeSurface: { commands: ["system.run"] },
    });
    expect(paired?.pendingNodeSurface).toBeUndefined();

    const secondNode = await harness.openWs();
    const second = await connectReq(secondNode, {
      skipDefaultAuth: true,
      deviceToken: paired?.tokens?.node?.token,
      role: "node",
      scopes: [],
      client,
      deviceIdentityPath: loaded.identityPath,
      commands: ["system.run", "system.which"],
    });
    expect(second.ok).toBe(true);
    secondNode.close();

    const escalated = await getPairedDevice(loaded.identity.deviceId);
    expect(escalated?.nodeSurface?.commands).toEqual(["system.run"]);
    expect(escalated?.pendingNodeSurface?.commands).toEqual(["system.run", "system.which"]);
  });

  it("burns once and malformed payloads, expires opaquely, and serializes concurrent misses", async () => {
    const expired = await mintJoinUrl();
    const expiredShortcode = shortcodeFromUrl(expired.joinUrl);
    runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "device_pairing_join_codes">>(db)
          .updateTable("device_pairing_join_codes")
          .set({ expires_at_ms: 0 })
          .where("shortcode", "=", expiredShortcode),
      );
    });

    const expiredResponse = await fetch(expired.joinUrl);
    expect(expiredResponse.status).toBe(404);
    const opaqueNotFound = await readJson(expiredResponse);
    expect(opaqueNotFound).toEqual({ error: "not_found" });

    for (const payloadJson of ["{malformed", null]) {
      const live = await mintJoinUrl("/public-gateway");
      const shortcode = shortcodeFromUrl(live.joinUrl);
      expect(Buffer.from(shortcode, "base64url").byteLength).toBeGreaterThanOrEqual(16);

      const first = await fetch(live.joinUrl);
      expect(first.status).toBe(200);
      expect(first.headers.get("content-type")).toContain("application/json");
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(await readJson(first)).toEqual(decodePairingSetupCode(live.setupCode));

      const malformed = await mintJoinUrl();
      const malformedShortcode = shortcodeFromUrl(malformed.joinUrl);
      runOpenClawStateWriteTransaction(({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "device_pairing_join_codes">>(db)
            .updateTable("device_pairing_join_codes")
            .set({ payload_json: payloadJson })
            .where("shortcode", "=", malformedShortcode),
        );
      });
      const malformedResponse = await fetch(malformed.joinUrl);
      expect(malformedResponse.status).toBe(404);
      expect(await readJson(malformedResponse)).toEqual(opaqueNotFound);
      const malformedRows = runOpenClawStateWriteTransaction(({ db }) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "device_pairing_join_codes">>(db)
            .selectFrom("device_pairing_join_codes")
            .select("shortcode")
            .where("shortcode", "=", malformedShortcode),
        ),
      );
      expect(malformedRows.rows).toEqual([]);
    }

    const raced = await mintJoinUrl();
    const racedResponses = await Promise.all([fetch(raced.joinUrl), fetch(raced.joinUrl)]);
    expect(racedResponses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
      200, 404,
    ]);
    for (const response of racedResponses) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await readJson(response)).toEqual(
        response.status === 200 ? decodePairingSetupCode(raced.setupCode) : opaqueNotFound,
      );
    }

    const unknownUrl = `http://127.0.0.1:${harness.port}/j/${"z".repeat(22)}`;
    const misses = await Promise.all(Array.from({ length: 3 }, () => fetch(unknownUrl)));
    expect(misses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
      404, 429, 429,
    ]);
    for (const response of misses) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await readJson(response)).toEqual(
        response.status === 404 ? opaqueNotFound : { error: "rate_limited" },
      );
    }
  });
});
