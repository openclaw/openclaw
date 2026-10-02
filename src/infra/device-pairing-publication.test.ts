import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, expect, onTestFinished, test, vi } from "vitest";
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
import {
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
} from "./device-pairing-node-state.js";
import { getPublishedPairedDeviceBinding } from "./device-pairing-publication.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import { withCurrentDevicePairingSnapshot } from "./device-pairing-worker.js";
import {
  getPairedDevice,
  listDevicePairing,
  listDevicePairingReadOnly,
  removePairedDevice,
  updatePairedDeviceMetadata,
} from "./device-pairing.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";

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

test.each(["metadata observation", "pairing removal"] as const)(
  "keeps an admitted generation observation before a queued %s while final effects stay fenced",
  async (change) => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: baseDir }, async () => {
      const generation = await captureNodePairingGeneration("node");
      expect(generation).not.toBeNull();
      const readReady = createDeferredCore();
      const releaseRead = createDeferredCore();
      const writerReady = createDeferredCore();
      const releaseWriter = createDeferredCore();
      const executeRead = stateReads.executeExistingOpenClawStateRead;
      const reader = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockImplementationOnce(async (...args) => {
          const result = await executeRead(...args);
          readReady.resolve();
          await releaseRead.promise;
          return result;
        });
      const runOperation = stateWorker.runOpenClawStateWorkerOperation;
      const writer = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockImplementationOnce(async (...args) => {
          writerReady.resolve();
          await releaseWriter.promise;
          return runOperation(...args);
        });
      const checked = isNodePairingGenerationCurrent(generation!).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      let mutation: Promise<unknown> | undefined;
      const cleanup = async () => {
        releaseRead.resolve();
        releaseWriter.resolve();
        await Promise.allSettled([checked, mutation]);
        reader.mockRestore();
        writer.mockRestore();
      };
      onTestFinished(cleanup);
      try {
        await readReady.promise;
        mutation =
          change === "metadata observation"
            ? updatePairedDeviceMetadata("node", { displayName: "Still connected" }, baseDir)
            : removePairedDevice("node", baseDir);
        releaseRead.resolve();
        await writerReady.promise;
        // The read was admitted first; a later write still fences synchronous effect authority.
        expect(() => getPublishedPairedDeviceBinding("node", baseDir)).toThrow(
          "Device pairing authority requires a current worker publication",
        );
        expect(await checked).toEqual({ value: true });
      } finally {
        await cleanup();
      }
      await expect(isNodePairingGenerationCurrent(generation!)).resolves.toBe(
        change === "metadata observation",
      );
      if (change === "metadata observation") {
        expect((await getPairedDevice("node", baseDir))?.displayName).toBe("Still connected");
      }
    });
  },
);

test.each(["worker commit", "external commit", "observation commit"] as const)(
  "does not republish a pairing read delayed past a newer %s",
  async (commit) => {
    await listDevicePairing(baseDir);
    const before = await getPairedDevice("node", baseDir);
    const previousBinding = getPublishedPairedDeviceBinding("node", baseDir);
    expect(previousBinding).not.toBeNull();
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
          commit === "worker commit"
            ? removePairedDevice("node", baseDir)
            : commit === "observation commit"
              ? updatePairedDeviceMetadata("node", { displayName: "Reconnected node" }, baseDir)
              : undefined;
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
          const expected = await getPairedDevice("node", baseDir);
          if (commit === "observation commit") {
            expect(expected?.displayName).toBe("Reconnected node");
          } else {
            expect(expected).toBeNull();
          }
          const expectedBinding = commit === "observation commit" ? previousBinding : null;
          expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(expectedBinding);
          releaseRead.resolve();
          const settled = await delayed;
          // Observation-only commits preserve the admitted snapshot. Authority
          // changes may refuse or reread, but never return superseded grants.
          if (commit === "observation commit") {
            expect(settled).toEqual({ device: before });
          } else if ("device" in settled) {
            expect(settled.device).toEqual(expected);
          }
          expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(expectedBinding);
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

test.each([false, true])(
  "preserves a read published ahead of its receipt (foreign revocation=%s)",
  async (foreign) => {
    const node = (await getPairedDevice("node", baseDir))!;
    persistDevicePairingStoreState(
      {
        pendingById: {},
        pairedByDeviceId: {
          node,
          peer: {
            ...node,
            deviceId: "peer",
            publicKey: "synthetic-peer-key",
            tokens: { node: { ...node.tokens!.node!, token: "synthetic-peer-token" } },
          },
        },
      },
      baseDir,
      "paired",
    );
    await listDevicePairing(baseDir);
    const nodeBefore = getPublishedPairedDeviceBinding("node", baseDir);
    const peerBefore = getPublishedPairedDeviceBinding("peer", baseDir);
    expect(nodeBefore).not.toBeNull();
    expect(peerBefore).not.toBeNull();
    const committed = createDeferredCore();
    const release = createDeferredCore();
    let revealReceipt = false;
    const restoreReceipts: Array<() => void> = [];
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    const receipt = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) => {
        const admission = createAdmission(admit, attachment);
        const getter = Object.getOwnPropertyDescriptor(admission, "committed")!.get!.bind(
          admission,
        );
        const heldReceipt = vi.spyOn(admission, "committed", "get").mockImplementation(() => {
          const facts = getter();
          return revealReceipt ? facts : undefined;
        });
        restoreReceipts.push(() => heldReceipt.mockRestore());
        return admission;
      });
    const runOperation = stateWorker.runOpenClawStateWorkerOperation;
    const held = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        runOperation(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                const result = await scope.execute(command, executeOptions);
                committed.resolve();
                await release.promise;
                return result;
              },
            }),
          options,
        ),
      );
    const mutation = updatePairedDeviceMetadata(
      "node",
      { displayName: "Committed observation" },
      baseDir,
    );
    onTestFinished(async () => {
      revealReceipt = true;
      release.resolve();
      await Promise.allSettled([mutation]);
      held.mockRestore();
      receipt.mockRestore();
      for (const restore of restoreReceipts) {
        restore();
      }
    });
    await Promise.race([committed.promise, mutation]);
    const after = await listDevicePairing(baseDir);
    expect(after.paired.find((row) => row.deviceId === "node")?.displayName).toBe(
      "Committed observation",
    );
    if (foreign) {
      const other = new DatabaseSync(database.path);
      try {
        other
          .prepare("UPDATE device_pairing_paired SET tokens_json = ? WHERE device_id = ?")
          .run(JSON.stringify({ node: { ...node.tokens!.node!, revokedAtMs: 2 } }), "node");
      } finally {
        other.close();
      }
      const fresh = await listDevicePairing(baseDir);
      expect(fresh.paired.find((row) => row.deviceId === "node")?.tokens?.node?.revokedAtMs).toBe(
        2,
      );
    }
    revealReceipt = true;
    release.resolve();
    await mutation;
    if (!foreign) {
      expect(getPublishedPairedDeviceBinding("peer", baseDir)).toEqual(peerBefore);
      expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(nodeBefore);
      expect(getPublishedPairedDeviceBinding("absent", baseDir)).toBeNull();
    } else {
      expect(() => getPublishedPairedDeviceBinding("node", baseDir)).toThrow(
        "requires a current worker publication",
      );
      await listDevicePairing(baseDir);
      expect(getPublishedPairedDeviceBinding("node", baseDir)).toBeNull();
    }
  },
);
