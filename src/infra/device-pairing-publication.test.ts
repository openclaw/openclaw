import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { issueDeviceBootstrapToken, startDevicePairSetupMaintenance } from "./device-bootstrap.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import { updatePairedNodeBins, updatePairedNodeSessionHost } from "./device-pairing-node-facts.js";
import {
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
  type NodePairingGeneration,
} from "./device-pairing-node-state.js";
import {
  recordPairedNodeConnection,
  recordPairedNodeHostStats,
  renamePairedNode,
} from "./device-pairing-node.js";
import { getPublishedPairedDeviceBinding } from "./device-pairing-publication.js";
import { readDevicePairingNodeSnapshot } from "./device-pairing-store-readonly.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import { revokeDeviceToken, verifyDeviceToken } from "./device-pairing-tokens.js";
import { withCurrentDevicePairingSnapshot } from "./device-pairing-worker.js";
import {
  getPairedDevice,
  getPendingDevicePairing,
  listDevicePairing,
  listDevicePairingReadOnly,
  removePairedDevice,
  updatePairedDeviceMetadata,
  updatePairedDevicePresence,
} from "./device-pairing.js";
import type { PairedDevice } from "./device-pairing.types.js";
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

function persistNodes(
  pairedByDeviceId: Record<string, PairedDevice>,
  mode: "both" | "paired" = "paired",
) {
  persistDevicePairingStoreState({ pendingById: {}, pairedByDeviceId }, baseDir, mode);
}

const inState = <T>(run: () => Promise<T>) => withEnvAsync({ OPENCLAW_STATE_DIR: baseDir }, run);
async function generationFor(id = "node") {
  return expectDefined(await inState(() => captureNodePairingGeneration(id)), `${id} generation`);
}

function holdWorker() {
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
  return { entered, release, writer };
}

async function seedOther(overrides: Partial<PairedDevice> = {}) {
  const node = expectDefined(await getPairedDevice("node", baseDir), "paired node");
  const other = {
    ...structuredClone(node),
    deviceId: "other",
    publicKey: "synthetic-other-key",
    tokens: { node: { token: "synthetic-other-token", role: "node", scopes: [], createdAtMs: 1 } },
    ...overrides,
  };
  persistNodes({ node, other });
  await readDevicePairingNodeSnapshot(baseDir);
  return { node, other };
}

function changesFor(nodeId: string, generation: NodePairingGeneration) {
  const facts = { nodeId, expectedPairingGeneration: generation, baseDir };
  const token = { deviceId: nodeId, role: "node", baseDir };
  const consent = () =>
    updatePairedNodeSessionHost({
      ...facts,
      sessionHost: true,
      isConnectionCurrent: () => true,
    });
  return {
    rename: () => renamePairedNode(nodeId, "Renamed node", baseDir),
    "host stats": () =>
      recordPairedNodeHostStats({
        ...facts,
        hostStats: { cpuCount: 2, memoryTotalBytes: 8_192, memoryFreeBytes: 4_096, updatedAtMs: 2 },
      }),
    "skill bins": () => updatePairedNodeBins(nodeId, ["git"], generation, baseDir),
    "token revocation": () => revokeDeviceToken(token),
    "session-host consent": consent,
    "metadata after a failed read": consent,
    "token verification": () =>
      verifyDeviceToken({ ...token, token: `synthetic-${nodeId}-token`, scopes: [] }),
    "connection record": () => recordPairedNodeConnection(nodeId, 2, baseDir, generation),
    "presence update": () =>
      updatePairedDevicePresence(
        nodeId,
        { lastSeenAtMs: 2, lastSeenReason: "node-event" },
        generation,
        baseDir,
      ),
    "metadata update": () => updatePairedDeviceMetadata(nodeId, { displayName: "Other" }, baseDir),
  };
}

beforeEach(() => {
  persistNodes(
    {
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
  await inState(async () => {
    const snapshot = await readDevicePairingNodeSnapshot(baseDir);
    const binding = getPublishedPairedDeviceBinding("node", baseDir);
    expect(binding).not.toBeNull();
    const { entered, release, writer } = holdWorker();
    const clock = createGatewaySchedulerClock(Date.now());
    const scheduler = createTestGatewayScheduler(clock.clock);
    const onError = vi.fn();
    startDevicePairSetupMaintenance({ scheduler: scheduler.scope(), onError });
    const pruning = Promise.resolve(clock.wake());
    try {
      await awaitGateBeforeSettlement(entered.promise, pruning, "setup cleanup was not held");
      expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
      release.resolve();
      await pruning;
      expect(onError).not.toHaveBeenCalled();
      expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
      expect(await readDevicePairingNodeSnapshot(baseDir)).toBe(snapshot);
    } finally {
      release.resolve();
      await Promise.allSettled([pruning]);
      await scheduler.stop();
      writer.mockRestore();
    }
  });
});

test.for([
  ["session-host consent", { nodeSurface: { sessionHost: true } }],
  ["host stats", { nodeSurface: { lastHostStats: { cpuCount: 2, updatedAtMs: 2 } } }],
  ["skill bins", { nodeSurface: { bins: ["git"] } }],
  ["rename", { nodeSurface: { displayName: "Renamed node" } }],
  ["token revocation", { tokens: { node: { revokedAtMs: expect.any(Number) } } }],
  ["metadata after a failed read", { nodeSurface: { sessionHost: true } }],
] as const)(
  "retains only usable node authority during %s",
  async ([change, expected], { signal }) => {
    const snapshot = await readDevicePairingNodeSnapshot(baseDir);
    const generation = await generationFor();
    const binding = getPublishedPairedDeviceBinding("node", baseDir);
    if (change === "metadata after a failed read") {
      using _ = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockRejectedValueOnce(new Error("pairing read unavailable"));
      await expect(getPendingDevicePairing("unavailable", baseDir)).rejects.toThrow(
        "pairing read unavailable",
      );
    }
    const { entered: mutationQueued, release: releaseMutation, writer } = holdWorker();
    const mutation = changesFor("node", generation)[change]();
    try {
      await awaitGateBeforeSettlement(
        mutationQueued.promise,
        mutation,
        "pairing mutation settled before worker dispatch",
      );
      if (change === "metadata after a failed read") {
        expect(() => getPublishedPairedDeviceBinding("node", baseDir)).toThrow(
          "Device pairing authority requires a current worker publication",
        );
      } else {
        expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
        // Discovery must finish while the write is still queued, using committed facts.
        expect(await withinTest(readDevicePairingNodeSnapshot(baseDir), signal)).toBe(snapshot);
      }
      releaseMutation.resolve();
      expect(await mutation).toEqual(
        change === "token revocation"
          ? expect.objectContaining({ ok: true })
          : change === "rename"
            ? expect.objectContaining({ displayName: "Renamed node" })
            : true,
      );
      const committedBinding = change === "token revocation" ? null : binding;
      expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(committedBinding);
      const updated = await readDevicePairingNodeSnapshot(baseDir);
      expect(updated).not.toBe(snapshot);
      expect(await readDevicePairingNodeSnapshot(baseDir)).toBe(updated);
      expect(updated.bindings.get("node") ?? null).toEqual(committedBinding);
      expect(updated.paired[0]).toMatchObject(expected);
    } finally {
      releaseMutation.resolve();
      await Promise.allSettled([mutation]);
      writer.mockRestore();
    }
  },
);

test.each(["lookup", "pending read", "token revocation"] as const)(
  "keeps unrelated node authority when a %s publishes a revision the cache missed",
  async (source) => {
    const { node, other } = await seedOther();
    const binding = getPublishedPairedDeviceBinding("node", baseDir);
    expect(binding).not.toBeNull();
    // Boot and Doctor migrations commit without a worker receipt.
    persistNodes({ node, other: { ...other, lastSeenAtMs: 2 } });
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

test.for([
  "token verification",
  "connection record",
  "presence update",
  "metadata update",
  "token revocation",
] as const)("keeps other node authority during %s", async (change, { signal }) => {
  await seedOther({ approvedScopes: [] });
  const nodeBinding = getPublishedPairedDeviceBinding("node", baseDir);
  const otherBinding = getPublishedPairedDeviceBinding("other", baseDir);
  expect(nodeBinding).not.toBeNull();
  expect(otherBinding).not.toBeNull();
  const generation = await generationFor("other");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const afterCommit: unknown[] = [];
  const delivery = probe.command(
    stateWorker,
    async (command, options, scope) => {
      entered.resolve();
      await release.promise;
      const result = await scope.execute(command, options);
      afterCommit.push(
        getPublishedPairedDeviceBinding("other", baseDir),
        getPublishedPairedDeviceBinding("node", baseDir),
      );
      return result;
    },
    { once: true },
  );
  const mutation = changesFor("other", generation)[change]();
  try {
    if (change === "token verification") {
      expect(await mutation).toEqual({ ok: true });
      await withinTest(entered.promise, signal);
    } else {
      await awaitGateBeforeSettlement(entered.promise, mutation, "pairing mutation was not held");
    }
    expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(nodeBinding);
    // Until COMMIT, the stored row remains authoritative for the changing device too.
    expect(getPublishedPairedDeviceBinding("other", baseDir)).toEqual(otherBinding);
    release.resolve();
    await mutation;
    await withDevicePairingLock(async () => {});
    const committedOther = change === "token revocation" ? null : otherBinding;
    // The first read after COMMIT drains and installs the receipt itself.
    expect(afterCommit).toEqual([committedOther, nodeBinding]);
    expect(getPublishedPairedDeviceBinding("other", baseDir)).toEqual(committedOther);
    expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(nodeBinding);
  } finally {
    release.resolve();
    await Promise.allSettled([mutation]);
    delivery.mockRestore();
  }
});

test.each([
  { change: "unrelated operator approval", remainsCurrent: true },
  { change: "node surface reapproval", remainsCurrent: false },
  { change: "node token replacement", remainsCurrent: false },
  { change: "node token revocation", remainsCurrent: false },
] as const)("refreshes node work authority after $change", async ({ change, remainsCurrent }) => {
  await inState(async () => {
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
    persistNodes({ node: device! });
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

test.each(["worker commit", "native owner commit"] as const)(
  "does not restore revoked node authority from a read delayed past a newer %s",
  async (commit) => {
    await listDevicePairing(baseDir);
    expect(getPublishedPairedDeviceBinding("node", baseDir)).not.toBeNull();
    // A native owner's commit retires the resident rows, forcing this read through the worker.
    persistNodes({ node: (await getPairedDevice("node", baseDir))! });
    const releaseRead = createDeferredCore();
    const originalRead = stateReads.executeExistingOpenClawStateRead;
    const readProduced = createDeferredCore<Awaited<ReturnType<typeof originalRead>>>();
    const { entered: mutationQueued, release: releaseMutation, writer } = holdWorker();
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
            persistNodes({});
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
  persistNodes({});
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
