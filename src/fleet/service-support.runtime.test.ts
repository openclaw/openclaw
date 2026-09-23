import { afterEach, describe, expect, it, vi } from "vitest";
import { FLEET_ATTEMPT_LABEL } from "./cell-profile.js";
import type { FleetContainerRuntime } from "./containers.runtime.js";
import type { FleetCellRecord } from "./registry.js";

const { acquire } = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("./registry.js", () => ({ withFleetCellOperationLease: acquire }));

import { verifyReplacementHealthy, withFleetCellOperation } from "./service-support.runtime.js";

const attemptId = "11111111111111111111111111111111";
const record: FleetCellRecord = {
  tenantId: "acme",
  createdAtMs: 0,
  image: "openclaw:test",
  runtime: "docker",
  hostPort: 19100,
  containerName: "openclaw-acme",
  dataDir: "/tmp/openclaw-acme",
};

function runningContainers(onInspect?: () => void): {
  inspect: ReturnType<typeof vi.fn>;
  runtime: FleetContainerRuntime;
} {
  const inspect = vi.fn(async () => {
    onInspect?.();
    return {
      kind: "ok" as const,
      containerId: "container-id",
      state: "running",
      running: true,
      labels: { [FLEET_ATTEMPT_LABEL]: attemptId },
      environment: {},
      imageId: "sha256:test",
      memory: "1073741824",
      cpus: "1",
      pidsLimit: 128,
      storageOpt: {},
      capDrop: ["ALL"],
      effectiveCaps: undefined,
      securityOpt: ["no-new-privileges"],
      init: true,
      restartPolicy: "unless-stopped",
      portBindings: [],
    };
  });
  return { inspect, runtime: { inspect } as unknown as FleetContainerRuntime };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("fleet operation lifecycle", () => {
  it("awaits acquisition, checkpoints, timer renewal, and release before reporting success", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    acquire.mockImplementation(async (_params, operation) => {
      await Promise.resolve();
      events.push("acquired");
      const lease = {
        owner: "fixture-owner",
        heartbeat: async () => {
          await Promise.resolve();
          events.push("renewed");
        },
        release: async () => {
          await Promise.resolve();
          events.push("released");
        },
      };
      try {
        return await operation(lease);
      } finally {
        await lease.release();
      }
    });

    const result = await withFleetCellOperation({
      env: {},
      tenantId: "fixture",
      operationName: "start",
      operation: async (checkpoint) => {
        await checkpoint();
        events.push("effect");
        await vi.advanceTimersByTimeAsync(60_000);
        events.push("completed");
        return "started";
      },
    });

    expect(result).toBe("started");
    expect(events).toEqual([
      "acquired",
      "renewed",
      "effect",
      "renewed",
      "completed",
      "renewed",
      "released",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("replacement health verification", () => {
  it("bounds container inspection by the remaining verification timeout", async () => {
    const containers = runningContainers();

    await verifyReplacementHealthy({
      containers: containers.runtime,
      record,
      attemptId,
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })),
      now: () => 0,
      sleep: async () => {},
      checkpoint: vi.fn(),
      timeoutMs: 1_000,
      pollMs: 2_000,
      context: "create",
    });

    expect(containers.inspect).toHaveBeenCalledWith("docker", "openclaw-acme", {
      timeoutMs: 1_000,
    });
  });

  it("rejects a healthy probe that completes at the deadline", async () => {
    let now = 0;
    const checkpoint = vi.fn();

    await expect(
      verifyReplacementHealthy({
        containers: runningContainers().runtime,
        record,
        attemptId,
        fetchImpl: vi.fn(async () => {
          now = 1_000;
          return new Response(null, { status: 200 });
        }),
        now: () => now,
        sleep: async () => {},
        checkpoint,
        timeoutMs: 1_000,
        pollMs: 2_000,
        context: "upgrade",
      }),
    ).rejects.toThrow("Replacement cell container did not become healthy after upgrade.");
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("clamps polling to the budget remaining after the awaited checkpoint", async () => {
    const sleeps: number[] = [];
    let now = 0;
    let inspections = 0;
    const containers = runningContainers(() => {
      inspections += 1;
      now = 500;
    });

    await expect(
      verifyReplacementHealthy({
        containers: containers.runtime,
        record,
        attemptId,
        fetchImpl: vi.fn(async () => new Response(null, { status: 503 })),
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        checkpoint: async () => {
          await Promise.resolve();
          now = 900;
        },
        timeoutMs: 1_000,
        pollMs: 2_000,
        context: "upgrade",
      }),
    ).rejects.toThrow("Replacement cell container did not become healthy after upgrade.");

    expect(sleeps).toEqual([100]);
    expect(inspections).toBe(1);
  });

  it("clamps a stalled health probe to the remaining verification timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("probe aborted")), {
          once: true,
        });
      });
    });
    const verification = verifyReplacementHealthy({
      containers: runningContainers(() => vi.setSystemTime(500)).runtime,
      record,
      attemptId,
      fetchImpl,
      now: () => Date.now(),
      sleep: async () => {},
      checkpoint: vi.fn(),
      timeoutMs: 1_000,
      pollMs: 2_000,
      context: "restore",
    });
    const rejection = expect(verification).rejects.toThrow(
      "Replacement cell container did not become healthy after restore.",
    );

    for (let attempt = 0; attempt < 20 && setTimeoutSpy.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(500);
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
  });
});
