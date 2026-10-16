import { describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import type { SpawnResult } from "../../process/exec.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { StaleWorkerBuildError } from "./admission.js";
import { createWorkerPlacementDiskSpaceMonitor } from "./placement-disk-space.js";
import type { WorkerSessionPlacementRecord } from "./placement-store.js";
import { activePlacement as makeActivePlacement } from "./placement-suite.test-support.js";
import type { WorkerTunnelRequest, WorkerWorkspaceCommand } from "./tunnel-contract.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function activePlacement(
  overrides: Partial<Extract<WorkerSessionPlacementRecord, { state: "active" }>> = {},
): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return makeActivePlacement("session-disk", {
    environmentId: "environment-disk",
    generation: 3,
    activeOwnerEpoch: 7,
    workspaceBaseManifestRef: "manifest-disk",
    remoteWorkspaceDir: "/workspace/session-disk",
    createdAtMs: 10,
    updatedAtMs: 20,
    stateChangedAtMs: 15,
    ...overrides,
  });
}

function result(availableBytes: number, totalBytes: number): SpawnResult {
  return {
    stdout: JSON.stringify({
      availableBytes: String(availableBytes),
      totalBytes: String(totalBytes),
    }),
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

function createHarness(
  runWorkspaceCommand: (command: WorkerWorkspaceCommand) => Promise<SpawnResult> = async () =>
    result(6 * GIB, 10 * GIB),
) {
  let placement: WorkerSessionPlacementRecord = activePlacement();
  let runnerStatus: "available" | "offline" = "available";
  let runnerVersion = 0;
  let nowMs = 1_000;
  const unexpected = async () => {
    throw new Error("unexpected workspace mutation during a disk probe");
  };
  const startTunnel = vi.fn(async ({ environmentId, ownerEpoch }: WorkerTunnelRequest) => ({
    environmentId,
    ownerEpoch,
    runWorkspaceCommand,
    quiesceWorkspace: unexpected,
    syncWorkspace: unexpected,
    reconcileWorkspace: unexpected,
    stop: async () => {},
  }));
  const warn = vi.fn();
  const releaseInventory = vi.fn();
  const prepareMaintenancePlacements = vi.fn(async () => ({
    placements: [placement],
    assertCurrent() {},
    release: releaseInventory,
  }));
  const monitor = createWorkerPlacementDiskSpaceMonitor({
    placements: { prepareMaintenancePlacements },
    environments: { startTunnel },
    runnerAvailability: {
      read: () => ({ kind: "device", deviceId: "node-1", status: runnerStatus }),
      version: () => runnerVersion,
    },
    warn,
    now: () => nowMs,
  });
  return {
    monitor,
    startTunnel,
    warn,
    prepareMaintenancePlacements,
    releaseInventory,
    async sweep(ms = 0) {
      nowMs += ms;
      await monitor.sweep();
    },
    snapshot: () => monitor.read(placement),
    get placement() {
      return placement;
    },
    setRunnerStatus(next: "available" | "offline") {
      runnerStatus = next;
      runnerVersion += 1;
    },
    advanceTime(ms: number) {
      nowMs += ms;
    },
    setPlacement(next: WorkerSessionPlacementRecord) {
      placement = next;
      monitor.invalidate();
    },
  };
}

describe("active worker placement disk-space monitoring", () => {
  it("cancels an optional probe without publishing a late sample", async ({ signal }) => {
    const controller = new AbortController();
    const stopped = new Error("disk probe stopped");
    const entered = createDeferredCore();
    const harness = createHarness(async (command) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        command.signal?.addEventListener("abort", () => reject(stopped), { once: true });
      });
      return result(6 * GIB, 10 * GIB);
    });
    const sweeping = harness.monitor.sweep(controller.signal);
    await withinTest(entered.promise, signal);
    controller.abort(stopped);
    await withinTest(sweeping, signal);
    expect(harness.releaseInventory).toHaveBeenCalledOnce();
    expect(harness.monitor.read(harness.placement)).toBeUndefined();
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it.each(["active", "inactive", "revoked"] as const)(
    "releases the %s placement inventory before leaving the sweep",
    async (state) => {
      const harness = createHarness(async () => {
        expect(harness.releaseInventory).toHaveBeenCalledTimes(1);
        return result(6 * GIB, 10 * GIB);
      });
      if (state === "inactive") {
        harness.setPlacement({ ...activePlacement(), state: "draining" });
      } else if (state === "revoked") {
        harness.prepareMaintenancePlacements.mockResolvedValueOnce({
          get placements(): WorkerSessionPlacementRecord[] {
            throw new Error("placement authority revoked");
          },
          assertCurrent() {},
          release: harness.releaseInventory,
        });
      }

      if (state === "revoked") {
        await expect(harness.monitor.sweep()).rejects.toThrow("placement authority revoked");
      } else {
        await harness.monitor.sweep();
      }

      expect(harness.releaseInventory).toHaveBeenCalledTimes(1);
      expect(harness.startTunnel).toHaveBeenCalledTimes(state === "active" ? 1 : 0);
      expect(harness.warn).not.toHaveBeenCalled();
    },
  );

  it("reuses an idle sample for fifteen minutes and refreshes after placement activity", async () => {
    const runWorkspaceCommand = vi.fn(async () => result(6 * GIB, 10 * GIB));
    const harness = createHarness(runWorkspaceCommand);

    await harness.monitor.sweep();
    expect(harness.monitor.nextSweepAtMs()).toBe(1_000 + 15 * 60_000);
    for (let minute = 0; minute < 14; minute += 1) {
      await harness.sweep(60_000);
    }
    expect(runWorkspaceCommand).toHaveBeenCalledTimes(1);
    expect(harness.prepareMaintenancePlacements).toHaveBeenCalledTimes(1);

    for (const [index, step] of [
      { ms: 60_000 },
      { placement: activePlacement({ updatedAtMs: 30 }) },
      { placement: activePlacement({ generation: 4, activeOwnerEpoch: 8 }) },
      { ms: 24 * 60 * 60_000 },
    ].entries()) {
      if (step.placement) {
        harness.setPlacement(step.placement);
      }
      await harness.sweep(step.ms);
      expect(runWorkspaceCommand).toHaveBeenCalledTimes(index + 2);
    }
  });

  it("samples an idle active placement and emits only projected status transitions", async () => {
    let availableBytes = 6 * GIB;
    const commands: WorkerWorkspaceCommand[] = [];
    const harness = createHarness(async (command) => {
      commands.push(command);
      return result(availableBytes, 10 * GIB);
    });
    const events: Array<{ reason: string; sessionKey: string }> = [];
    const unsubscribe = onSessionLifecycleEvent((event) => events.push(event));
    try {
      await harness.monitor.sweep();
      expect(harness.snapshot()).toEqual({
        status: "ok",
        availableBytes,
        totalBytes: 10 * GIB,
        observedAtMs: 1_000,
      });
      expect(commands[0]).toMatchObject({
        transportRetry: "idempotent",
        timeoutMs: 30_000,
      });
      expect(commands[0]?.argv.at(-1)).toBe("/workspace/session-disk");
      expect(commands[0]?.argv[2]).toContain("statfs");
      expect(commands[0]?.argv[2]).toContain("bavail");
      expect(harness.startTunnel).toHaveBeenCalledWith({
        environmentId: "environment-disk",
        ownerEpoch: 7,
        authorize: expect.any(Function),
      });
      expect(harness.monitor.version()).toBe(1);
      expect(events).toEqual([]);

      for (const [bytes, ms, status, version, eventCount] of [
        [400 * MIB, 15 * 60_000, "warning", 2, 1],
        [300 * MIB, 15 * 60_000, "warning", 3, 1],
        [300 * MIB, 0, "warning", 3, 1],
        [6 * GIB, 15 * 60_000, "ok", 4, 2],
      ] as const) {
        availableBytes = bytes;
        await harness.sweep(ms);
        expect(harness.snapshot()).toMatchObject({ status, availableBytes });
        expect(harness.monitor.version()).toBe(version);
        expect(events).toEqual(
          Array.from({ length: eventCount }, () => ({
            reason: "worker-disk-space",
            sessionKey: "agent:main:session-disk",
            agentId: "main",
          })),
        );
      }
    } finally {
      unsubscribe();
    }
  });

  it.each([
    { availableBytes: 99 * MIB, totalBytes: 10 * GIB, status: "critical" },
    { availableBytes: 512 * MIB, totalBytes: 25 * GIB, status: "critical" },
    { availableBytes: 100 * MIB, totalBytes: GIB, status: "warning" },
    { availableBytes: 4 * GIB, totalBytes: 80 * GIB, status: "warning" },
    { availableBytes: 500 * MIB, totalBytes: GIB, status: "ok" },
    { availableBytes: 6 * GIB, totalBytes: 100 * GIB, status: "ok" },
  ] as const)("classifies $status pressure at $availableBytes available", async (sample) => {
    const harness = createHarness(async () => result(sample.availableBytes, sample.totalBytes));

    await harness.monitor.sweep();

    expect(harness.monitor.read(harness.placement)?.status).toBe(sample.status);
  });

  it("advances the projection fence when an observation loses its active placement", async () => {
    const harness = createHarness();

    await harness.monitor.sweep();
    expect(harness.monitor.version()).toBe(1);

    harness.setPlacement({ ...activePlacement(), state: "draining" });
    await harness.monitor.sweep();
    expect(harness.monitor.nextSweepAtMs()).toBe(Infinity);

    expect(harness.monitor.read(harness.placement)).toBeUndefined();
    expect(harness.monitor.version()).toBe(2);

    await harness.monitor.sweep();
    expect(harness.monitor.version()).toBe(2);
  });

  it("probes and warns once per stale worker build binding", async () => {
    const harness = createHarness();
    harness.startTunnel.mockRejectedValue(new StaleWorkerBuildError());

    for (const binding of [1, 2]) {
      if (binding === 2) {
        harness.setPlacement(activePlacement({ generation: 4, activeOwnerEpoch: 8 }));
      }
      await harness.sweep();
      expect(harness.monitor.nextSweepAtMs()).toBe(Infinity);
      await harness.sweep();
      if (binding === 1) {
        await harness.sweep();
      }
      expect(harness.warn).toHaveBeenCalledTimes(binding);
      expect(harness.startTunnel).toHaveBeenCalledTimes(binding);
    }
  });

  it.each(["worker-turn", "remote-exec"] as const)(
    "pauses offline %s device probes and records a fresh sample after reconnect",
    async (executionMode) => {
      let availableBytes = 400 * MIB;
      const harness = createHarness(async () => result(availableBytes, 10 * GIB));
      harness.setPlacement(activePlacement({ executionMode }));
      await harness.monitor.sweep();
      const previous = harness.monitor.read(harness.placement);

      harness.setRunnerStatus("offline");
      availableBytes = 6 * GIB;
      await harness.monitor.sweep();
      await harness.monitor.sweep();

      expect(harness.startTunnel).toHaveBeenCalledTimes(1);
      expect(harness.monitor.read(harness.placement)).toEqual(previous);
      expect(harness.monitor.version()).toBe(1);

      harness.setRunnerStatus("available");
      await harness.monitor.sweep();

      expect(harness.startTunnel).toHaveBeenCalledTimes(2);
      expect(harness.monitor.read(harness.placement)).toMatchObject({
        status: "ok",
        availableBytes,
      });
      expect(harness.monitor.version()).toBe(2);
      expect(harness.warn).not.toHaveBeenCalled();
    },
  );

  it("keeps the last exact-binding sample and warns on every failed advisory probe", async () => {
    let fail = false;
    const harness = createHarness(async () =>
      fail
        ? {
            ...result(0, 0),
            code: 1,
          }
        : result(400 * MIB, 10 * GIB),
    );
    await harness.monitor.sweep();
    fail = true;
    harness.advanceTime(15 * 60_000);

    await harness.monitor.sweep();
    harness.advanceTime(60_000);
    await harness.monitor.sweep();

    expect(harness.monitor.read(harness.placement)?.status).toBe("warning");
    expect(harness.monitor.version()).toBe(1);
    expect(harness.warn).toHaveBeenCalledTimes(2);
    expect(harness.warn).toHaveBeenCalledWith(
      expect.stringContaining("Worker disk-space check command failed"),
    );
  });

  it("parks an empty inventory until a placement receipt and retains receipts during reads", async () => {
    const harness = createHarness();
    harness.setPlacement({ ...activePlacement(), state: "draining" });
    await harness.monitor.sweep();
    harness.advanceTime(24 * 60 * 60_000);
    await harness.monitor.sweep();
    expect(harness.prepareMaintenancePlacements).toHaveBeenCalledTimes(1);

    harness.setPlacement(activePlacement());
    harness.prepareMaintenancePlacements.mockImplementationOnce(async () => {
      harness.setPlacement(activePlacement());
      return { placements: [], assertCurrent() {}, release: harness.releaseInventory };
    });
    await harness.monitor.sweep();
    expect(harness.monitor.nextSweepAtMs()).toBe(1_000 + 24 * 60 * 60_000 + 60_000);
    await harness.monitor.sweep();
    expect(harness.monitor.read(harness.placement)?.status).toBe("ok");
    expect(harness.startTunnel).toHaveBeenCalledOnce();
  });
});
