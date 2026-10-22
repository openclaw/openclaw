import { confirm as clackConfirm, isCancel } from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withTriageTerminal } from "../../commands/triage.test-support.js";
import { prepareGithubIssue } from "../../infra/github-issue.js";
import * as ledger from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { stepFixture } from "./update-command-fixtures.test-support.js";
import {
  UpdateCommandFailure,
  UpdateCommandFinalizedRecoveryFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";

const mocks = vi.hoisted(() => ({
  select:
    vi.fn<(options: { options: { value: string; label: string }[] }) => Promise<string | symbol>>(),
  confirm: vi.fn<() => Promise<boolean | symbol>>(),
  prepare:
    vi.fn<typeof import("../../infra/update-failure-report.js").prepareUpdateFailureReport>(),
  submit: vi.fn<typeof import("../../infra/update-failure-report.js").submitUpdateFailureReport>(),
  triage: vi.fn(),
}));

vi.mock("../../commands/configure.shared.js", () => ({
  select: mocks.select,
  confirm: mocks.confirm,
}));
vi.mock("../../infra/update-failure-report.js", () => ({
  prepareUpdateFailureReport: mocks.prepare,
  submitUpdateFailureReport: mocks.submit,
}));
vi.mock("../../infra/update-triage.js", () => ({
  prepareUpdateFailureTriage: async () => mocks.triage,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runId = "b89e301f-2df4-4dd8-a7ea-4f4b4e10b6f3";

function setup() {
  const stateDir = tempDirs.make("openclaw-rollback-report-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const failure = new UpdateCommandFailure({
    runId,
    status: "error",
    mode: "npm",
    reason: "restart-unhealthy",
    steps: [],
    durationMs: 1,
    recovery: {
      serviceRestartSafe: true,
      packageRollbackVerified: true,
      version: "2026.9.2",
      service: "healthy",
    },
  });
  const result = failure.result;
  const prepared = {
    ...prepareGithubIssue({
      body: "Sanitized failure and rollback details",
      title: "Update failed: restart-unhealthy",
    }),
    attemptId: runId,
    previewDigest: "a".repeat(64),
    savedReportPath: `${stateDir}/report.md`,
  };
  mocks.prepare.mockResolvedValue(prepared);
  mocks.submit.mockResolvedValue({
    savedReportPath: prepared.savedReportPath,
    status: "created",
    url: "https://github.com/openclaw/openclaw/issues/123",
  });
  const opts = { run: { runId, env } };
  const target = { env };
  const invoke = (run: () => Promise<void>) =>
    withTriageTerminal(true, () => withUpdateFailureTriage(opts, target, run));
  const run = (error = failure) =>
    expect(invoke(() => Promise.reject(error))).rejects.toMatchObject({ code: 1 });
  return { env, prepared, result, run, invoke };
}

function expectUnused(...actions: (keyof typeof mocks)[]) {
  for (const action of actions) {
    expect(mocks[action]).not.toHaveBeenCalled();
  }
}

function expectOnceContaining(action: keyof typeof mocks, value: object) {
  expect(mocks[action]).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(value));
}

let f: ReturnType<typeof setup>;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.select.mockResolvedValue("dismiss");
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  f = setup();
});

afterEach(() => vi.restoreAllMocks());

it("offers an optional report, previews it, and submits once only after confirmation", async () => {
  mocks.select.mockImplementation(async () => {
    expectUnused("prepare", "submit");
    return "report";
  });
  mocks.confirm.mockImplementation(async () => {
    expect(defaultRuntime.log).toHaveBeenCalledWith(f.prepared.body);
    expect(mocks.submit).not.toHaveBeenCalled();
    return true;
  });

  await f.run();

  expectOnceContaining("select", {
    message: expect.stringContaining("rollback completed"),
    initialValue: "dismiss",
    options: [
      { value: "triage", label: "Diagnose update failure" },
      { value: "report", label: "Report update failure" },
      { value: "dismiss", label: "Exit" },
    ],
  });
  expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(
    { attemptId: runId, action: "cli", result: f.result, recordedRun: undefined },
    { env: f.env, stateDir: f.env.OPENCLAW_STATE_DIR },
  );
  expectOnceContaining("confirm", { initialValue: false });
  expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(f.prepared, f.prepared.previewDigest, {
    env: f.env,
    stateDir: f.env.OPENCLAW_STATE_DIR,
    allowBrowserFallback: false,
  });
  expect(mocks.triage).not.toHaveBeenCalled();
  expect(f.result.status).toBe("error");
  expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
});

it("does not submit when confirmation is cancelled", async () => {
  mocks.select.mockResolvedValue("report");
  const cancelled = await clackConfirm({
    message: "Cancelled fixture",
    signal: AbortSignal.abort(),
  });
  expect(isCancel(cancelled)).toBe(true);
  mocks.confirm.mockResolvedValue(cancelled);

  await f.run();

  expect(defaultRuntime.log).toHaveBeenCalledWith(f.prepared.body);
  expect(defaultRuntime.log).toHaveBeenCalledWith("Update failure report cancelled.");
  expectUnused("submit", "triage");
});

it("keeps signal-cancelled rollback quiet", async () => {
  f.result.steps = [stepFixture("gateway-restart", { exitCode: 130, termination: "signal" })];
  await f.run();
  expectUnused("select", "prepare", "submit", "triage");
});

it("keeps ordinary failure actions for an unverified service", async () => {
  f.result.recovery = {
    serviceRestartSafe: true,
    packageRollbackVerified: true,
    version: "2026.9.2",
  };
  await f.run();
  expectOnceContaining("select", { message: "Choose the next action for this failed update" });
  expect(mocks.select.mock.calls[0]?.[0]).not.toHaveProperty("initialValue", "dismiss");
});

it.each([UpdateCommandPendingRecoveryFailure, UpdateCommandFinalizedRecoveryFailure])(
  "preserves the legacy recovery marker exit without a menu (%s)",
  async (Failure) => {
    await f.run(new Failure(f.result));

    expectUnused("select", "triage");
  },
);

it("does not prompt after a successful update", async () => {
  await f.invoke(async () => {});

  expectUnused("select", "triage");
});

describe("interactive report actions", () => {
  function action(actions = ["report"], confirmed = true) {
    vi.spyOn(ledger, "getUpdateRun").mockReturnValue(undefined);
    Object.assign(f.prepared, {
      browserFallback: {
        status: "available",
        url: "https://github.com/openclaw/openclaw/issues/new",
      },
    });
    mocks.select.mockImplementation(async () => actions.shift() ?? "dismiss");
    mocks.confirm.mockResolvedValue(confirmed);
    return f.run;
  }

  it("shows the sanitized preview and honors cancellation without submission", async () => {
    await action(["report"], false)();
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(defaultRuntime.log).toHaveBeenCalledWith(f.prepared.body);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    expect(defaultRuntime.log).toHaveBeenCalledWith("Update failure report cancelled.");
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each([
    { status: "duplicate", url: "https://github.com/openclaw/openclaw/issues/123" },
    { status: "pending" },
    { status: "fallback", fallbackUrl: "https://github.com/openclaw/openclaw/issues/new" },
  ] as const)("renders $status guidance without unsolicited browser navigation", async (result) => {
    const run = action();
    const message = "Report outcome details";
    mocks.submit.mockResolvedValue({
      ...result,
      message,
      savedReportPath: f.prepared.savedReportPath,
    });
    await run();
    if (result.status !== "fallback") {
      expect(defaultRuntime.log).toHaveBeenCalledWith(message);
    }
    if (result.status === "duplicate") {
      expect(defaultRuntime.log).toHaveBeenCalledWith(`Existing issue: ${result.url}`);
    }
    if (result.status === "fallback") {
      expect(mocks.select).toHaveBeenCalledTimes(2);
      expect(defaultRuntime.log).not.toHaveBeenCalledWith(`Prefilled issue: ${result.fallbackUrl}`);
      expect(defaultRuntime.log).toHaveBeenCalledWith(
        `Saved sanitized report: ${f.prepared.savedReportPath}`,
      );
    } else {
      expect(defaultRuntime.log).not.toHaveBeenCalledWith(
        expect.stringContaining("Saved sanitized report:"),
      );
    }
  });

  it("retires a browser retry choice after submission errors while retaining the report", async () => {
    const run = action(["report", "report", "report", "report"]);
    mocks.submit
      .mockResolvedValueOnce({
        status: "retryable",
        message: "GitHub authentication is unavailable.",
        savedReportPath: f.prepared.savedReportPath,
      })
      .mockRejectedValueOnce(new Error("transport failed"))
      .mockRejectedValueOnce(new Error("still unavailable"));
    await run();
    expect(mocks.select).toHaveBeenCalledTimes(4);
    expect(
      mocks.select.mock.calls.map(([params]) =>
        params.options.some((option) => option.value === "browser"),
      ),
    ).toEqual([false, true, false, false]);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.submit).toHaveBeenCalledTimes(4);
    expect(mocks.confirm).toHaveBeenCalledTimes(4);
    expect(defaultRuntime.error).toHaveBeenCalledTimes(2);
    for (const [report, digest] of mocks.submit.mock.calls) {
      expect(report).toBe(f.prepared);
      expect(digest).toBe(f.prepared.previewDigest);
    }
  });

  it("requires a fresh explicit choice before diagnosing after a report failure", async () => {
    const run = action(["report", "triage"]);
    mocks.submit.mockRejectedValueOnce(new Error("report unavailable"));
    await run();
    expect(mocks.triage).toHaveBeenCalledOnce();
    expect(mocks.select).toHaveBeenCalledTimes(2);
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("report unavailable"),
    );
  });
});
