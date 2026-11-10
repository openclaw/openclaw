import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import { resolveNodePairingGeneration, type PairedDevice } from "./device-pairing.js";
import {
  ApnsRegistrationPairingChangedError,
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  registerApnsRegistration,
} from "./push-apns.js";
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
