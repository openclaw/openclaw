import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getCurrentActiveNodeContext,
  prepareActiveNodeContext,
  setActiveNodeContexts,
} from "../infra/active-node-context.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../logging/test-helpers/diagnostic-log-capture.js";
import { createNodeRegistryRuntime } from "./node-registry-private.js";
import { NodeRegistry, type NodeRegistryOptions } from "./node-registry.js";
import { makeClient, registerNodeSession } from "./node-registry.test-helpers.js";

const registries = new Set<NodeRegistry>();
function createNodeRegistry(options: ConstructorParameters<typeof NodeRegistry>[0]) {
  const registry = new NodeRegistry(options);
  registries.add(registry);
  return registry;
}
afterEach(() => {
  for (const registry of registries) {
    for (const session of registry.listConnected()) {
      registry.unregister(session.connId);
    }
  }
  registries.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  setActiveNodeContexts([]);
});

it.each(["current", "revoked", "unavailable"])(
  "uses the published pairing authority after a delayed read (%s)",
  async (publication) => {
    const lookup = createDeferred<{ identity: string; generation: string }>();
    const frames: string[] = [];
    const client = makeClient("conn-publication", "node-publication", frames);
    let current = true;
    const registry = createNodeRegistry({
      resolveCurrentPairingState: () => lookup.promise,
      isPairingStateCurrent: () => {
        if (!current && publication === "unavailable") {
          throw new Error("pairing publication is pending");
        }
        return current;
      },
    });
    registerNodeSession(registry, client, {
      pairingIdentity: "identity-a",
      pairingGeneration: "generation-a",
    });
    const sent = registry.sendEventForPairingIdentity({
      nodeId: "node-publication",
      connId: "conn-publication",
      pairingIdentity: "identity-a",
      event: "voicewake.changed",
      payload: { triggers: ["hello"] },
    });
    current = publication === "current";
    lookup.resolve({ identity: "identity-a", generation: "generation-a" });
    await expect(sent).resolves.toBe(publication === "current");
    expect(frames).toHaveLength(publication === "current" ? 1 : 0);
    expect(client.invalidated === true).toBe(publication === "revoked");
  },
);

it("refreshes active-node authority before projecting a prompt after external revocation", async () => {
  let published = true;
  let durable = true;
  const registry = createNodeRegistry({
    resolveCurrentPairingState: async () => {
      published = durable;
      return durable ? { identity: "identity-a", generation: "generation-a" } : undefined;
    },
    isPairingStateCurrent: () => published,
  });
  registerNodeSession(
    registry,
    makeClient("conn-prompt", "node-prompt", [], {
      permissions: { accessibility: true },
    }),
    { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
  );
  registry.updatePresenceActivity({
    nodeId: "node-prompt",
    connId: "conn-prompt",
    idleSeconds: 0,
  });
  expect(getCurrentActiveNodeContext()?.nodeId).toBe("node-prompt");
  durable = false;
  await prepareActiveNodeContext();
  expect(getCurrentActiveNodeContext()).toBeNull();
  expect(registry.listConnected()).toEqual([]);
});

describe("host stats checkpoints", () => {
  const stats = { cpuCount: 8, memoryTotalBytes: 1_024, memoryFreeBytes: 512 };
  const pairingA = { pairingIdentity: "identity-a", pairingGeneration: "generation-a" };

  function fixture() {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const persistHostStats = vi
      .fn<NonNullable<NodeRegistryOptions["persistHostStats"]>>()
      .mockResolvedValue(true);
    const runtime = createNodeRegistryRuntime(() => createNodeRegistry({ persistHostStats }));
    registerNodeSession(runtime.nodeRegistry, makeClient("conn-1", "node-1"), pairingA);
    return { ...runtime, registry: runtime.nodeRegistry, persistHostStats };
  }

  function report(
    registry: NodeRegistry,
    memoryFreeBytes = 512,
    nodeId = "node-1",
    connId = "conn-1",
  ) {
    return registry.updateHostStats({
      nodeId,
      connId,
      stats: { ...stats, memoryFreeBytes },
    });
  }

  it.each([
    { label: "unchanged clock", receipt: 60_000, step: 0, later: false },
    { label: "quiet node after rollback", receipt: 60_000, step: -56_000, later: false },
    { label: "reporting node after rollback", receipt: 60_000, step: -56_000, later: true },
    { label: "buffered receipt before rollback", receipt: 240_000, step: -120_000, later: false },
    { label: "reporting node after forward step", receipt: 60_000, step: 30_000, later: true },
  ])("checkpoints by monotonic receipt age ($label)", async ({ receipt, step, later }) => {
    const { registry, persistHostStats, closeHostStats } = fixture();
    const firstWrite = createDeferred<boolean>();
    const secondWrite = createDeferred<boolean>();
    persistHostStats
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    report(registry);
    const expected = (memoryFreeBytes: number, updatedAtMs: number) => ({
      nodeId: "node-1",
      hostStats: { ...stats, memoryFreeBytes, updatedAtMs },
      expectedPairingGeneration: { nodeId: "node-1", key: "generation-a" },
    });
    expect(persistHostStats).toHaveBeenCalledExactlyOnceWith(expected(512, 1_000));
    await vi.advanceTimersByTimeAsync(receipt);
    report(registry, 400);
    firstWrite.resolve(true);
    await vi.advanceTimersByTimeAsync(30_000);
    vi.setSystemTime(Date.now() + step);
    const savedReceipt = later ? receipt + 30_000 : receipt;
    const savedEpoch = later ? Date.now() : receipt + 1_000;
    if (later) {
      report(registry, 300);
    }
    await vi.advanceTimersByTimeAsync(300_000 - receipt - 30_000 - 1);
    expect(persistHostStats).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(persistHostStats).toHaveBeenNthCalledWith(2, expected(later ? 300 : 400, savedEpoch));
    await vi.advanceTimersByTimeAsync(30_000);
    report(registry, 200);
    const latestEpoch = Date.now();
    secondWrite.resolve(true);
    await vi.advanceTimersByTimeAsync(savedReceipt - 30_000 - 1);
    expect(persistHostStats).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(persistHostStats).toHaveBeenNthCalledWith(3, expected(200, latestEpoch));
    await closeHostStats();
    expect(persistHostStats).toHaveBeenCalledTimes(3);
  });

  it("logs a failed checkpoint without retrying it on another node's timer", async () => {
    const { registry, persistHostStats, closeHostStats } = fixture();
    const capture = createDiagnosticLogRecordCapture();
    setLoggerOverride({
      level: "warn",
      consoleLevel: "silent",
      file: path.join(resolvePreferredOpenClawTmpDir(), `node-host-stats-${process.pid}.log`),
    });
    persistHostStats.mockRejectedValueOnce(new Error("fixture checkpoint failure"));
    try {
      report(registry);
      await vi.advanceTimersByTimeAsync(0);
      registerNodeSession(registry, makeClient("conn-2", "node-2"), pairingA);
      report(registry, 512, "node-2", "conn-2");
      await vi.advanceTimersByTimeAsync(60_000);
      report(registry, 400, "node-2", "conn-2");
      await vi.advanceTimersByTimeAsync(540_000);
      expect(persistHostStats.mock.calls.map(([params]) => params.nodeId)).toEqual([
        "node-1",
        "node-2",
        "node-2",
      ]);
      await capture.flush();
      expect(capture.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("fixture checkpoint failure"),
          }),
        ]),
      );

      report(registry, 300);
      await vi.advanceTimersByTimeAsync(0);
      expect(persistHostStats).toHaveBeenLastCalledWith({
        nodeId: "node-1",
        hostStats: { ...stats, memoryFreeBytes: 300, updatedAtMs: 601_000 },
        expectedPairingGeneration: { nodeId: "node-1", key: "generation-a" },
      });
      expect(persistHostStats).toHaveBeenCalledTimes(4);
      await closeHostStats();
    } finally {
      capture.cleanup();
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it.each(["replacement", "unregister", "invalidation", "generation"])(
    "drops buffered samples after session %s, including a pending completion",
    async (retirement) => {
      const { registry, persistHostStats, closeHostStats } = fixture();
      const firstWrite = createDeferred<boolean>();
      persistHostStats.mockImplementationOnce(() => firstWrite.promise);
      report(registry);
      await vi.advanceTimersByTimeAsync(60_000);
      report(registry, 400);
      if (retirement === "replacement") {
        registerNodeSession(registry, makeClient("conn-replacement", "node-1"), pairingA);
      } else if (retirement === "generation") {
        expect(
          registry.updateSurface(
            "node-1",
            { commands: [] },
            {
              expectedConnId: "conn-1",
              expectedPairingIdentity: "identity-a",
              expectedPairingGeneration: "generation-a",
              nextPairingGeneration: "generation-b",
            },
          ),
        ).not.toBeNull();
      } else if (retirement === "unregister") {
        registry.unregister("conn-1");
      } else {
        registry.invalidateConnectionForPairingChange("conn-1");
      }
      expect(registry.get("node-1")?.hostStats).toBeUndefined();

      const stillConnected = retirement === "replacement" || retirement === "generation";
      if (stillConnected) {
        report(
          registry,
          300,
          "node-1",
          retirement === "replacement" ? "conn-replacement" : "conn-1",
        );
        expect(persistHostStats).toHaveBeenLastCalledWith({
          nodeId: "node-1",
          hostStats: { ...stats, memoryFreeBytes: 300, updatedAtMs: 61_000 },
          expectedPairingGeneration: {
            nodeId: "node-1",
            key: retirement === "generation" ? "generation-b" : "generation-a",
          },
        });
      }
      firstWrite.resolve(true);
      await vi.advanceTimersByTimeAsync(600_000);
      await closeHostStats();
      expect(persistHostStats).toHaveBeenCalledTimes(stillConnected ? 2 : 1);
    },
  );

  it.each(["success", "failure"])(
    "joins retired writes and flushes once across repeated close after final %s",
    async (outcome) => {
      const { registry, persistHostStats, closeHostStats } = fixture();
      const retiredWrite = createDeferred<boolean>();
      const currentWrite = createDeferred<boolean>();
      const finalWrite = createDeferred<boolean>();
      persistHostStats
        .mockImplementationOnce(() => retiredWrite.promise)
        .mockImplementationOnce(() => currentWrite.promise)
        .mockImplementationOnce(() => finalWrite.promise);
      report(registry);
      await vi.advanceTimersByTimeAsync(60_000);
      registerNodeSession(registry, makeClient("conn-replacement", "node-1"), pairingA);
      report(registry, 400, "node-1", "conn-replacement");
      await vi.advanceTimersByTimeAsync(60_000);
      report(registry, 300, "node-1", "conn-replacement");

      const firstClose = closeHostStats();
      const secondClose = closeHostStats();
      const closed = vi.fn();
      void Promise.all([firstClose, secondClose]).then(closed);
      currentWrite.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(closed).not.toHaveBeenCalled();
      expect(persistHostStats).toHaveBeenCalledTimes(2);
      retiredWrite.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(persistHostStats).toHaveBeenNthCalledWith(3, {
        nodeId: "node-1",
        hostStats: { ...stats, memoryFreeBytes: 300, updatedAtMs: 121_000 },
        expectedPairingGeneration: { nodeId: "node-1", key: "generation-a" },
      });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(persistHostStats).toHaveBeenCalledTimes(3);
      expect(closed).not.toHaveBeenCalled();
      if (outcome === "success") {
        finalWrite.resolve(true);
      } else {
        finalWrite.reject(new Error("fixture final checkpoint failure"));
      }
      await expect(Promise.all([firstClose, secondClose, closeHostStats()])).resolves.toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(persistHostStats).toHaveBeenCalledTimes(3);
    },
  );
});
