import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type * as ConfigureShared from "../../commands/configure.shared.js";
import { confirm, select } from "../../commands/configure.shared.js";
import type * as GithubIssue from "../../infra/github-issue.js";
import { submitGithubIssue } from "../../infra/github-issue.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { runInteractiveUpdateFailureAction } from "./update-command-report.js";

vi.mock("../../commands/configure.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigureShared>()),
  confirm: vi.fn(),
  select: vi.fn(),
}));
vi.mock("../../infra/github-issue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GithubIssue>()),
  submitGithubIssue: vi.fn(),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeStateDatabaseForTest);
afterEach(() => vi.clearAllMocks());

it.each([false, true])(
  "publishes a failed run only after explicit consent (%s)",
  async (consented) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("update-report-consent-") };
    const run = createUpdateRun({ trigger: "cli", target: { kind: "git" } }, { env });
    recordUpdateRunStep(run.runId, { step: "build", status: "failed", exitCode: 1 }, { env });
    finishUpdateRun(run.runId, { status: "failed", reason: "build-failed" }, { env });
    vi.mocked(select).mockResolvedValue("report");
    vi.mocked(confirm).mockImplementation(async () => {
      expect(submitGithubIssue).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("Failed phase build: exit 1"),
      );
      return consented;
    });
    vi.mocked(submitGithubIssue).mockResolvedValue({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    const runtime = { log: vi.fn(), error: vi.fn() };

    await expect(
      runInteractiveUpdateFailureAction({ attemptId: run.runId, env, runtime }),
    ).resolves.toBe("handled");

    expect(confirm).toHaveBeenCalledOnce();
    expect(runtime.error).not.toHaveBeenCalled();
    if (consented) {
      expect(submitGithubIssue).toHaveBeenCalledOnce();
      const report = vi.mocked(submitGithubIssue).mock.calls[0]?.[0];
      expect(report?.body).toContain("Result: failed");
      expect(report?.body).toContain("Reason code: build-failed");
      expect(report?.body).toContain("Failed phase build: exit 1");
      expect(runtime.log).toHaveBeenCalledWith(
        "Created GitHub issue: https://github.com/openclaw/openclaw/issues/123",
      );
    } else {
      expect(submitGithubIssue).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith("Update failure report cancelled.");
    }
  },
);
