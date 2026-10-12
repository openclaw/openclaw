import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
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
import { issueDeviceBootstrapToken } from "./device-bootstrap.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import { updatePairedNodeBins, updatePairedNodeSessionHost } from "./device-pairing-node-facts.js";
import {
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
} from "./device-pairing-node-state.js";
import { recordPairedNodeConnection, recordPairedNodeHostStats } from "./device-pairing-node.js";
import { getPublishedPairedDeviceBinding } from "./device-pairing-publication.js";
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
  await listDevicePairing(baseDir);
  const binding = getPublishedPairedDeviceBinding("node", baseDir);
  expect(binding).not.toBeNull();
  await issueDeviceBootstrapToken({ baseDir });
  expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
  const device = await getPairedDevice("node", baseDir);
  device!.tokens!.node!.revokedAtMs = 100;
  expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
  const copy = getPublishedPairedDeviceBinding("node", baseDir)!;
  copy.identity = "caller-edit";
  expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
});

test.each([
  "session-host consent",
  "host stats",
  "skill bins",
  "token revocation",
  "metadata after a failed read",
] as const)("retains only usable node authority during %s", async (change) => {
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
    if (change === "metadata after a failed read") {
      expect(() => getPublishedPairedDeviceBinding("node", baseDir)).toThrow(
        "Device pairing authority requires a current worker publication",
      );
    } else {
      expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
    }
    releaseMutation.resolve();
    expect(await mutation).toEqual(
      change === "token revocation" ? expect.objectContaining({ ok: true }) : true,
    );
    expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(
      change === "token revocation" ? null : binding,
    );
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
    await listDevicePairing(baseDir);
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
  "token verification",
  "connection record",
  "presence update",
  "metadata update",
  "token revocation",
] as const)("keeps other node authority readable during one device's %s", async (change) => {
  const node = expectDefined(await getPairedDevice("node", baseDir), "paired node");
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
  await listDevicePairing(baseDir);
  const nodeBinding = getPublishedPairedDeviceBinding("node", baseDir);
  const otherBinding = getPublishedPairedDeviceBinding("other", baseDir);
  expect(nodeBinding).not.toBeNull();
  expect(otherBinding).not.toBeNull();
  const generation = expectDefined(
    await withEnvAsync({ OPENCLAW_STATE_DIR: baseDir }, () =>
      captureNodePairingGeneration("other"),
    ),
    "other generation",
  );
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const afterCommit: unknown[] = [];
  const originalMutation = stateWorker.runOpenClawStateWorkerOperation;
  const delivery = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      const result = await originalMutation(...args);
      afterCommit.push(
        getPublishedPairedDeviceBinding("other", baseDir),
        getPublishedPairedDeviceBinding("node", baseDir),
      );
      return result;
    });
  const mutate = () => {
    switch (change) {
      case "token verification":
        return verifyDeviceToken({
          deviceId: "other",
          token: "synthetic-other-token",
          role: "node",
          scopes: [],
          baseDir,
        });
      case "connection record":
        return recordPairedNodeConnection("other", 2, baseDir, generation);
      case "presence update":
        return updatePairedDevicePresence(
          "other",
          { lastSeenAtMs: 2, lastSeenReason: "node-event" },
          generation,
          baseDir,
        );
      case "metadata update":
        return updatePairedDeviceMetadata("other", { displayName: "Other" }, baseDir);
      default:
        return revokeDeviceToken({ deviceId: "other", role: "node", baseDir });
    }
  };
  const mutation = mutate();
  try {
    await awaitGateBeforeSettlement(entered.promise, mutation, "pairing mutation was not held");
    expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(nodeBinding);
    // Until COMMIT, the stored row remains authoritative for the changing device too.
    expect(getPublishedPairedDeviceBinding("other", baseDir)).toEqual(otherBinding);
    release.resolve();
    await mutation;
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
  await listDevicePairing(baseDir);
  await withOpenClawStateDatabaseReadSnapshot(
    async () => {
      const historical = JSON.stringify(await listDevicePairingReadOnly(baseDir));
      await removePairedDevice("node", baseDir);
      expect(getPublishedPairedDeviceBinding("node", baseDir)).toBeNull();
      expect(JSON.stringify(await listDevicePairingReadOnly(baseDir))).toBe(historical);
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

test.each(["worker commit", "external commit"] as const)(
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
            const other = new DatabaseSync(database.path);
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
