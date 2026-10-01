import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import { sessionLog } from "./server-methods/sessions-shared.js";
import { startSessionCreateDiagnostics } from "./session-create-diagnostics.js";

let previousDiagnostics: boolean;
beforeEach(() => {
  previousDiagnostics = areDiagnosticsEnabledForProcess();
});
afterEach(() => {
  setDiagnosticsEnabledForProcess(previousDiagnostics);
  vi.restoreAllMocks();
});

test("disabled creation diagnostics do not start a clock", () => {
  setDiagnosticsEnabledForProcess(false);
  const clock = vi.spyOn(performance, "now");
  expect(startSessionCreateDiagnostics()).toBeUndefined();
  expect(clock).not.toHaveBeenCalled();
});

test("creation failures retain phase totals without letting logging replace the error", () => {
  setDiagnosticsEnabledForProcess(true);
  vi.spyOn(sessionLog, "isEnabled").mockReturnValue(true);
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const log = vi.spyOn(sessionLog, "warn").mockImplementation(() => {
    throw new Error("sink unavailable");
  });
  const failure = new Error("creation failed");
  expect(() => {
    using diagnostics = startSessionCreateDiagnostics();
    now = 20;
    diagnostics?.mark("admission");
    now = 1_120;
    diagnostics?.mark("entry");
    now = 1_140;
    diagnostics?.mark("admission");
    now = 1_240;
    throw failure;
  }).toThrow(failure);
  expect(log).toHaveBeenCalledExactlyOnceWith("slow session create", {
    elapsedMs: 1_240,
    phaseDurationsMs: { preflight: 20, admission: 1_200, entry: 20 },
  });
});
