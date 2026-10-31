// Covers the mapping from a (possibly partial) foreign-job scan to status diagnostics.
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ForeignLaunchdJob,
  ForeignLaunchdJobScan,
} from "../../daemon/launchd-foreign-jobs.js";
import { gatherLaunchdJobDiagnostics } from "./status.launchd.js";

const mocks = vi.hoisted(() => ({
  findForeignLaunchdJobs: vi.fn<(env?: NodeJS.ProcessEnv) => Promise<ForeignLaunchdJobScan>>(),
}));

vi.mock("../../daemon/launchd-foreign-jobs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd-foreign-jobs.js")>()),
  findForeignLaunchdJobs: mocks.findForeignLaunchdJobs,
}));
vi.mock("../../daemon/restart-storm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/restart-storm.js")>()),
  readGatewayForcedRestartSummary: () => ({ count: 3, windowMs: 600_000 }),
}));

const job: ForeignLaunchdJob = {
  label: "ai.openclaw.test.w15.restart",
  program: "/tmp/openclaw-test/restart.sh",
  keepAlive: true,
  gatewayActions: ["restart"],
  safeToRemove: true,
};

describe("gatherLaunchdJobDiagnostics", () => {
  afterEach(() => vi.clearAllMocks());

  it("maps a partial scan to foreign jobs plus an explicit skipped disclosure", async () => {
    mocks.findForeignLaunchdJobs.mockResolvedValue({ jobs: [job], skippedJobCount: 30 });

    const diagnostics = await gatherLaunchdJobDiagnostics({}, false);

    expect(diagnostics.foreignLaunchdJobs).toEqual([job]);
    expect(diagnostics.forcedRestartSummary).toEqual({ count: 3, windowMs: 600_000 });
    expect(diagnostics.foreignLaunchdInspectionSkipped).toContain(
      "30 candidate OpenClaw launchd jobs were not inspected",
    );
    expect(diagnostics.foreignLaunchdInspectionError).toBeUndefined();
  });

  it("omits the skipped disclosure when the scan inspected every candidate", async () => {
    mocks.findForeignLaunchdJobs.mockResolvedValue({ jobs: [], skippedJobCount: 0 });

    const diagnostics = await gatherLaunchdJobDiagnostics({}, false);

    expect(diagnostics.foreignLaunchdJobs).toBeUndefined();
    expect(diagnostics.foreignLaunchdInspectionSkipped).toBeUndefined();
  });

  it("keeps reporting inspection errors for a failed scan", async () => {
    mocks.findForeignLaunchdJobs.mockRejectedValue(new Error("launchctl unavailable"));

    const diagnostics = await gatherLaunchdJobDiagnostics({}, false);

    expect(diagnostics.foreignLaunchdInspectionError).toContain("launchctl unavailable");
    expect(diagnostics.foreignLaunchdInspectionSkipped).toBeUndefined();
  });
});
