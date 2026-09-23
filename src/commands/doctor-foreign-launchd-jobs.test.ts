import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForeignLaunchdJob } from "../daemon/launchd-foreign-jobs.js";
import { runGatewayServicesHealth } from "../flows/doctor-health-contribution-runners.gateway.js";
import { createDoctorHealthFlowContext } from "../flows/doctor-health-contributions.test-support.js";
import { noteMacForeignLaunchdJobs } from "./doctor-foreign-launchd-jobs.js";
import type { DoctorOptions } from "./doctor.types.js";

const mocks = vi.hoisted(() => ({
  find: vi.fn<() => Promise<ForeignLaunchdJob[]>>(),
  repair: vi.fn<() => Promise<{ removed: boolean; detail: string }>>(),
  note: vi.fn(),
  defaultIdentity: vi.fn(() => true),
  manageService: vi.fn(async () => true),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  isDefaultInstallIdentity: mocks.defaultIdentity,
}));
vi.mock("../daemon/launchd-foreign-jobs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/launchd-foreign-jobs.js")>()),
  findForeignLaunchdJobs: mocks.find,
  repairForeignLaunchdJob: mocks.repair,
}));
vi.mock("../daemon/restart-storm.js", () => ({
  readGatewayForcedRestartSummary: () => ({ count: 3, windowMs: 600_000 }),
}));
vi.mock("./doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: mocks.manageService,
}));

const lifecycleJob: ForeignLaunchdJob = {
  label: "ai.openclaw.test.w15.restart",
  program: "/tmp/openclaw-test/restart.sh",
  keepAlive: true,
  gatewayActions: ["restart"],
  safeToRemove: true,
};
const reportOnlyJob: ForeignLaunchdJob = {
  label: "ai.openclaw.test.w15.observer",
  program: "/usr/bin/true",
  keepAlive: false,
  gatewayActions: [],
  safeToRemove: false,
};

describe("Doctor foreign launchd jobs", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

  beforeEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    mocks.find.mockReset().mockResolvedValue([lifecycleJob, reportOnlyJob]);
    mocks.repair.mockReset().mockResolvedValue({
      removed: true,
      detail: `Removed stray launchd job ${lifecycleJob.label}. Verified unloaded.`,
    });
    mocks.note.mockReset();
    mocks.defaultIdentity.mockReset().mockReturnValue(true);
    mocks.manageService.mockReset().mockResolvedValue(true);
    runtime.log.mockReset();
  });

  afterEach(() => Object.defineProperty(process, "platform", platform));

  it.each<DoctorOptions>([{}, { yes: true }, { nonInteractive: true }])(
    "reports lifecycle details without removal when --fix is absent: %j",
    async (options) => {
      await noteMacForeignLaunchdJobs(options, runtime, {});

      const report = mocks.note.mock.calls[0]?.[0];
      expect(report).toContain(lifecycleJob.label);
      expect(report).toContain(lifecycleJob.program);
      expect(report).toContain("keepalive=true");
      expect(report).toContain("Gateway lifecycle=restart");
      expect(report).toContain(reportOnlyJob.label);
      expect(report).toContain("3 external forced Gateway restart(s)");
      expect(mocks.repair).not.toHaveBeenCalled();
    },
  );

  it("names confirmed removals through the maintenance-owned --fix runner and preserves report-only jobs", async () => {
    await runGatewayServicesHealth(
      createDoctorHealthFlowContext({
        options: { repair: true, nonInteractive: true },
        gatewayMaintenanceActive: true,
        runtime,
        env: {},
      }),
    );

    expect(mocks.repair).toHaveBeenCalledExactlyOnceWith(lifecycleJob, {});
    expect(runtime.log).toHaveBeenCalledWith(
      `Removed stray launchd job ${lifecycleJob.label}. Verified unloaded.`,
    );
  });

  it("reports a job rejected by fresh owner inspection as not removed", async () => {
    mocks.repair.mockResolvedValue({ removed: false, detail: "Lifecycle command changed." });

    await noteMacForeignLaunchdJobs({ repair: true, nonInteractive: true }, runtime, {});

    expect(runtime.log).toHaveBeenCalledWith(
      `Removal not confirmed for launchd job ${lifecycleJob.label}: Lifecycle command changed.`,
    );
  });

  it("reports a repair failure per job and continues to the next candidate", async () => {
    const secondJob = { ...lifecycleJob, label: "ai.openclaw.test.w15.second" };
    mocks.find.mockResolvedValue([lifecycleJob, secondJob]);
    mocks.repair.mockRejectedValueOnce(new Error("launchd job inspection failed"));
    mocks.repair.mockResolvedValueOnce({
      removed: true,
      detail: `Removed stray launchd job ${secondJob.label}. Verified unloaded.`,
    });

    await noteMacForeignLaunchdJobs({ repair: true }, runtime, {});

    expect(runtime.log).toHaveBeenCalledWith(
      `Removal not confirmed for launchd job ${lifecycleJob.label}: launchd job inspection failed`,
    );
    expect(runtime.log).toHaveBeenCalledWith(
      `Removed stray launchd job ${secondJob.label}. Verified unloaded.`,
    );
  });

  it("reports unavailable inspection without removing jobs or aborting Doctor", async () => {
    mocks.find.mockRejectedValue(new Error("launchd inspection unavailable"));

    await noteMacForeignLaunchdJobs({ repair: true }, runtime, {});

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Could not inspect foreign launchd jobs: launchd inspection unavailable",
      ),
      "Foreign launchd jobs (macOS)",
    );
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "external service policy", env: { OPENCLAW_SERVICE_REPAIR_POLICY: "external" } },
    { reason: "active update", env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" } },
    { reason: "nondefault identity", env: {}, defaultIdentity: false },
    { reason: "external supervisor", env: {}, manageService: false },
  ])("reports but does not repair with $reason", async (testCase) => {
    mocks.defaultIdentity.mockReturnValue(testCase.defaultIdentity ?? true);
    mocks.manageService.mockResolvedValue(testCase.manageService ?? true);

    await noteMacForeignLaunchdJobs({ repair: true }, runtime, testCase.env);

    expect(mocks.note).toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("No jobs were removed."));
  });
});
