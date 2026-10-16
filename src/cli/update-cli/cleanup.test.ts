import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  inspectSessionSqliteRecovery,
  type RecoveryCleanupReport,
} from "../../commands/doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "../../commands/doctor-session-sqlite-retirement.js";
import { DoctorSqliteMaintenanceLockUnavailableError } from "../../commands/doctor-sqlite-maintenance-lock.js";
import { readSourceConfigBestEffort } from "../../config/io.js";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { GatewayStateOwnerContentionError } from "../../infra/gateway-state-owner.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { updateCleanupCommand } from "./cleanup.js";

vi.mock("../../commands/doctor-session-sqlite-recovery-inventory.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../commands/doctor-session-sqlite-recovery-inventory.js")
  >()),
  inspectSessionSqliteRecovery: vi.fn(),
}));
vi.mock("../../commands/doctor-session-sqlite-retirement.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/doctor-session-sqlite-retirement.js")>()),
  retireSessionSqliteRecovery: vi.fn(),
}));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  readSourceConfigBestEffort: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readSourceConfigBestEffort).mockResolvedValue({});
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it.each(["refused", "blocked"] as const)(
  "preserves one reported %s cleanup result while unwinding its exit",
  async (status) => {
    const report: RecoveryCleanupReport = {
      stateDir: "/fixture/state",
      missingOriginals: 0,
      artifacts: [
        {
          path: "/fixture/original",
          runs: [],
          bytes: 7,
          outcome: "candidate",
          reason: "retained",
        },
      ],
      totals: {
        candidateBytes: 7,
        verificationRequiredBytes: 0,
        protectedBytes: 0,
        blockedBytes: 0,
        removedBytes: 0,
        removedFiles: 0,
      },
      status: "preview",
    };
    vi.mocked(inspectSessionSqliteRecovery).mockReturnValue(report);
    vi.mocked(retireSessionSqliteRecovery).mockResolvedValue({ ...report, status: "blocked" });

    await expect(updateCleanupCommand({ json: true, yes: status === "blocked" })).rejects.toEqual(
      new ExitError(1),
    );

    expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
      { ...report, status, dryRun: false },
      2,
    );
    expect(retireSessionSqliteRecovery).toHaveBeenCalledTimes(status === "blocked" ? 1 : 0);
    expect(vi.mocked(defaultRuntime.error).mock.calls.flat().join("\n")).not.toContain("exit 1");
  },
);

it("still reports a genuine cleanup error once as blocked", async () => {
  vi.mocked(readSourceConfigBestEffort).mockRejectedValueOnce(new Error("inventory unavailable"));
  await expect(updateCleanupCommand({ json: true })).rejects.toEqual(new ExitError(1));
  expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
    { status: "blocked", error: "Error: inventory unavailable" },
    2,
  );
  expect(retireSessionSqliteRecovery).not.toHaveBeenCalled();
});

it.each([
  new GatewayStateOwnerContentionError("/fixture/state/openclaw.sqlite"),
  new DoctorSqliteMaintenanceLockUnavailableError(
    "update recovery cleanup",
    new GatewayLockError("Gateway is running"),
  ),
])("reports stop-first guidance on cleanup contention: %s", async (error) => {
  vi.mocked(readSourceConfigBestEffort).mockRejectedValueOnce(error);
  vi.stubEnv("OPENCLAW_PROFILE", "work");
  try {
    await expect(updateCleanupCommand({ json: true, yes: true })).rejects.toEqual(new ExitError(1));
    expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
      {
        status: "blocked",
        error: "Error: Stop the Gateway first (openclaw --profile work gateway stop), then retry.",
      },
      2,
    );
    expect(retireSessionSqliteRecovery).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});
