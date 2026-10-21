import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runInteractiveUpdateFailureAction } from "./update-command-report.js";

const mocks = vi.hoisted(() => ({
  select:
    vi.fn<(params: { options: { value: string; label: string }[] }) => Promise<string | symbol>>(),
  confirm: vi.fn<() => Promise<boolean | symbol>>(),
  prepare:
    vi.fn<typeof import("../../infra/update-failure-report.js").prepareUpdateFailureReport>(),
  submit: vi.fn<typeof import("../../infra/update-failure-report.js").submitUpdateFailureReport>(),
  getUpdateRun: vi.fn<typeof import("../../infra/update-run-ledger.js").getUpdateRun>(),
}));
vi.mock("../../commands/configure.shared.js", () => ({
  select: mocks.select,
  confirm: mocks.confirm,
}));
vi.mock("../../infra/update-failure-report.js", () => ({
  prepareUpdateFailureReport: mocks.prepare,
  submitUpdateFailureReport: mocks.submit,
}));
vi.mock("../../infra/update-run-ledger.js", () => ({ getUpdateRun: mocks.getUpdateRun }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
const reportUrl = "https://github.com/openclaw/openclaw/issues/new";
type Action = "triage" | "report" | "dismiss";

function setup(actions: Action[] = ["report"], confirmed = true) {
  const stateDir = tempDirs.make("openclaw-update-report-cli-");
  const prepared = {
    attemptId: "attempt-cli",
    body: "sanitized preview",
    previewDigest: "a".repeat(64),
    marker: `openclaw-report:${"b".repeat(64)}`,
    browserFallback: { status: "available" as const, url: reportUrl },
    savedReportPath: `${stateDir}/report.md`,
    title: "Update failure",
    url: reportUrl,
  };
  const prepare = mocks.prepare.mockReset().mockResolvedValue(prepared);
  const submit = mocks.submit.mockReset().mockResolvedValue({
    savedReportPath: prepared.savedReportPath,
    status: "created",
    url: issueUrl,
  });
  mocks.getUpdateRun.mockReset().mockReturnValue(undefined);
  const runtime = { log: vi.fn(), error: vi.fn() };
  const remaining = [...actions];
  const chooseAction = mocks.select
    .mockReset()
    .mockImplementation(async () => remaining.shift() ?? "dismiss");
  mocks.confirm.mockReset().mockResolvedValue(confirmed);
  const run = () =>
    runInteractiveUpdateFailureAction({
      attemptId: prepared.attemptId,
      env: { OPENCLAW_STATE_DIR: stateDir },
      result: { status: "error", mode: "npm", steps: [], durationMs: 1 },
      runtime,
    });
  return { chooseAction, prepare, prepared, run, runtime, submit };
}

it("shows the sanitized preview and honors cancellation without submission", async () => {
  const f = setup(["report"], false);
  await expect(f.run()).resolves.toBe("handled");
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.runtime.log).toHaveBeenCalledWith("sanitized preview");
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
  expect(f.runtime.log).toHaveBeenCalledWith("Update failure report cancelled.");
  expect(f.submit).not.toHaveBeenCalled();
});

it.each([
  { status: "duplicate", url: issueUrl },
  { status: "pending" },
  { status: "fallback", fallbackUrl: reportUrl },
] as const)("renders $status guidance without unsolicited browser navigation", async (result) => {
  const f = setup();
  const message = "Report outcome details";
  f.submit.mockResolvedValue({ ...result, message, savedReportPath: f.prepared.savedReportPath });
  await expect(f.run()).resolves.toBe("handled");
  if (result.status !== "fallback") {
    expect(f.runtime.log).toHaveBeenCalledWith(message);
  }
  if (result.status === "duplicate") {
    expect(f.runtime.log).toHaveBeenCalledWith(`Existing issue: ${issueUrl}`);
  }
  if (result.status === "fallback") {
    expect(f.chooseAction).toHaveBeenCalledTimes(2);
    expect(f.runtime.log).not.toHaveBeenCalledWith(`Prefilled issue: ${reportUrl}`);
    expect(f.runtime.log).toHaveBeenCalledWith(
      `Saved sanitized report: ${f.prepared.savedReportPath}`,
    );
  } else {
    expect(f.runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining("Saved sanitized report:"),
    );
  }
});

it("retires a browser retry choice after submission errors while retaining the report", async () => {
  const f = setup(["report", "report", "report", "report"]);
  f.submit
    .mockResolvedValueOnce({
      status: "retryable",
      message: "GitHub authentication is unavailable.",
      savedReportPath: f.prepared.savedReportPath,
    })
    .mockRejectedValueOnce(new Error("transport failed"))
    .mockRejectedValueOnce(new Error("still unavailable"));
  await expect(f.run()).resolves.toBe("handled");
  expect(f.chooseAction).toHaveBeenCalledTimes(4);
  expect(
    f.chooseAction.mock.calls.map(([params]) =>
      params.options.some((option) => option.value === "browser"),
    ),
  ).toEqual([false, true, false, false]);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.submit).toHaveBeenCalledTimes(4);
  expect(mocks.confirm).toHaveBeenCalledTimes(4);
  expect(f.runtime.error).toHaveBeenCalledTimes(2);
  for (const [report, digest] of f.submit.mock.calls) {
    expect(report).toBe(f.prepared);
    expect(digest).toBe(f.prepared.previewDigest);
  }
});

it("requires a fresh explicit choice before diagnosing after a report failure", async () => {
  const f = setup(["report", "triage"]);
  f.submit.mockRejectedValueOnce(new Error("report unavailable"));
  await expect(f.run()).resolves.toBe("triage");
  expect(f.chooseAction).toHaveBeenCalledTimes(2);
  expect(f.runtime.error).toHaveBeenCalledWith(expect.stringContaining("report unavailable"));
});
