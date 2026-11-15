import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runUpdateDoctorLintProcess } from "../../commands/doctor-lint-process.js";
import { buildUpdateRehearsalPathEnv } from "../../infra/update-rehearsal-paths.js";
import { buildUpdateDoctorEnv } from "../../infra/update-runner-doctor.js";
import { withCliProcessScope } from "../runtime-cleanup-scope.js";
import { registerMaintenanceCommands } from "./register.maintenance.js";

vi.mock("../../commands/doctor-lint-process.js", () => ({
  runUpdateDoctorLintProcess: vi.fn(),
}));
vi.mock("../../flows/doctor-update-budget.js", () => ({
  resolveDoctorUpdateBudget: async () => ({ disposalDeadlineMs: 123 }),
}));
vi.mock("../../flows/doctor-lint-flow.js", () => {
  throw new Error("Doctor lint checks loaded in the supervisor");
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("delegates copied-state lint before loading health checks in the supervisor", async () => {
  for (const [key, value] of Object.entries({
    ...buildUpdateRehearsalPathEnv(tempDirs.make("doctor-lint-startup-")),
    ...buildUpdateDoctorEnv({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
      serviceRepairPolicy: "external",
    }),
    OPENCLAW_UPDATE_IN_PROGRESS: "0",
    OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
  })) {
    vi.stubEnv(key, value);
  }
  vi.mocked(runUpdateDoctorLintProcess).mockResolvedValue(1);
  const program = new Command().name("openclaw");
  registerMaintenanceCommands(program);
  const args = ["doctor", "--lint", "--json"];
  const previousArgv = process.argv;
  process.argv = [process.execPath, "openclaw", ...args];
  try {
    await expect(
      withCliProcessScope(() => program.parseAsync(args, { from: "user" })),
    ).rejects.toMatchObject({ code: 1 });
    expect(runUpdateDoctorLintProcess).toHaveBeenCalledOnce();
  } finally {
    process.argv = previousArgv;
  }
});
