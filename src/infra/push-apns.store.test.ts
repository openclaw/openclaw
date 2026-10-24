// Tests canonical shared-SQLite APNs registration persistence.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import { resolveNodePairingGeneration, type PairedDevice } from "./device-pairing.js";
import {
  ApnsRegistrationPairingChangedError,
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  loadApnsRegistrations,
  registerApnsRegistration,
} from "./push-apns.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";

const tempDirs = createTrackedTempDirs();
const APNS_DEVICE_FIELD = "token";
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
    [APNS_DEVICE_FIELD]: APNS_DEVICE_IDENTIFIER,
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

function databaseEnv(): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: baseDir };
}

afterEach(async () => {
  vi.useRealTimers();
  await closeStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("push APNs registration store", () => {
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

    const database = openOpenClawStateDatabase({ env: databaseEnv() });
    const row = database.db
      .prepare("SELECT * FROM apns_registrations WHERE node_id = ?")
      .get("ios-node-switch") as Record<string, unknown>;
    expect(row).toMatchObject({
      transport: "direct",
      [APNS_DEVICE_FIELD]: direct.token,
      relay_handle: null,
      send_grant: null,
      installation_id: null,
      relay_origin: null,
      distribution: null,
      token_debug_suffix: null,
    });
  });

  it("preserves request order, duplicates, and batches above the SQLite bind chunk", async () => {
    const env = databaseEnv();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        // Seed the lookup fixture directly; nullable relay columns default to NULL.
        const insert = db.prepare(`INSERT INTO apns_registrations
          (node_id, transport, token, topic, environment, updated_at_ms)
          VALUES (?, 'direct', ?, 'ai.openclaw.ios', 'sandbox', ?)`);
        for (let index = 0; index < 505; index += 1) {
          const suffix = index.toString().padStart(4, "0");
          insert.run(`node-${suffix}`, APNS_DEVICE_IDENTIFIER.toLowerCase(), index);
        }
      },
      { env },
    );
    const requested = [
      ...Array.from({ length: 505 }, (_, index) => `node-${index.toString().padStart(4, "0")}`),
      "node-0000",
      "missing",
    ];

    const loaded = await loadApnsRegistrations(requested, baseDir);
    expect(loaded.map(({ nodeId }) => nodeId)).toEqual(requested.slice(0, -1));
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
    const database = openOpenClawStateDatabase({ env: databaseEnv() });
    expect(
      database.db
        .prepare(
          "SELECT node_id, deleted_at_ms FROM apns_registration_tombstones WHERE node_id = ?",
        )
        .get("ios-node-1"),
    ).toEqual({ node_id: "ios-node-1", deleted_at_ms: fresh.updatedAtMs + 1 });

    const replacement = await registerDirect();
    expect(replacement.updatedAtMs).toBe(fresh.updatedAtMs + 2);
    expect(
      database.db
        .prepare("SELECT node_id FROM apns_registration_tombstones WHERE node_id = ?")
        .get("ios-node-1"),
    ).toBeUndefined();
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
          registerApnsRegistration({
            nodeId: "ios-lease",
            token: "DCBA4321DCBA4321DCBA4321DCBA4321",
            topic: "ai.openclaw.ios",
            baseDir,
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

    await expect(registerDirect({ [APNS_DEVICE_FIELD]: "not-a-token" })).rejects.toThrow(
      "invalid APNs token",
    );
    await expect(registerDirect({ nodeId: "n".repeat(257) })).rejects.toThrow("nodeId required");
    await expect(registerDirect({ topic: "a".repeat(256) })).rejects.toThrow("topic required");
    await expect(registerRelay({ environment: "staging" })).rejects.toThrow(
      "relay registrations must use valid APNs environment",
    );
    await expect(registerRelay({ relayHandle: oversized })).rejects.toThrow("relayHandle too long");
  });

  it("fails loudly for a malformed canonical row", async () => {
    const env = databaseEnv();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        db.prepare(
          `INSERT INTO apns_registrations (
             node_id, transport, topic, environment, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run("corrupt-node", "unknown", "ai.openclaw.ios", "sandbox", 1);
      },
      { env },
    );

    await expect(load("corrupt-node")).rejects.toThrow("invalid APNs registration row");
  });
});
