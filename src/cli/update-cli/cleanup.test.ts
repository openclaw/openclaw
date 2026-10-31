import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  inspectSessionSqliteRecovery,
  summarizeRecoveryCleanup,
} from "../../commands/doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "../../commands/doctor-session-sqlite-retirement.js";
import { DoctorSqliteMaintenanceLockUnavailableError } from "../../commands/doctor-sqlite-maintenance-lock.js";
import { readSourceConfigBestEffort } from "../../config/io.js";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { GatewayStateOwnerContentionError } from "../../infra/gateway-state-owner.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { updateCleanupCommand } from "./cleanup.js";

vi.mock(import("../../commands/doctor-session-sqlite-recovery-inventory.js"), async (original) => ({
  ...(await original()),
  inspectSessionSqliteRecovery: vi.fn(),
}));
vi.mock(import("../../commands/doctor-session-sqlite-retirement.js"), async (original) => ({
  ...(await original()),
  retireSessionSqliteRecovery: vi.fn(),
}));
vi.mock(import("../../config/io.js"), async (original) => ({
  ...(await original()),
  readSourceConfigBestEffort: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readSourceConfigBestEffort).mockResolvedValue({});
  vi.mocked(inspectSessionSqliteRecovery).mockReturnValue(cleanupReport());
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function cleanupReport(status: "preview" | "complete" = "preview") {
  return summarizeRecoveryCleanup(
    "/fixture/state",
    [{ path: "/fixture/original", runs: [], bytes: 7, outcome: "candidate", reason: "retained" }],
    status,
  );
}

function expectJson(result: unknown) {
  expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(result, 2);
}

it("streams progress before one final JSON result", async () => {
  const report = cleanupReport("complete");
  vi.mocked(retireSessionSqliteRecovery).mockImplementation(async ({ onProgress }) => {
    for (const phase of ["verifying", "claiming", "removing-capture"] as const) {
      onProgress?.({ phase, path: "/fixture/original", index: 1, total: 2, bytes: 42 });
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    }
    return report;
  });
  using stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  await updateCleanupCommand({ yes: true, json: true });

  expect(stderr.mock.calls.map(([text]) => text)).toEqual([
    "Verifying original 1/2: /fixture/original (42 bytes)\n",
    "Retiring original 1/2: /fixture/original (42 bytes)\n",
    "Removing capture 1/2: /fixture/original (42 bytes)\n",
  ]);
  expectJson({ ...report, dryRun: false });
});

it.each(["refused", "blocked"] as const)("reports %s once", async (status) => {
  const report = cleanupReport();
  vi.mocked(retireSessionSqliteRecovery).mockResolvedValue({ ...report, status: "blocked" });

  await expect(updateCleanupCommand({ json: true, yes: status === "blocked" })).rejects.toEqual(
    new ExitError(1),
  );

  expectJson({ ...report, status, dryRun: false });
  expect(retireSessionSqliteRecovery).toHaveBeenCalledTimes(status === "blocked" ? 1 : 0);
  expect(vi.mocked(defaultRuntime.error).mock.calls.flat().join("\n")).not.toContain("exit 1");
});

const stopFirst =
  "Error: Stop the Gateway first (openclaw --profile work gateway stop), then retry.";
it.each([
  [new Error("inventory unavailable"), "Error: inventory unavailable"],
  [new GatewayStateOwnerContentionError("/fixture/state/openclaw.sqlite"), stopFirst],
  [
    new DoctorSqliteMaintenanceLockUnavailableError(
      "update recovery cleanup",
      new GatewayLockError("Gateway is running"),
    ),
    stopFirst,
  ],
] as const)("reports cleanup failure once as blocked: %s", async (error, message) => {
  vi.mocked(readSourceConfigBestEffort).mockRejectedValueOnce(error);
  vi.stubEnv("OPENCLAW_PROFILE", "work");
  await expect(updateCleanupCommand({ json: true, yes: true })).rejects.toEqual(new ExitError(1));
  expectJson({ ok: false, status: "blocked", error: { type: "cli_error", message } });
  expect(retireSessionSqliteRecovery).not.toHaveBeenCalled();
});

it("keeps the inspected recovery report when retirement throws", async () => {
  const report = cleanupReport();
  vi.mocked(inspectSessionSqliteRecovery).mockReturnValue(report);
  vi.mocked(retireSessionSqliteRecovery).mockRejectedValueOnce(new Error("retirement unavailable"));

  await expect(updateCleanupCommand({ json: true, yes: true })).rejects.toEqual(new ExitError(1));

  expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
    {
      ...report,
      ok: false,
      status: "blocked",
      error: { type: "cli_error", message: "Error: retirement unavailable" },
    },
    2,
  );
  expect(defaultRuntime.error).not.toHaveBeenCalled();
});
