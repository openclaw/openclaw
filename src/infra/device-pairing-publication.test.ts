import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  issueDeviceBootstrapToken,
  pruneExpiredDevicePairSetupCompletions,
} from "./device-bootstrap.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import { updatePairedNodeBins, updatePairedNodeSessionHost } from "./device-pairing-node-facts.js";
import {
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
} from "./device-pairing-node-state.js";
import { recordPairedNodeHostStats, renamePairedNode } from "./device-pairing-node.js";
import { getPublishedPairedDeviceBinding } from "./device-pairing-publication.js";
import { readDevicePairingNodeSnapshot } from "./device-pairing-store-readonly.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import { revokeDeviceToken } from "./device-pairing-tokens.js";
import {
  executeDevicePairingMutation,
  withCurrentDevicePairingSnapshot,
} from "./device-pairing-worker.js";
import {
  getPairedDevice,
  getPendingDevicePairing,
  listDevicePairing,
  listDevicePairingReadOnly,
  removePairedDevice,
} from "./device-pairing.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";

let baseDir: string;
let database: ReturnType<typeof openOpenClawStateDatabase>;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseByPathAsync(database.path);
    cleanup();
  }),
);

beforeAll(() => {
  baseDir = tempDirs.make("pairing-publication-");
  database = openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } });
});

beforeEach(() => {
  persistDevicePairingStoreState(
    {
      pendingById: {},
      pairedByDeviceId: {
        node: {
          deviceId: "node",
          publicKey: "synthetic-node-key",
          roles: ["node"],
          tokens: {
            node: { token: "synthetic-node-token", role: "node", scopes: [], createdAtMs: 1 },
          },
          nodeSurface: { createdAtMs: 1, approvedAtMs: 1 },
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      },
    },
    baseDir,
    "both",
  );
});

test("keeps committed node bindings across bootstrap writes and caller-owned row edits", async () => {
  const snapshot = await readDevicePairingNodeSnapshot(baseDir);
  const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  try {
    expect(await readDevicePairingNodeSnapshot(baseDir)).toBe(snapshot);
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.paired)).toBe(true);
  expect(Object.isFrozen(snapshot.paired[0]!.tokens!.node)).toBe(true);
  const binding = getPublishedPairedDeviceBinding("node", baseDir);
  expect(binding).not.toBeNull();
  expect(snapshot.bindings.get("node")).toEqual(binding);
  await issueDeviceBootstrapToken({ baseDir });
  expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
  expect(await readDevicePairingNodeSnapshot(baseDir)).toBe(snapshot);
  const device = await getPairedDevice("node", baseDir);
  device!.tokens!.node!.revokedAtMs = 100;
  const list = await listDevicePairing(baseDir);
  list.paired[0]!.nodeSurface!.displayName = "caller-edit";
  expect(await readDevicePairingNodeSnapshot(baseDir)).toBe(snapshot);
  expect(snapshot.paired[0]!.tokens!.node!.revokedAtMs).toBeUndefined();
  expect(snapshot.paired[0]!.nodeSurface!.displayName).toBeUndefined();
  expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
  const copy = getPublishedPairedDeviceBinding("node", baseDir)!;
  copy.identity = "caller-edit";
  expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
});

test("keeps node authority available while retained setup cleanup is pending", async () => {
  const snapshot = await readDevicePairingNodeSnapshot(baseDir);
  const binding = getPublishedPairedDeviceBinding("node", baseDir);
  expect(binding).not.toBeNull();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const run = stateWorker.runOpenClawStateWorkerOperation;
  const writer = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return run(...args);
    });
  const pruning = pruneExpiredDevicePairSetupCompletions({ baseDir });
  try {
    await awaitGateBeforeSettlement(entered.promise, pruning, "setup cleanup was not held");
    expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
    release.resolve();
    await expect(pruning).resolves.toBe(0);
    expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
    expect(await readDevicePairingNodeSnapshot(baseDir)).toBe(snapshot);
  } finally {
    release.resolve();
    await Promise.allSettled([pruning]);
    writer.mockRestore();
  }
});

test.each([0, 1])(
  "settles setup cleanup after late revocation according to removed rows (%s)",
  async (removed) => {
    database.db.prepare("DELETE FROM device_pair_setup_completions").run();
    if (removed > 0) {
      database.db
        .prepare(
          "INSERT INTO device_pair_setup_completions (setup_id, device_id, access, completed_at_ms, delivery_state, retain_until_ms) VALUES ('expired', 'node', 'node', 1, 'confirmed', 1000)",
        )
        .run();
    }
    let current = true;
    const revoked = new Error("setup cleanup owner revoked after native result");
    const delivery = probe.command(
      stateWorker,
      async (command, executeOptions, scope) => {
        const result = await scope.execute(command, executeOptions);
        current = false;
        return result;
      },
      { once: true },
    );
    try {
      const pruning = executeDevicePairingMutation(
        { type: "bootstrap.prune", input: { nowMs: 1_000 } },
        {
          baseDir,
          assertCurrent: () => {
            if (!current) {
              throw revoked;
            }
          },
        },
      );
      if (removed === 0) {
        await expect(pruning).rejects.toBe(revoked);
      } else {
        await expect(pruning).resolves.toBe(removed);
      }
      expect(
        database.db.prepare("SELECT setup_id FROM device_pair_setup_completions").all(),
      ).toEqual([]);
    } finally {
      delivery.mockRestore();
    }
  },
);

test.each([
  "session-host consent",
  "host stats",
  "skill bins",
  "rename",
  "token revocation",
  "metadata after a failed read",
] as const)("retains only usable node authority during %s", async (change) => {
  const snapshot = await readDevicePairingNodeSnapshot(baseDir);
  const generation = await withEnvAsync({ OPENCLAW_STATE_DIR: baseDir }, () =>
    captureNodePairingGeneration("node"),
  );
  if (!generation) {
    throw new Error("expected paired node generation");
  }
  const binding = getPublishedPairedDeviceBinding("node", baseDir);
  if (change === "metadata after a failed read") {
    const read = vi
      .spyOn(stateReads, "executeExistingOpenClawStateRead")
      .mockRejectedValueOnce(new Error("pairing read unavailable"));
    try {
      await expect(getPairedDevice("node", baseDir)).rejects.toThrow("pairing read unavailable");
    } finally {
      read.mockRestore();
    }
  }
  const mutationQueued = createDeferredCore();
  const releaseMutation = createDeferredCore();
  const originalMutation = stateWorker.runOpenClawStateWorkerOperation;
  const writer = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementationOnce(async (...args) => {
      mutationQueued.resolve();
      await releaseMutation.promise;
      return originalMutation(...args);
    });
  const mutate = () => {
    switch (change) {
      case "rename":
        return renamePairedNode("node", "Renamed node", baseDir);
      case "host stats":
        return recordPairedNodeHostStats({
          nodeId: "node",
          hostStats: {
            cpuCount: 2,
            memoryTotalBytes: 8_192,
            memoryFreeBytes: 4_096,
            updatedAtMs: 2,
          },
          expectedPairingGeneration: generation,
          baseDir,
        });
      case "skill bins":
        return updatePairedNodeBins("node", ["git"], generation, baseDir);
      case "token revocation":
        return revokeDeviceToken({ deviceId: "node", role: "node", baseDir });
      default:
        return updatePairedNodeSessionHost({
          nodeId: "node",
          sessionHost: true,
          expectedPairingGeneration: generation,
          isConnectionCurrent: () => true,
          baseDir,
        });
    }
  };
  const mutation = mutate();
  try {
    await awaitGateBeforeSettlement(
      mutationQueued.promise,
      mutation,
      "pairing mutation settled before worker dispatch",
    );
    if (
      change === "token revocation" ||
      change === "rename" ||
      change === "metadata after a failed read"
    ) {
      expect(() => getPublishedPairedDeviceBinding("node", baseDir)).toThrow(
        "Device pairing authority requires a current worker publication",
      );
    } else {
      expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
    }
    releaseMutation.resolve();
    expect(await mutation).toEqual(
      change === "token revocation"
        ? expect.objectContaining({ ok: true })
        : change === "rename"
          ? expect.objectContaining({ displayName: "Renamed node" })
          : true,
    );
    expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(
      change === "token revocation" ? null : binding,
    );
    const updated = await readDevicePairingNodeSnapshot(baseDir);
    expect(updated).not.toBe(snapshot);
    expect(await readDevicePairingNodeSnapshot(baseDir)).toBe(updated);
    expect(updated.bindings.get("node") ?? null).toEqual(
      change === "token revocation" ? null : binding,
    );
    switch (change) {
      case "host stats":
        expect(updated.paired[0]!.nodeSurface!.lastHostStats).toMatchObject({
          cpuCount: 2,
          updatedAtMs: 2,
        });
        break;
      case "skill bins":
        expect(updated.paired[0]!.nodeSurface!.bins).toEqual(["git"]);
        break;
      case "rename":
        expect(updated.paired[0]!.nodeSurface!.displayName).toBe("Renamed node");
        break;
      case "token revocation":
        expect(updated.paired[0]!.tokens!.node!.revokedAtMs).toEqual(expect.any(Number));
        break;
      default:
        expect(updated.paired[0]!.nodeSurface!.sessionHost).toBe(true);
    }
  } finally {
    releaseMutation.resolve();
    await Promise.allSettled([mutation]);
    writer.mockRestore();
  }
});

test.each(["lookup", "pending read", "token revocation"] as const)(
  "keeps unrelated node authority when a %s publishes a revision the cache missed",
  async (source) => {
    const node = await getPairedDevice("node", baseDir);
    if (!node) {
      throw new Error("expected paired node");
    }
    const other = {
      ...structuredClone(node),
      deviceId: "other",
      publicKey: "synthetic-other-key",
      tokens: {
        node: { token: "synthetic-other-token", role: "node", scopes: [], createdAtMs: 1 },
      },
    };
    persistDevicePairingStoreState(
      { pendingById: {}, pairedByDeviceId: { node, other } },
      baseDir,
      "paired",
    );
    await readDevicePairingNodeSnapshot(baseDir);
    const binding = getPublishedPairedDeviceBinding("node", baseDir);
    expect(binding).not.toBeNull();
    // Boot and Doctor migrations commit without a worker receipt.
    persistDevicePairingStoreState(
      { pendingById: {}, pairedByDeviceId: { node, other: { ...other, lastSeenAtMs: 2 } } },
      baseDir,
      "paired",
    );
    if (source === "lookup") {
      await getPairedDevice("other", baseDir);
    } else if (source === "pending read") {
      await getPendingDevicePairing("synthetic-missing-request", baseDir);
    } else {
      await revokeDeviceToken({ deviceId: "other", role: "node", baseDir });
      expect(getPublishedPairedDeviceBinding("other", baseDir)).toBeNull();
    }
    expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
  },
);

test.each([
  { change: "unrelated operator approval", remainsCurrent: true },
  { change: "node surface reapproval", remainsCurrent: false },
  { change: "node token replacement", remainsCurrent: false },
  { change: "node token revocation", remainsCurrent: false },
] as const)("refreshes node work authority after $change", async ({ change, remainsCurrent }) => {
  await withEnvAsync({ OPENCLAW_STATE_DIR: baseDir }, async () => {
    const generation = await captureNodePairingGeneration("node");
    expect(generation).not.toBeNull();
    await expect(isNodePairingGenerationCurrent(generation!)).resolves.toBe(true);
    const device = await getPairedDevice("node");
    expect(device).not.toBeNull();
    switch (change) {
      case "unrelated operator approval":
        device!.approvedAtMs = 2;
        device!.roles = ["node", "operator"];
        device!.tokens!.operator = {
          token: "synthetic-operator-token",
          role: "operator",
          scopes: ["operator.pairing"],
          createdAtMs: 2,
        };
        break;
      case "node surface reapproval":
        device!.nodeSurface!.approvedAtMs = 2;
        break;
      case "node token replacement":
        device!.tokens!.node!.token = "synthetic-replacement-token";
        device!.tokens!.node!.rotatedAtMs = 2;
        break;
      case "node token revocation":
        device!.tokens!.node!.revokedAtMs = 2;
        break;
    }
    persistDevicePairingStoreState(
      { pendingById: {}, pairedByDeviceId: { node: device! } },
      baseDir,
      "paired",
    );
    await expect(isNodePairingGenerationCurrent(generation!)).resolves.toBe(remainsCurrent);
  });
});

test("keeps inspection snapshot bytes without republishing revoked node authority", async () => {
  const nodes = await readDevicePairingNodeSnapshot(baseDir);
  await withOpenClawStateDatabaseReadSnapshot(
    async () => {
      const historical = JSON.stringify(await listDevicePairingReadOnly(baseDir));
      await removePairedDevice("node", baseDir);
      expect(getPublishedPairedDeviceBinding("node", baseDir)).toBeNull();
      expect(JSON.stringify(await listDevicePairingReadOnly(baseDir))).toBe(historical);
      const currentNodes = await readDevicePairingNodeSnapshot(baseDir);
      expect(currentNodes).not.toBe(nodes);
      expect(currentNodes.paired).toEqual([]);
      expect(currentNodes.bindings.size).toBe(0);
      expect(getPublishedPairedDeviceBinding("node", baseDir)).toBeNull();
      expect(await getPairedDevice("node", baseDir)).toBeNull();
      expect((await listDevicePairing(baseDir)).paired).toEqual([]);
      expect(
        await withCurrentDevicePairingSnapshot(baseDir, (paired) => ({
          start: () => paired.length,
        })),
      ).toBe(0);
    },
    { path: database.path, env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } },
  );
});

test("retains pairing admission through final publication preparation and synchronous start", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const order: string[] = [];
  const delivery = withCurrentDevicePairingSnapshot(
    baseDir,
    (paired) => ({
      start: () => {
        expect(paired.map((device) => device.deviceId)).toEqual(["node"]);
        order.push("send");
      },
    }),
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  await awaitGateBeforeSettlement(entered.promise, delivery, "Final preparation did not start");
  const revocation = removePairedDevice("node", baseDir).then(() => {
    order.push("revoked");
  });
  try {
    expect(order).toEqual([]);
  } finally {
    release.resolve();
    await Promise.all([delivery, revocation]);
  }
  expect(order).toEqual(["send", "revoked"]);
  expect(getPublishedPairedDeviceBinding("node", baseDir)).toBeNull();
});

test.each(["worker commit", "sibling owner commit"] as const)(
  "does not restore revoked node authority from a read delayed past a newer %s",
  async (commit) => {
    await listDevicePairing(baseDir);
    expect(getPublishedPairedDeviceBinding("node", baseDir)).not.toBeNull();
    const releaseRead = createDeferredCore();
    const releaseMutation = createDeferredCore();
    const mutationQueued = createDeferredCore();
    const originalRead = stateReads.executeExistingOpenClawStateRead;
    const readProduced = createDeferredCore<Awaited<ReturnType<typeof originalRead>>>();
    const originalMutation = stateWorker.runOpenClawStateWorkerOperation;
    const read = vi
      .spyOn(stateReads, "executeExistingOpenClawStateRead")
      .mockImplementationOnce(async (...args) => {
        try {
          const reply = await originalRead(...args);
          readProduced.resolve(reply);
          await releaseRead.promise;
          return reply;
        } catch (error) {
          readProduced.reject(error);
          throw error;
        }
      });
    const writer = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementationOnce(async (...args) => {
        mutationQueued.resolve();
        await releaseMutation.promise;
        return originalMutation(...args);
      });
    try {
      await withDevicePairingLock(async () => {
        const mutation =
          commit === "worker commit" ? removePairedDevice("node", baseDir) : undefined;
        if (mutation) {
          await Promise.race([mutationQueued.promise, mutation]);
        }
        const delayed = getPairedDevice("node", baseDir).then(
          (device) => ({ device }),
          (error: unknown) => ({ error }),
        );
        try {
          expect(await readProduced.promise).toMatchObject({
            type: "devicePairing.lookup",
            device: { deviceId: "node", publicKey: "synthetic-node-key" },
          });
          if (mutation) {
            releaseMutation.resolve();
            await mutation;
          } else {
            const other = openNodeSqliteDatabase(database.path);
            try {
              other.prepare("DELETE FROM device_pairing_paired WHERE device_id = ?").run("node");
            } finally {
              other.close();
            }
            expect(await getPairedDevice("node", baseDir)).toBeNull();
          }
          expect(getPublishedPairedDeviceBinding("node", baseDir)).toBeNull();
          releaseRead.resolve();
          const settled = await delayed;
          // An obsolete read may refuse or reread; it must never return the old authority.
          if ("device" in settled) {
            expect(settled.device).toBeNull();
          }
          expect(getPublishedPairedDeviceBinding("node", baseDir)).toBeNull();
        } finally {
          releaseRead.resolve();
          releaseMutation.resolve();
          await Promise.allSettled([delayed, mutation]);
        }
      });
    } finally {
      read.mockRestore();
      writer.mockRestore();
    }
  },
);

test("retires prepared nodes after a native owner commit and database close", async () => {
  const snapshot = await readDevicePairingNodeSnapshot(baseDir);
  persistDevicePairingStoreState({ pendingById: {}, pairedByDeviceId: {} }, baseDir, "paired");
  const deleted = await readDevicePairingNodeSnapshot(baseDir);
  expect(deleted).not.toBe(snapshot);
  expect(deleted.paired).toEqual([]);
  expect(deleted.bindings.size).toBe(0);
  await closeOpenClawStateDatabaseByPathAsync(database.path);
  database = openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } });
  const reopened = await readDevicePairingNodeSnapshot(baseDir);
  expect(reopened).not.toBe(deleted);
  expect(reopened.paired).toEqual([]);
  expect(reopened.bindings.size).toBe(0);
});
