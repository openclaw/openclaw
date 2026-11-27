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

describe("host stats persistence", () => {
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

  it("persists only the first of fifteen minutes of reports until shutdown", async () => {
    const { registry, persistHostStats, closeHostStats } = fixture();
    report(registry);
    await vi.advanceTimersByTimeAsync(0);
    expect(persistHostStats).toHaveBeenCalledExactlyOnceWith({
      nodeId: "node-1",
      hostStats: { ...stats, updatedAtMs: 1_000 },
      expectedPairingGeneration: { nodeId: "node-1", key: "generation-a" },
    });
    for (let minute = 1; minute <= 15; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      report(registry, 512 - minute);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(persistHostStats).toHaveBeenCalledTimes(1);
    const latest = { ...stats, memoryFreeBytes: 497, updatedAtMs: 901_000 };
    expect(registry.get("node-1")?.hostStats).toEqual(latest);
    await closeHostStats();
    expect(persistHostStats).toHaveBeenCalledTimes(2);
    expect(persistHostStats).toHaveBeenLastCalledWith({
      nodeId: "node-1",
      hostStats: latest,
      expectedPairingGeneration: { nodeId: "node-1", key: "generation-a" },
    });
  });

  it("logs a failed first save and retries on a later report", async () => {
    const { registry, persistHostStats, closeHostStats } = fixture();
    const capture = createDiagnosticLogRecordCapture();
    setLoggerOverride({
      level: "warn",
      consoleLevel: "silent",
      file: path.join(resolvePreferredOpenClawTmpDir(), `node-host-stats-${process.pid}.log`),
    });
    persistHostStats.mockRejectedValueOnce(new Error("fixture persistence failure"));
    try {
      report(registry);
      await vi.advanceTimersByTimeAsync(0);
      await capture.flush();
      expect(capture.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("fixture persistence failure"),
          }),
        ]),
      );
      report(registry, 300);
      await vi.advanceTimersByTimeAsync(0);
      expect(persistHostStats).toHaveBeenCalledTimes(2);
      expect(persistHostStats).toHaveBeenLastCalledWith({
        nodeId: "node-1",
        hostStats: { ...stats, memoryFreeBytes: 300, updatedAtMs: 1_000 },
        expectedPairingGeneration: { nodeId: "node-1", key: "generation-a" },
      });
      await closeHostStats();
      expect(persistHostStats).toHaveBeenCalledTimes(2);
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
