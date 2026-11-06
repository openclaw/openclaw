import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withLoopbackTestServer } from "../commands/loopback-server.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import * as identityRuntime from "./device-identity-async.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import { resolveNodePairingGeneration, type PairedDevice } from "./device-pairing.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  ApnsRegistrationPairingChangedError,
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  registerApnsRegistration,
  sendApnsAlert,
} from "./push-apns.js";
import { mockApnsRelayIdentity } from "./push-apns.relay.test-support.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";

const tempDirs = createTrackedTempDirs();
const APNS_DEVICE_IDENTIFIER = "ABCD1234ABCD1234ABCD1234ABCD1234";
const relayParams = {
  nodeId: "ios-node-relay",
  transport: "relay" as const,
  relayHandle: "relay-handle-123",
  sendGrant: "send-grant-123",
  installationId: "install-123",
  topic: "ai.openclaw.ios",
  environment: "production",
  distribution: "official",
};

let baseDir: string;
beforeEach(async () => {
  baseDir = await tempDirs.make("openclaw-push-apns-store-test-");
});

function pairDevice(nodeId: string, generation: "a" | "b") {
  const next = generation === "b" ? 1 : 0;
  const device: PairedDevice = {
    deviceId: nodeId,
    publicKey: `public-key-generation-${generation}`,
    role: "node",
    roles: ["node"],
    tokens: {
      node: {
        token: `node-token-generation-${generation}`,
        role: "node",
        scopes: [],
        createdAtMs: 100 + next,
      },
    },
    nodeSurface: { createdAtMs: 200, approvedAtMs: 300 + next },
    createdAtMs: 50,
    approvedAtMs: 300,
  };
  persistDevicePairingStoreState(
    { pendingById: {}, pairedByDeviceId: { [nodeId]: device } },
    baseDir,
    "paired",
  );
  const pairing = resolveNodePairingGeneration(device);
  if (!pairing) {
    throw new Error("expected node pairing generation");
  }
  return pairing.key;
}

function clearRegistration(registration: Awaited<ReturnType<typeof registerApnsRegistration>>) {
  return clearApnsRegistrationIfCurrent({ nodeId: registration.nodeId, registration, baseDir });
}

type DirectParams = Extract<Parameters<typeof registerApnsRegistration>[0], { token: string }>;
async function registerDirect(params: Partial<DirectParams> = {}) {
  return await registerApnsRegistration({
    nodeId: "ios-node-1",
    baseDir,
    token: APNS_DEVICE_IDENTIFIER,
    topic: "ai.openclaw.ios",
    ...params,
    transport: "direct",
  });
}

function load(nodeId = "ios-node-1") {
  return loadApnsRegistration(nodeId, baseDir);
}

function registerRelay(
  overrides: Partial<
    Extract<Parameters<typeof registerApnsRegistration>[0], { transport: "relay" }>
  > = {},
) {
  return registerApnsRegistration({ ...relayParams, baseDir, ...overrides });
}

function databaseEnv() {
  return { ...process.env, OPENCLAW_STATE_DIR: baseDir };
}

function queryRegistration(table: string, nodeId = "ios-node-1") {
  return openOpenClawStateDatabase({ env: databaseEnv() })
    .db.prepare(`SELECT * FROM ${table} WHERE node_id = ?`)
    .get(nodeId);
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await closeStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("push APNs registration store", () => {
  it("upgrades an older registration without replacing credentials or assuming delivery health", async () => {
    const original = await registerRelay();
    const databasePath = openOpenClawStateDatabase({ env: databaseEnv() }).path;
    await closeStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const older = new DatabaseSync(databasePath);
    try {
      older.exec("ALTER TABLE apns_registrations DROP COLUMN relay_rejection_reason");
    } finally {
      older.close();
    }
    // Upgrade admission starts from an unseen physical store, not an external mutation
    // of a database whose schema this process already admitted.
    baseDir = await tempDirs.make("openclaw-push-apns-upgrade-copy-");
    const copiedDatabasePath = path.join(baseDir, "state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(copiedDatabasePath), { recursive: true });
    await fs.copyFile(databasePath, copiedDatabasePath);
    const { updatedAtMs: _version, ...credentials } = original;
    await expect(registerRelay()).resolves.toMatchObject(credentials);
    expect(queryRegistration("apns_registrations", original.nodeId)).toMatchObject({
      relay_rejection_reason: null,
    });
  });

  it("retains relay rejection across real HTTP, reconnect and restart without poisoning a replacement or peer", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", baseDir);
    const peer = await registerRelay({ nodeId: "healthy-peer", relayHandle: "peer-handle" });
    const direct = await registerDirect();
    const rejected = await registerRelay();
    if (rejected.transport !== "relay") {
      throw new Error("expected relay registration");
    }
    const identity = mockApnsRelayIdentity();
    const requests: Array<{ body: unknown; grant: string | undefined }> = [];
    let responseStatus = 410;
    let holdRequest = false;
    const entered = createDeferred();
    const release = createDeferred();
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push({ body, grant: request.headers.authorization });
        if (holdRequest) {
          holdRequest = false;
          entered.resolve();
          await release.promise;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: responseStatus === 200,
            status: responseStatus,
            ...(responseStatus === 410 ? { reason: "Unregistered" } : {}),
            environment: "production",
          }),
        );
      })().catch(() => {
        response.writeHead(500);
        response.end("Fixture request failed");
      });
    });
    await withLoopbackTestServer(server, async (port) => {
      const relayConfig = { baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2500 };
      const push = () =>
        sendApnsAlert({
          nodeId: rejected.nodeId,
          registration: rejected,
          relayConfig,
          title: "Synthetic recovery test",
          body: "Only the fixture device",
        });
      await expect(push()).resolves.toMatchObject({
        ok: false,
        status: 410,
        reason: "Unregistered",
      });
      expect(requests).toEqual([
        {
          body: expect.objectContaining({ relayHandle: "relay-handle-123" }),
          grant: "Bearer send-grant-123",
        },
      ]);
      await closeStateDatabaseForTest();
      const replay = await registerRelay();
      expect(replay).toMatchObject({ relayRejection: { status: 410, reason: "Unregistered" } });
      if (replay.transport !== "relay") {
        throw new Error("expected relay registration");
      }
      await expect(
        sendApnsAlert({
          nodeId: replay.nodeId,
          registration: replay,
          relayConfig,
          title: "Synthetic",
          body: "Known rejection",
        }),
      ).resolves.toMatchObject({ ok: false, status: 410, reason: "Unregistered" });
      expect(requests).toHaveLength(1);
      await expect(load("healthy-peer")).resolves.toEqual(peer);
      await expect(load()).resolves.toEqual(direct);

      holdRequest = true;
      const late = push();
      void late.catch(() => {});
      await entered.promise;
      const replacement = await registerRelay({
        relayHandle: "renewed-handle",
        sendGrant: "renewed-grant",
      });
      release.resolve();
      await late;
      await expect(load(rejected.nodeId)).resolves.toEqual(replacement);
      expect(replacement).not.toHaveProperty("relayRejection");
      if (replacement.transport !== "relay") {
        throw new Error("expected relay registration");
      }
      responseStatus = 200;
      await expect(
        sendApnsAlert({
          nodeId: replacement.nodeId,
          registration: replacement,
          relayConfig,
          title: "Synthetic recovery test",
          body: "Only the fixture device",
        }),
      ).resolves.toMatchObject({ ok: true, status: 200 });
      expect(requests).toHaveLength(3);
      expect(requests[2]).toMatchObject({
        body: { relayHandle: "renewed-handle" },
        grant: "Bearer renewed-grant",
      });

      const identityEntered = createDeferred();
      const identityRelease = createDeferred();
      vi.spyOn(identityRuntime, "loadOrCreateProcessDeviceIdentityAsync").mockImplementationOnce(
        async () => {
          identityEntered.resolve();
          await identityRelease.promise;
          return identity;
        },
      );
      const authority = new AbortController();
      const revoked = sendApnsAlert({
        nodeId: replacement.nodeId,
        registration: replacement,
        relayConfig,
        title: "Synthetic",
        body: "Must not be sent",
        signal: authority.signal,
      });
      void revoked.catch(() => {});
      await identityEntered.promise;
      const reason = new Error("Recovery authority revoked");
      authority.abort(reason);
      identityRelease.resolve();
      await expect(revoked).rejects.toBe(reason);
      expect(requests).toHaveLength(3);
      await expect(load(rejected.nodeId)).resolves.toEqual(replacement);
    });
  });

  it("round-trips direct and sandbox relay fields including relay origin", async () => {
    const relay = await registerRelay({
      environment: "sandbox",
      relayOrigin: "https://ios-push-relay-sandbox.openclaw.ai/",
      tokenDebugSuffix: " abcd-1234 ",
    });

    await expect(load("ios-node-relay")).resolves.toEqual({
      ...relay,
      relayOrigin: "https://ios-push-relay-sandbox.openclaw.ai",
      tokenDebugSuffix: "abcd1234",
    });
  });

  it("clears transport-specific columns when a node changes registration transport", async () => {
    await registerDirect({ nodeId: "ios-node-switch" });
    await registerRelay({ nodeId: "ios-node-switch" });
    const direct = await registerDirect({ nodeId: "ios-node-switch", environment: "production" });
    if (direct.transport !== "direct") {
      throw new Error("expected direct APNs registration");
    }

    expect(queryRegistration("apns_registrations", "ios-node-switch")).toMatchObject({
      transport: "direct",
      token: direct.token,
      relay_handle: null,
      send_grant: null,
      installation_id: null,
      relay_origin: null,
      distribution: null,
      token_debug_suffix: null,
    });
  });

  it("uses monotonic versions so stale compare-and-delete cannot remove a replacement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T00:00:00Z"));
    const stale = await registerDirect();
    const fresh = await registerDirect();
    await expect(
      fs.access(path.join(baseDir, "push", "apns-registrations.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(fresh.updatedAtMs).toBe(stale.updatedAtMs + 1);
    await expect(clearRegistration(stale)).resolves.toBe(false);
    await expect(load()).resolves.toEqual(fresh);
    await expect(clearRegistration(fresh)).resolves.toBe(true);
    expect(queryRegistration("apns_registration_tombstones")).toMatchObject({
      node_id: "ios-node-1",
      deleted_at_ms: fresh.updatedAtMs + 1,
    });

    const replacement = await registerDirect();
    expect(replacement.updatedAtMs).toBe(fresh.updatedAtMs + 2);
    expect(queryRegistration("apns_registration_tombstones")).toBeUndefined();
    await expect(clearRegistration(fresh)).resolves.toBe(false);
    await expect(load()).resolves.toEqual(replacement);
  });

  it("rejects a stale registration after the expected pairing generation is removed", async () => {
    const nodeId = "ios-node-generation-guard";
    const generation = pairDevice(nodeId, "a");

    await registerDirect({ nodeId, expectedPairingGeneration: generation });
    persistDevicePairingStoreState({ pendingById: {}, pairedByDeviceId: {} }, baseDir, "paired", {
      clearApnsNodeIds: [nodeId],
    });
    await expect(load(nodeId)).resolves.toBeNull();

    const replacementGeneration = pairDevice(nodeId, "b");
    const replacement = await registerDirect({
      nodeId,
      token: "DCBA4321DCBA4321DCBA4321DCBA4321",
      expectedPairingGeneration: replacementGeneration,
    });
    await expect(load(nodeId)).resolves.toEqual(replacement);

    await expect(
      registerDirect({
        nodeId,
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        expectedPairingGeneration: generation,
      }),
    ).rejects.toBeInstanceOf(ApnsRegistrationPairingChangedError);
    await expect(load(nodeId)).resolves.toEqual(replacement);
  });

  it.each(["transaction", "commit"] as const)(
    "keeps the prior APNs owner when the connection changes before worker %s admission",
    async (stage) => {
      const previous = await registerDirect({ nodeId: "ios-lease" });
      let connectionCurrent = true;
      let reachedStage = false;
      const admission = probe.admission(workerAdmission, (request, grant, admit) => {
        if (request.stage === stage) {
          reachedStage = true;
          connectionCurrent = false;
        }
        admit(request, grant);
      });
      try {
        await expect(
          registerDirect({
            nodeId: "ios-lease",
            token: "DCBA4321DCBA4321DCBA4321DCBA4321",
            assertCurrent: () => {
              if (!connectionCurrent) {
                throw new ApnsRegistrationPairingChangedError();
              }
            },
          }),
        ).rejects.toBeInstanceOf(ApnsRegistrationPairingChangedError);
        expect(reachedStage).toBe(true);
        await expect(load("ios-lease")).resolves.toEqual(previous);
      } finally {
        admission.mockRestore();
      }
    },
  );

  it("rejects invalid direct and relay inputs", async () => {
    const oversized = "x".repeat(257);

    await expect(registerDirect({ token: "not-a-token" })).rejects.toThrow("invalid APNs token");
    await expect(registerDirect({ nodeId: "n".repeat(257) })).rejects.toThrow("nodeId required");
    await expect(registerDirect({ topic: "a".repeat(256) })).rejects.toThrow("topic required");
    await expect(registerRelay({ environment: "staging" })).rejects.toThrow(
      "relay registrations must use valid APNs environment",
    );
    await expect(registerRelay({ relayHandle: oversized })).rejects.toThrow("relayHandle too long");
  });
});
