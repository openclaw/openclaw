import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, test, vi, type MockInstance } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { startSessionPatchDiagnostics } from "./sessions-patch-diagnostics.js";
import { sessionLog } from "./sessions-shared.js";

let previousDiagnostics: boolean;
let clock: number;
let log: MockInstance<typeof sessionLog.info>;
let diagnostics: ReturnType<typeof startSessionPatchDiagnostics>;
beforeEach(() => {
  previousDiagnostics = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(false);
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  log = vi.spyOn(sessionLog, "info").mockImplementation(() => {});
  diagnostics = startSessionPatchDiagnostics("sessions.patch");
});

function at(time: number, action: () => void) {
  clock = time;
  action();
}
afterEach(() => {
  setDiagnosticsEnabledForProcess(previousDiagnostics);
  vi.restoreAllMocks();
});

test.each([
  [999.9, []],
  [1_000, [["slow session patch 1000ms method=sessions.patch preflight=1000ms"]]],
] as const)(
  "disabled process diagnostics still report patches at the 1s threshold (%sms)",
  (elapsedMs, calls) => {
    diagnostics.scope("preflight");
    at(elapsedMs, () => diagnostics.finish());
    expect(log.mock.calls).toEqual(calls);
  },
);

test("records parallel, repeated, and archive phases independently in canonical order", () => {
  diagnostics = startSessionPatchDiagnostics("sessions.patchMany");
  const first = expectDefined(diagnostics.scope("catalog"), "active catalog phase");
  const second = expectDefined(diagnostics.scope("catalog"), "active catalog phase");
  const group = expectDefined(diagnostics.scope("snapshot"), "active snapshot phase");
  at(100, () => group.mark("projection"));
  at(200, () => group.mark("runtimeSelection"));
  at(500, () => group.mark("archivePlacement"));
  at(600, () => second.finish());
  at(900, () => group.mark("commit"));
  at(1_000, () => group.mark("snapshot"));
  at(1_300, () => group.finish());
  const effects = expectDefined(diagnostics.scope("effects"), "archive effects");
  const cron = expectDefined(diagnostics.scope("cronEffects"), "archive cron effects");
  at(1_400, () => first.finish());
  at(1_800, () => cron.finish());
  effects.finish();
  diagnostics.finish();
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "slow session patch 1800ms method=sessions.patchMany snapshot=400ms projection=100ms catalog=2000ms runtimeSelection=300ms archivePlacement=400ms commit=100ms effects=500ms cronEffects=500ms",
  );
});

test("request settlement closes unfinished phases and retires retained markers", () => {
  const scope = expectDefined(diagnostics.scope("preflight"), "active preflight phase");
  at(1_500, () => diagnostics.finish());
  at(3_000, () => scope.mark("catalog"));
  scope.finish();
  expect(diagnostics.scope("effects")).toBeUndefined();
  diagnostics.finish();
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "slow session patch 1500ms method=sessions.patch preflight=1500ms",
  );
});

test("a failed diagnostic sink cannot replace the operation error", () => {
  log.mockImplementation(() => {
    throw new Error("synthetic diagnostic sink failure");
  });
  const originalError = new Error("synthetic operation failure");
  expect(() => {
    diagnostics.scope("preflight");
    try {
      clock = 1_500;
      throw originalError;
    } finally {
      diagnostics.finish();
    }
  }).toThrow(originalError);
});
