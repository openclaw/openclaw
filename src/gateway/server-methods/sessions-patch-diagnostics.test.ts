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

test.each([999.9, 1_000])(
  "disabled process diagnostics still report patches at the 1s threshold (%sms)",
  (elapsedMs) => {
    diagnostics.scope("preflight");
    at(elapsedMs, diagnostics.finish);
    if (elapsedMs < 1_000) {
      expect(log).not.toHaveBeenCalled();
    } else {
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "slow session patch 1000ms method=sessions.patch preflight=1000ms",
      );
    }
  },
);

test("parallel and repeated phases retain separate elapsed contributions and bounded fields", () => {
  diagnostics = startSessionPatchDiagnostics("sessions.patchMany");
  const first = expectDefined(diagnostics.scope("catalog"), "active catalog phase");
  const second = expectDefined(diagnostics.scope("catalog"), "active catalog phase");
  at(600, second.finish);
  at(1_400, first.finish);
  const group = expectDefined(diagnostics.scope("snapshot"), "active snapshot phase");
  at(1_500, () => group.mark("projection"));
  at(1_600, () => group.mark("snapshot"));
  at(1_800, group.finish);
  diagnostics.finish();
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "slow session patch 1800ms method=sessions.patchMany snapshot=300ms projection=100ms catalog=2000ms",
  );
});

test("request settlement closes unfinished phases and retires retained markers", () => {
  const scope = expectDefined(diagnostics.scope("preflight"), "active preflight phase");
  at(1_500, diagnostics.finish);
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
  const operation = () => {
    diagnostics.scope("preflight");
    try {
      clock = 1_500;
      throw originalError;
    } finally {
      diagnostics.finish();
    }
  };
  expect(operation).toThrow(originalError);
});

test("archive timing separates placement, runtime selection, commit, and cron effects", () => {
  const group = expectDefined(diagnostics.scope("snapshot"), "archive snapshot");
  at(100, () => group.mark("projection"));
  at(200, () => group.mark("runtimeSelection"));
  at(500, () => group.mark("archivePlacement"));
  at(900, () => group.mark("commit"));
  at(1_000, group.finish);
  const effects = expectDefined(diagnostics.scope("effects"), "archive effects");
  const cron = expectDefined(diagnostics.scope("cronEffects"), "archive cron effects");
  at(1_500, cron.finish);
  effects.finish();
  diagnostics.finish();
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "slow session patch 1500ms method=sessions.patch snapshot=100ms projection=100ms runtimeSelection=300ms archivePlacement=400ms commit=100ms effects=500ms cronEffects=500ms",
  );
});
