import { performance } from "node:perf_hooks";
import { beforeEach, expect, test, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { startCronListDiagnostics } from "./cron-list-diagnostics.js";

let clock = 0;
const warn = vi.fn();
const readClock = vi.fn(() => clock);
beforeEach(() => {
  const previousDiagnostics = areDiagnosticsEnabledForProcess();
  clock = 0;
  warn.mockReset();
  readClock.mockClear();
  setDiagnosticsEnabledForProcess(true);
  vi.spyOn(performance, "now").mockImplementation(readClock);
  return () => {
    setDiagnosticsEnabledForProcess(previousDiagnostics);
    vi.restoreAllMocks();
  };
});

const start = () => startCronListDiagnostics({ warn }, vi.fn())!;

test("disabled cron list diagnostics do not start clocks", () => {
  setDiagnosticsEnabledForProcess(false);
  expect(startCronListDiagnostics({ warn }, vi.fn())).toBeUndefined();
  expect(readClock).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

test.each([999.9, 1_000])("cron list warning threshold uses raw elapsed time: %s", (elapsed) => {
  const diagnostics = start();
  clock = elapsed;
  diagnostics.finish("returned");
  expect(warn).toHaveBeenCalledTimes(elapsed >= 1_000 ? 1 : 0);
});

test("cron list diagnostics close unfinished work once and retire later marks", () => {
  const diagnostics = start();
  clock = 100;
  diagnostics.mark("listing");
  clock = 1_100;
  diagnostics.finish("threw");
  clock = 9_000;
  diagnostics.mark("previews");
  diagnostics.finish("returned");
  expect(warn).toHaveBeenCalledExactlyOnceWith("cron: slow list request", {
    operation: "cron.list",
    elapsedMs: 1_100,
    phaseDurationsMs: { setup: 100, listing: 1_000 },
    sourcePageMs: 0,
    sourcePageCount: 0,
    scopeAttemptCount: 0,
    handlerOutcome: "threw",
    responseOutcome: "none",
  });
});

test("disabling diagnostics during a cron request cannot publish its summary later", () => {
  const diagnostics = start();
  clock = 2_000;
  setDiagnosticsEnabledForProcess(false);
  diagnostics.finish("returned");
  setDiagnosticsEnabledForProcess(true);
  diagnostics.finish("returned");
  expect(warn).not.toHaveBeenCalled();
});

test.each([true, false])("cron diagnostics preserve captured trace presence: %s", (bound) => {
  const original = bound ? createDiagnosticTraceContext() : undefined;
  warn.mockImplementation(getActiveDiagnosticTraceContext);
  const diagnostics = runWithDiagnosticTraceContext(original, start);
  clock = 1_500;
  runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () =>
    diagnostics.finish("returned"),
  );
  expect(warn.mock.results).toEqual([{ type: "return", value: original }]);
});
