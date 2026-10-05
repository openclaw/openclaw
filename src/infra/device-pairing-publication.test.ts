import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NodeRegistry } from "../gateway/node-registry.js";
import {
  createTestNodeSocket,
  makeClient,
  registerNodeSession,
} from "../gateway/node-registry.test-helpers.js";
import type { GatewayWsClient } from "../gateway/server/ws-types.js";
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
  isPairedDeviceNodeBindingCurrent,
  withCurrentPairedDeviceNodeBinding,
} from "./device-pairing-node-state.js";
import { recordPairedNodeHostStats } from "./device-pairing-node.js";
import { getPublishedPairedDeviceBinding } from "./device-pairing-publication.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import { revokeDeviceToken } from "./device-pairing-tokens.js";
import { withCurrentDevicePairingSnapshot } from "./device-pairing-worker.js";
import {
  getPairedDevice,
  listDevicePairing,
  listDevicePairingReadOnly,
  removePairedDevice,
  updatePairedDeviceMetadata,
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
          approvedScopes: [],
          tokens: {
            node: { token: "synthetic-node-token", role: "node", scopes: [], createdAtMs: 1 },
          },
          nodeSurface: { createdAtMs: 1, approvedAtMs: 1, lastConnectedAtMs: 1 },
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
    if (change === "token revocation" || change === "metadata after a failed read") {
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

// Use the real pairing owner and invocation controller; only transport bytes are captured.
async function createStreamingNodeFixture() {
  const device = await getPairedDevice("node", baseDir);
  persistDevicePairingStoreState(
    {
      pendingById: {},
      pairedByDeviceId: {
        node: device!,
        other: { ...device!, deviceId: "other", publicKey: "other-key" },
      },
    },
    baseDir,
    "paired",
  );
  await listDevicePairing(baseDir);
  const binding = getPublishedPairedDeviceBinding("node", baseDir)!;
  const registry = new NodeRegistry({
    isPairingStateCurrent: isPairedDeviceNodeBindingCurrent,
    withCurrentPairingState: (nodeId, effect) =>
      withCurrentPairedDeviceNodeBinding(nodeId, effect, baseDir),
  });
  const frames: string[] = [];
  const sent = createDeferredCore<string>();
  const socket = createTestNodeSocket(frames);
  socket.send.mockImplementation((frame: string) => {
    frames.push(frame);
    sent.resolve(frame);
  });
  registerNodeSession(
    registry,
    makeClient("conn", "node", frames, {
      socket: socket as unknown as GatewayWsClient["socket"],
    }),
    {
      pairingIdentity: binding.identity,
      pairingGeneration: binding.generation,
    },
  );
  const chunks: string[] = [];
  const abort = new AbortController();
  const invocation = registry.invoke({
    nodeId: "node",
    command: "debug.ping",
    timeoutMs: 60_000,
    signal: abort.signal,
    onProgress: (chunk) => chunks.push(chunk),
  });
  const invokeId = JSON.parse(await sent.promise).payload.id as string;
  return {
    device: device!,
    binding,
    registry,
    frames,
    chunks,
    abort,
    invocation,
    invokeId,
    async close() {
      registry.unregister("conn");
      registry.unregister("replacement");
      await invocation;
    },
  };
}

// Pause after the real facade has fenced publication, before its worker can commit.
async function pauseMetadataMutation(target: string) {
  const queued = createDeferredCore();
  const release = createDeferredCore();
  const original = stateWorker.runOpenClawStateWorkerOperation;
  const writer = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementationOnce(async (...args) => {
      queued.resolve();
      await release.promise;
      return original(...args);
    });
  const mutation = updatePairedDeviceMetadata(target, { displayName: "Updated" }, baseDir);
  try {
    await Promise.race([queued.promise, mutation]);
  } catch (error) {
    release.resolve();
    writer.mockRestore();
    throw error;
  }
  return {
    mutation,
    release: () => release.resolve(),
    async close() {
      release.resolve();
      await Promise.allSettled([mutation]);
      writer.mockRestore();
    },
  };
}

test.each(["node", "other"] as const)(
  "waits for metadata on %s before admitting current node traffic",
  async (target) => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: baseDir }, async () => {
      const f = await createStreamingNodeFixture();
      const paused = await pauseMetadataMutation(target);
      let waiting: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        expect(() => getPublishedPairedDeviceBinding("node", baseDir)).toThrow(
          "current worker publication",
        );
        expect(() => f.registry.sendInvokeInput(f.invokeId, { command: "continue" })).toThrow();
        const observed: string[] = [];
        const current = f.registry.isConnectionCurrentPairingState("conn").then((value) => {
          observed.push("current");
          return value;
        });
        const input = f.registry
          .sendInvokeInputWhenCurrent(f.invokeId, { command: "continue" })
          .then(() => observed.push("input"));
        const progress = f.registry
          .handleInvokeProgressWhenCurrent({
            invokeId: f.invokeId,
            nodeId: "node",
            connId: "conn",
            seq: 0,
            chunk: "working",
          })
          .then((value) => {
            observed.push("progress");
            return value;
          });
        const result = f.registry
          .handleInvokeResultWhenCurrent({
            id: f.invokeId,
            nodeId: "node",
            connId: "conn",
            ok: true,
          })
          .then((value) => {
            observed.push("result");
            return value;
          });
        waiting = Promise.allSettled([current, input, progress, result]);
        await Promise.resolve();
        expect(observed).toEqual([]);
        expect(f.frames).toHaveLength(1);
        expect(f.chunks).toEqual([]);
        paused.release();
        await expect(paused.mutation).resolves.toBe(true);
        await expect(current).resolves.toBe(true);
        await input;
        await expect(progress).resolves.toBe(true);
        expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(f.binding);
        expect(f.chunks).toEqual(["working"]);
        expect(f.frames.map((frame) => JSON.parse(frame).event)).toEqual([
          "node.invoke.request",
          "node.invoke.input",
        ]);
        expect(JSON.parse(f.frames[1]!).payload.seq).toBe(0);
        await expect(result).resolves.toBe(true);
        await expect(f.invocation).resolves.toMatchObject({ ok: true });
      } finally {
        await paused.close();
        await waiting;
        await f.close();
      }
    });
  },
);

test("keeps failed metadata publication unavailable until a successful recovery", async () => {
  await listDevicePairing(baseDir);
  const writer = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockRejectedValueOnce(new Error("synthetic worker failure"));
  try {
    await expect(
      updatePairedDeviceMetadata("node", { displayName: "Updated" }, baseDir),
    ).rejects.toThrow("synthetic worker failure");
    expect(() => getPublishedPairedDeviceBinding("node", baseDir)).toThrow(
      "current worker publication",
    );
  } finally {
    writer.mockRestore();
  }
  await updatePairedDeviceMetadata("node", { displayName: "Recovered" }, baseDir);
  expect(getPublishedPairedDeviceBinding("node", baseDir)).not.toBeNull();
});

test.each(["remove", "revoke", "rotate", "cancel", "reconnect", "effect authority"] as const)(
  "does not send queued input after %s invalidates its authority",
  async (change) => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: baseDir }, async () => {
      const f = await createStreamingNodeFixture();
      const paused = await pauseMetadataMutation("other");
      let input: Promise<{ sent: boolean; error?: unknown }> | undefined;
      let effectAllowed = true;
      try {
        let inputSettled = false;
        input = f.registry
          .sendInvokeInputWhenCurrent(f.invokeId, { command: "sensitive work" }, () => {
            if (!effectAllowed) {
              throw new Error("effect authority was revoked");
            }
          })
          .then(
            () => {
              inputSettled = true;
              return { sent: true };
            },
            (error: unknown) => {
              inputSettled = true;
              return { sent: false, error };
            },
          );
        await Promise.resolve();
        expect(inputSettled).toBe(false);
        expect(f.frames).toHaveLength(1);
        if (change === "cancel") {
          f.abort.abort();
        } else if (change === "reconnect") {
          f.registry.unregister("conn");
          registerNodeSession(f.registry, makeClient("replacement", "node", f.frames), {
            pairingIdentity: f.binding.identity,
            pairingGeneration: f.binding.generation,
          });
        } else if (change === "effect authority") {
          effectAllowed = false;
        } else {
          const external = new DatabaseSync(database.path);
          try {
            if (change === "remove") {
              external.prepare("DELETE FROM device_pairing_paired WHERE device_id = ?").run("node");
            } else {
              const token = f.device.tokens!.node!;
              const replacement =
                change === "rotate"
                  ? { ...token, token: "external-replacement-token", rotatedAtMs: 100 }
                  : { ...token, revokedAtMs: 100 };
              external
                .prepare("UPDATE device_pairing_paired SET tokens_json = ? WHERE device_id = ?")
                .run(JSON.stringify({ ...f.device.tokens, node: replacement }), "node");
            }
          } finally {
            external.close();
          }
        }
        paused.release();
        await expect(paused.mutation).resolves.toBe(true);
        expect(await input).toMatchObject({ sent: false, error: expect.any(Error) });
        if (change === "effect authority") {
          expect(await input).toMatchObject({
            error: { message: "effect authority was revoked" },
          });
        }
        expect(f.frames.filter((frame) => JSON.parse(frame).event === "node.invoke.input")).toEqual(
          [],
        );
        if (change === "remove" || change === "revoke" || change === "rotate") {
          expect(f.frames).toHaveLength(1);
          await expect(f.registry.isConnectionCurrentPairingState("conn")).resolves.toBe(false);
        }
      } finally {
        await paused.close();
        await input;
        await f.close();
      }
    });
  },
);

test.each(["progress", "result"] as const)(
  "rejects %s after external removal while the cached pairing still appears current",
  async (effect) => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: baseDir }, async () => {
      const f = await createStreamingNodeFixture();
      try {
        const external = new DatabaseSync(database.path);
        try {
          external.prepare("DELETE FROM device_pairing_paired WHERE device_id = ?").run("node");
        } finally {
          external.close();
        }
        // No other effect or refresh may retire the invoke before this guard sees the deletion.
        expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(f.binding);
        const reply =
          effect === "progress"
            ? f.registry.handleInvokeProgressWhenCurrent({
                invokeId: f.invokeId,
                nodeId: "node",
                connId: "conn",
                seq: 0,
                chunk: "revoked output",
              })
            : f.registry.handleInvokeResultWhenCurrent({
                id: f.invokeId,
                nodeId: "node",
                connId: "conn",
                ok: true,
                payload: { mustNotEscape: true },
              });
        await expect(reply).resolves.toBe(false);
        expect(f.chunks).toEqual([]);
        expect(f.frames).toHaveLength(1);
        await expect(f.invocation).resolves.toMatchObject({ ok: false });
      } finally {
        await f.close();
      }
    });
  },
);
