import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { startSlowRequestDiagnostics } from "./slow-request-diagnostics.js";

let previousDiagnostics: boolean;
beforeEach(() => {
  previousDiagnostics = areDiagnosticsEnabledForProcess();
});
afterEach(() => {
  setDiagnosticsEnabledForProcess(previousDiagnostics);
  vi.restoreAllMocks();
});

test.each(["disabled", "muted", "fast", "slow"])("slow request diagnostics: %s", (mode) => {
  setDiagnosticsEnabledForProcess(mode !== "disabled");
  let clock = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const log = { isEnabled: () => mode !== "muted", warn: vi.fn() };
  {
    using diagnostics = startSlowRequestDiagnostics(log, "slow request", "test", "setup");
    expect(Boolean(diagnostics)).toBe(mode !== "disabled" && mode !== "muted");
    clock = mode === "slow" ? 1_000 : 999.9;
  }
  expect(log.warn).toHaveBeenCalledTimes(mode === "slow" ? 1 : 0);
  if (mode === "disabled" || mode === "muted") {
    expect(now).not.toHaveBeenCalled();
  }
});

test("failed requests sum repeated waits and keep their trace even when the sink throws", () => {
  setDiagnosticsEnabledForProcess(true);
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const trace = createDiagnosticTraceContext();
  const warn = vi.fn(() => {
    expect(getActiveDiagnosticTraceContext()).toBe(trace);
    throw new Error("sink failed");
  });
  const failure = new Error("request failed");
  expect(() => {
    using diagnostics = runWithDiagnosticTraceContext(trace, () =>
      startSlowRequestDiagnostics<string>(
        { isEnabled: () => true, warn },
        "slow request",
        "test",
        "accessFacts",
      ),
    );
    clock = 600;
    diagnostics?.mark("projectionReadiness");
    clock = 800;
    diagnostics?.mark("accessFacts");
    clock = 1_200;
    throw failure;
  }).toThrow(failure);
  expect(warn).toHaveBeenCalledExactlyOnceWith("slow request", {
    operation: "test",
    elapsedMs: 1_200,
    phaseDurationsMs: { accessFacts: 1_000, projectionReadiness: 200 },
  });
});
