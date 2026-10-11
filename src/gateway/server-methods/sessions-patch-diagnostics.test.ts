import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { startSessionPatchDiagnostics } from "./sessions-patch-diagnostics.js";
import { sessionLog } from "./sessions-shared.js";

let previousDiagnostics: boolean;
let clock: number;
beforeEach(() => {
  previousDiagnostics = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(false);
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
  setDiagnosticsEnabledForProcess(previousDiagnostics);
  vi.restoreAllMocks();
});

test.each([999.9, 1_000])(
  "disabled process diagnostics still report patches at the 1s threshold (%sms)",
  (elapsedMs) => {
    const log = vi.spyOn(sessionLog, "info").mockImplementation(() => {});
    const diagnostics = startSessionPatchDiagnostics("sessions.patch");
    diagnostics.scope("preflight");
    clock = elapsedMs;
    diagnostics.finish();
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
  const log = vi.spyOn(sessionLog, "info").mockImplementation(() => {});
  const diagnostics = startSessionPatchDiagnostics("sessions.patchMany");
  const first = expectDefined(diagnostics.scope("catalog"), "active catalog phase");
  const second = expectDefined(diagnostics.scope("catalog"), "active catalog phase");
  clock = 600;
  second.finish();
  clock = 1_400;
  first.finish();
  const group = expectDefined(diagnostics.scope("snapshot"), "active snapshot phase");
  clock = 1_500;
  group.mark("projection");
  clock = 1_600;
  group.mark("snapshot");
  clock = 1_800;
  group.finish();
  diagnostics.finish();
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "slow session patch 1800ms method=sessions.patchMany snapshot=300ms projection=100ms catalog=2000ms",
  );
});

test("request settlement closes unfinished phases and retires retained markers", () => {
  const log = vi.spyOn(sessionLog, "info").mockImplementation(() => {});
  const diagnostics = startSessionPatchDiagnostics("sessions.patch");
  const scope = expectDefined(diagnostics.scope("preflight"), "active preflight phase");
  clock = 1_500;
  diagnostics.finish();
  clock = 3_000;
  scope.mark("catalog");
  scope.finish();
  expect(diagnostics.scope("effects")).toBeUndefined();
  diagnostics.finish();
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "slow session patch 1500ms method=sessions.patch preflight=1500ms",
  );
});

test("a failed diagnostic sink cannot replace the operation error", () => {
  vi.spyOn(sessionLog, "info").mockImplementation(() => {
    throw new Error("synthetic diagnostic sink failure");
  });
  const originalError = new Error("synthetic operation failure");
  const operation = () => {
    const diagnostics = startSessionPatchDiagnostics("sessions.patch");
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
