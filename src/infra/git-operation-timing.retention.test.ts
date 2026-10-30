import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "./diagnostic-events.js";
import { startGitOperationTiming } from "./git-operation-timing.js";

it("releases completed caller data while the diagnostic quota remains live", async () => {
  const key = Symbol.for("openclaw.worktreeRemovalDiagnostics");
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  const diagnosticsEnabled = areDiagnosticsEnabledForProcess();
  Reflect.deleteProperty(globalThis, key);
  let clock = 120_000;
  const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const observed: number[] = [];
  const log = {
    isEnabled: () => true,
    info: (_message: string, fields?: Record<string, unknown>) => {
      observed.push(Number(fields?.bytes));
    },
  };
  function completeOperation() {
    const caller = { bytes: Buffer.alloc(1024) };
    const reference = new WeakRef(caller);
    const timing = startGitOperationTiming("worktree-removal", log, () => ({
      bytes: caller.bytes.length,
    }));
    clock += 1_100;
    timing?.finish("returned");
    return reference;
  }
  try {
    setDiagnosticsEnabledForProcess(true);
    const reference = completeOperation();
    expect(observed).toEqual([1024]);
    const control = new WeakRef({});
    // WeakRef targets stay alive until their creation job ends.
    await nextTurn();
    queryObjects(WeakRef);
    expect(control.deref()).toBeUndefined();
    expect(reference.deref()).toBeUndefined();
    completeOperation();
    expect(observed).toEqual([1024, 1024]);
  } finally {
    clockSpy.mockRestore();
    setDiagnosticsEnabledForProcess(diagnosticsEnabled);
    if (previous) {
      Object.defineProperty(globalThis, key, previous);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});
