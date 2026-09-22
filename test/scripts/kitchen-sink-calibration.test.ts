import { describe, expect, it } from "vitest";
import {
  calibrateKitchenSinkResources,
  KITCHEN_RESOURCE_CONTROLS,
} from "../../scripts/e2e/lib/kitchen-sink-calibration.mts";
import type { GatewayResourceSnapshot } from "../../scripts/lib/gateway-bench-profile.js";

function fixture() {
  let sampleIndex = 0;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const state = {
    active: true,
    bufferBytes: 0,
    timerActive: false,
    timerIntervalMs: 0,
    timerTicks: 0,
    lastCpu: null as null | { iterations: number; checksum: number },
  };
  const reset = () =>
    Object.assign(state, {
      bufferBytes: 0,
      timerActive: false,
      timerIntervalMs: 0,
      timerTicks: 0,
      lastCpu: null,
    });
  return {
    pluginId: "fixture",
    calls,
    state,
    rpc: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "plugins.setEnabled") {
        expect(state.bufferBytes).toBe(KITCHEN_RESOURCE_CONTROLS.bytes);
        expect(state.timerActive).toBe(true);
        reset();
        state.active = false;
        return {
          ok: true,
          restartRequired: false,
          runtime: { operationId: "disable-1", generation: 2, pluginIds: ["fixture"] },
        };
      }
      if (method === "plugins.list") {
        return { active: [] };
      }
      expect(method).toBe("kitchen.resources");
      switch (params.action) {
        case "cpu":
          state.lastCpu = { iterations: Number(params.iterations), checksum: 633_235_013 };
          break;
        case "buffer":
          expect(state.bufferBytes).toBe(0);
          state.bufferBytes = Number(params.bytes);
          break;
        case "timer":
          expect(state.timerActive).toBe(false);
          state.timerActive = true;
          state.timerIntervalMs = Number(params.intervalMs);
          break;
        case "reset":
          reset();
          break;
        default:
          if (state.timerActive) {
            state.timerTicks++;
          }
      }
      return structuredClone(state);
    },
    sample: async (): Promise<GatewayResourceSnapshot> => {
      sampleIndex++;
      return {
        pid: 123,
        atMonotonicMicros: sampleIndex * 1_000,
        process: { user: sampleIndex * 100, system: 0 },
        mainThread: { user: sampleIndex * 100, system: 0 },
        memory: {
          rss: 100 + state.bufferBytes,
          heapTotal: 100,
          heapUsed: 100,
          external: state.bufferBytes,
          arrayBuffers: state.bufferBytes,
        },
        activeResources: { Timeout: state.timerActive ? 2 : 1 },
        runtime: { node: "26.1.0", platform: "linux", arch: "x64" },
      };
    },
    assertDisabled: (payload: unknown) => {
      expect(payload).toEqual({ active: [] });
    },
  };
}

describe("Kitchen Sink resource calibration", () => {
  it("asserts CPU, allocation, ticking, reset and retirement with resources held", async () => {
    const setup = fixture();
    const result = await calibrateKitchenSinkResources(setup);
    expect(result.status, result.error).toBe("exercised");
    expect(result.phases.map(({ name }) => name)).toEqual([
      "control-status",
      "control-cpu",
      "control-buffer",
      "control-timer",
      "control-reset",
      "control-reacquire",
      "plugin-disable",
    ]);
    expect(
      result.phases.every(
        ({ operations }) => operations.completed === 1 && operations.failed === 0,
      ),
    ).toBe(true);
    expect(Object.values(result.signals).every(({ status }) => status === "observed")).toBe(true);
    expect(result.states.reset).toMatchObject({
      bufferBytes: 0,
      timerActive: false,
      lastCpu: null,
    });
    expect(result.states.stopTimer).toMatchObject({
      bufferBytes: KITCHEN_RESOURCE_CONTROLS.bytes,
      timerActive: true,
    });
    expect(result.runtime).toEqual({
      operationId: "disable-1",
      generation: 2,
      pluginIds: ["fixture"],
    });
    expect(result.postDisposalResidual.status).toBe("observed");
    expect(setup.calls.at(-2)).toEqual({
      method: "plugins.setEnabled",
      params: { pluginId: "fixture", enabled: false },
    });
    expect(setup.calls.at(-1)?.method).toBe("plugins.list");
  });

  it("keeps obscured signals inconclusive without changing completed workload receipts", async () => {
    const setup = fixture();
    const sample = setup.sample;
    setup.sample = async () => ({
      ...(await sample()),
      memory: { rss: 100, heapTotal: 100, heapUsed: 100, external: 0, arrayBuffers: 0 },
      activeResources: { Timeout: 5 },
    });
    const result = await calibrateKitchenSinkResources(setup);
    expect(result.status, result.error).toBe("exercised");
    for (const name of ["heldBuffer", "referencedTimer", "timerRetirement"]) {
      expect(result.signals[name]).toMatchObject({ status: "inconclusive", value: 0 });
    }
  });

  it("rejects a wrong checksum without retrying CPU work or reaching disable", async () => {
    const setup = fixture();
    const rpc = setup.rpc;
    setup.rpc = async (method, params) => {
      const result = await rpc(method, params);
      return params.action === "cpu"
        ? {
            ...setup.state,
            lastCpu: { iterations: KITCHEN_RESOURCE_CONTROLS.iterations, checksum: 0 },
          }
        : result;
    };
    const result = await calibrateKitchenSinkResources(setup);
    expect(result.status).toBe("failed");
    expect(result.phases.at(-1)).toMatchObject({
      name: "control-cpu",
      operations: { attempted: 1, completed: 0, failed: 1 },
    });
    expect(setup.calls.filter(({ params }) => params.action === "cpu")).toHaveLength(1);
    expect(setup.calls.some(({ method }) => method === "plugins.setEnabled")).toBe(false);
  });

  it.each([
    { warnings: ["cleanup deferred"] },
    { restartRequired: true },
    { runtime: { operationId: "", generation: 2, pluginIds: ["fixture"] } },
    { runtime: { operationId: "disable-1", generation: 2, pluginIds: [] } },
  ])("rejects incomplete retirement while preserving its receipt: %j", async (replacement) => {
    const setup = fixture();
    const rpc = setup.rpc;
    setup.rpc = async (method, params) => {
      const receipt = await rpc(method, params);
      return method === "plugins.setEnabled" ? { ...(receipt as object), ...replacement } : receipt;
    };
    const result = await calibrateKitchenSinkResources(setup);
    expect(result.status).toBe("failed");
    expect(result.disableReceipt).toMatchObject(replacement);
    expect(result.postDisposalResidual.status).toBe("unsupported");
    expect(setup.calls.at(-1)?.method).toBe("plugins.setEnabled");
  });

  it.each(["changed-pid", "missing-sample", "still-active"])(
    "does not claim post-disposal observation after %s",
    async (failure) => {
      const setup = fixture();
      const sample = setup.sample;
      setup.sample = async () => {
        if (!setup.state.active && failure === "missing-sample") {
          throw new Error("child disconnected");
        }
        const value = await sample();
        return !setup.state.active && failure === "changed-pid" ? { ...value, pid: 456 } : value;
      };
      if (failure === "still-active") {
        setup.assertDisabled = () => {
          throw new Error("fixture still active");
        };
      }
      const result = await calibrateKitchenSinkResources(setup);
      expect(result.status).toBe("failed");
      expect(result.postDisposalResidual.status).toBe("unsupported");
      expect(result.phases.at(-1)?.status).toBe("failed");
      expect(result.runtime?.operationId).toBe("disable-1");
    },
  );
});
