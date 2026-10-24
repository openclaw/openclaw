import { expect, it } from "vitest";
import {
  calibrateKitchenSinkResources,
  KITCHEN_RESOURCE_CONTROLS as controls,
} from "../../scripts/e2e/lib/kitchen-sink-calibration.mts";
import type { GatewayResourceSnapshot } from "../../scripts/lib/gateway-bench-profile.js";

function fixture({ obscured = false, failure = "", checksum = 633_235_013, disable = {} } = {}) {
  let sampleIndex = 0;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const empty = {
    bufferBytes: 0,
    timerActive: false,
    timerIntervalMs: 0,
    timerTicks: 0,
    lastCpu: null as null | { iterations: number; checksum: number },
  };
  const state = { active: true, ...empty };
  const memory = { rss: 100, heapTotal: 100, heapUsed: 100, external: 0, arrayBuffers: 0 };
  const reset = () => Object.assign(state, empty);
  return {
    pluginId: "fixture",
    calls,
    rpc: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "plugins.setEnabled") {
        expect(state).toMatchObject({ bufferBytes: controls.bytes, timerActive: true });
        reset();
        state.active = false;
        return {
          ok: true,
          restartRequired: false,
          runtime: { operationId: "disable-1", generation: 2, pluginIds: ["fixture"] },
          ...disable,
        };
      }
      if (method === "plugins.list") {
        return { active: [] };
      }
      expect(method).toBe("kitchen.resources");
      switch (params.action) {
        case "cpu":
          state.lastCpu = {
            iterations: checksum === 0 ? controls.iterations : Number(params.iterations),
            checksum,
          };
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
      if (!state.active && failure === "missing-sample") {
        throw new Error("child disconnected");
      }
      const held = obscured ? 0 : state.bufferBytes;
      return {
        pid: !state.active && failure === "changed-pid" ? 456 : 123,
        atMonotonicMicros: ++sampleIndex * 1_000,
        process: { user: sampleIndex * 100, system: 0 },
        mainThread: { user: sampleIndex * 100, system: 0 },
        memory: { ...memory, rss: 100 + held, external: held, arrayBuffers: held },
        heapSpaces: [],
        activeResources: { Timeout: obscured ? 5 : state.timerActive ? 2 : 1 },
        runtime: { node: "26.1.0", platform: "linux", arch: "x64" },
      };
    },
    assertDisabled: (payload: unknown) => {
      if (failure === "still-active") {
        throw new Error("fixture still active");
      }
      expect(payload).toEqual({ active: [] });
    },
  };
}

it.each([false, true])("calibrates held resources with obscured signals=%s", async (obscured) => {
  const setup = fixture({ obscured });
  const result = await calibrateKitchenSinkResources(setup);
  expect(result.status, result.error).toBe("exercised");
  expect(result.phases.map(({ name }) => name)).toEqual([
    ...["status", "cpu", "buffer", "timer", "reset", "reacquire"].map((n) => `control-${n}`),
    "plugin-disable",
  ]);
  if (obscured) {
    for (const name of ["heldBuffer", "referencedTimer", "timerRetirement"]) {
      expect(result.signals[name]).toMatchObject({ status: "inconclusive", value: 0 });
    }
  } else {
    expect(Object.values(result.signals).every(({ status }) => status === "observed")).toBe(true);
  }
  expect(result).toMatchObject({
    states: {
      reset: { bufferBytes: 0, timerActive: false, lastCpu: null },
      stopTimer: { bufferBytes: controls.bytes, timerActive: true },
    },
    postDisposalResidual: { status: "observed" },
  });
  const { runtime } = result;
  expect(runtime).toEqual({ operationId: "disable-1", generation: 2, pluginIds: ["fixture"] });
  expect(setup.calls.at(-2)).toEqual({
    method: "plugins.setEnabled",
    params: { pluginId: "fixture", enabled: false },
  });
  expect(setup.calls.at(-1)?.method).toBe("plugins.list");
});

it("rejects a wrong checksum without retrying CPU work or reaching disable", async () => {
  const setup = fixture({ checksum: 0 });
  const result = await calibrateKitchenSinkResources(setup);
  expect(result).toMatchObject({ status: "failed" });
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
  const setup = fixture({ disable: replacement });
  expect(await calibrateKitchenSinkResources(setup)).toMatchObject({
    status: "failed",
    disableReceipt: replacement,
    postDisposalResidual: { status: "unsupported" },
  });
  expect(setup.calls.at(-1)?.method).toBe("plugins.setEnabled");
});

it.each(["changed-pid", "missing-sample", "still-active"])("rejects %s", async (failure) => {
  const setup = fixture({ failure });
  const result = await calibrateKitchenSinkResources(setup);
  expect(result).toMatchObject({
    status: "failed",
    postDisposalResidual: { status: "unsupported" },
    runtime: { operationId: "disable-1" },
  });
  expect(result.phases.at(-1)?.status).toBe("failed");
});
