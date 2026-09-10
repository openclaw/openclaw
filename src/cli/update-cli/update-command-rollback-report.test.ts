import { confirm as clackConfirm, isCancel } from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withTriageTerminal } from "../../commands/triage.test-support.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import {
  UpdateCommandFailure,
  UpdateCommandFinalizedRecoveryFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";

const mocks = vi.hoisted(() => ({
  select: vi.fn<(options: unknown) => Promise<string | symbol>>(),
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

async function cancelPrompt(): Promise<symbol> {
  const cancelled = await clackConfirm({
    message: "Cancelled fixture",
    signal: AbortSignal.abort(),
  });
  if (!isCancel(cancelled)) {
    throw new Error("Expected Clack cancellation");
  }
  return cancelled;
}

function setup() {
  const stateDir = tempDirs.make("openclaw-rollback-report-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const result: UpdateRunResult = {
    runId,
    status: "error",
    mode: "npm",
    reason: "restart-unhealthy",
    before: { version: "2026.9.1" },
    after: { version: "2026.9.1" },
    steps: [],
    durationMs: 1,
    recovery: {
      serviceRestartSafe: true,
      packageRollbackVerified: true,
      service: "healthy",
      version: "2026.9.1",
    },
  };
  const prepared = {
    attemptId: runId,
    body: "Sanitized failure and rollback details",
    previewDigest: "a".repeat(64),
    marker: `openclaw-report:${"b".repeat(64)}`,
    browserFallback: {
      status: "available" as const,
      url: "https://github.com/openclaw/openclaw/issues/new",
    },
    savedReportPath: `${stateDir}/report.md`,
    title: "Update failed: restart-unhealthy",
    url: "https://github.com/openclaw/openclaw/issues/new",
  };
  mocks.prepare.mockResolvedValue(prepared);
  mocks.submit.mockResolvedValue({
    savedReportPath: prepared.savedReportPath,
    status: "created",
    url: "https://github.com/openclaw/openclaw/issues/123",
  });
  const opts = { run: { runId, env } };
  const target = { env };
  const fail = async () => {
    throw new UpdateCommandFailure(result);
  };
  const run = () =>
    withTriageTerminal(true, async () => {
      await expect(withUpdateFailureTriage(opts, target, fail)).rejects.toMatchObject({ code: 1 });
    });
  return { env, fail, opts, prepared, result, run, target };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.select.mockResolvedValue("dismiss");
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("verified rollback failure actions", () => {
  it("offers an optional report, previews it, and submits once only after confirmation", async () => {
    const f = setup();
    mocks.select.mockImplementation(async () => {
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(mocks.submit).not.toHaveBeenCalled();
      return "report";
    });
    mocks.confirm.mockImplementation(async () => {
      expect(defaultRuntime.log).toHaveBeenCalledWith(f.prepared.body);
      expect(mocks.submit).not.toHaveBeenCalled();
      return true;
    });

    await f.run();

    expect(mocks.select).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.stringContaining("rollback completed"),
        initialValue: "dismiss",
        options: [
          { value: "triage", label: "Diagnose update failure" },
          { value: "report", label: "Report update failure" },
          { value: "dismiss", label: "Exit" },
        ],
      }),
    );
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(
      { attemptId: runId, result: f.result },
      { env: f.env, stateDir: f.env.OPENCLAW_STATE_DIR },
    );
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ initialValue: false }),
    );
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(f.prepared, f.prepared.previewDigest, {
      env: f.env,
      stateDir: f.env.OPENCLAW_STATE_DIR,
    });
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(f.result.status).toBe("error");
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
  });

  it.each(["declined", "cancelled"])("does not submit when confirmation is %s", async (answer) => {
    const f = setup();
    mocks.select.mockResolvedValue("report");
    mocks.confirm.mockResolvedValue(answer === "declined" ? false : await cancelPrompt());

    await f.run();

    expect(defaultRuntime.log).toHaveBeenCalledWith(f.prepared.body);
    expect(defaultRuntime.log).toHaveBeenCalledWith("Update failure report cancelled.");
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
  });

  it.each(["dismiss", "cancel"])("does nothing after the menu returns %s", async (action) => {
    const f = setup();
    mocks.select.mockResolvedValue(action === "dismiss" ? action : await cancelPrompt());

    await f.run();

    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
  });

  it("diagnoses the original failure only when selected", async () => {
    const f = setup();
    mocks.select.mockResolvedValue("triage");

    await f.run();

    expect(mocks.triage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ failure: { result: f.result }, target: f.target }),
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each([
    { name: "JSON", opts: { json: true } },
    { name: "--yes", opts: { yes: true } },
    { name: "noninteractive", interactive: false },
    { name: "dry run", opts: { dryRun: true } },
    { name: "post-core child", env: { [POST_CORE_UPDATE_ENV]: "1" } },
    { name: "managed handoff", env: { OPENCLAW_UPDATE_RUN_HANDOFF: "1" } },
    { name: "signal cancellation", signal: true },
  ])("keeps $name rollback quiet", async (testCase) => {
    const f = setup();
    Object.assign(f.env, testCase.env);
    if (testCase.signal) {
      f.result.steps.push({
        name: "update",
        command: "synthetic-update",
        cwd: "/synthetic",
        durationMs: 1,
        exitCode: 130,
        termination: "signal",
      });
    }
    await withTriageTerminal(testCase.interactive ?? true, async () => {
      await expect(
        withUpdateFailureTriage({ ...f.opts, ...testCase.opts }, f.target, f.fail),
      ).rejects.toMatchObject({ code: 1 });
    });

    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
  });

  it.each<{ name: string; recovery: UpdateRunResult["recovery"] }>([
    {
      name: "unverified service",
      recovery: { serviceRestartSafe: true, packageRollbackVerified: true, version: "2026.9.1" },
    },
    {
      name: "unsafe restart",
      recovery: {
        serviceRestartSafe: false,
        packageRollbackVerified: true,
        reason: "runtime-verification-failed",
      },
    },
    {
      name: "unverified package",
      recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.1" },
    },
  ])("keeps ordinary failure actions for $name", async ({ recovery }) => {
    const f = setup();
    f.result.recovery = recovery;
    await f.run();
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "Choose the next action for this failed update" }),
    );
    expect(mocks.select.mock.calls[0]?.[0]).not.toHaveProperty("initialValue", "dismiss");
  });

  it.each([UpdateCommandPendingRecoveryFailure, UpdateCommandFinalizedRecoveryFailure])(
    "preserves the legacy recovery marker exit without a menu (%s)",
    async (Failure) => {
      const f = setup();
      await withTriageTerminal(true, async () => {
        await expect(
          withUpdateFailureTriage(f.opts, f.target, async () => {
            throw new Failure(f.result);
          }),
        ).rejects.toMatchObject({ code: 1 });
      });

      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.triage).not.toHaveBeenCalled();
    },
  );

  it("does not prompt after a successful update", async () => {
    const f = setup();
    await withTriageTerminal(true, async () => {
      await withUpdateFailureTriage(f.opts, f.target, async () => {});
    });

    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
  });
});
