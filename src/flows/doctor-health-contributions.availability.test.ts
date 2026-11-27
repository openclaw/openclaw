import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  checkStructuredHealthRepairsContributionPending,
  runStructuredHealthRepairs,
} from "./doctor-health-contribution-core.js";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import {
  createDoctorHealthFlowContext,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";
import { clearHealthChecksForTest, registerHealthCheck } from "./health-check-registry.js";

const registerBundledHealthChecks = vi.hoisted(() => vi.fn());
vi.mock("./bundled-health-checks.js", () => ({ registerBundledHealthChecks }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(clearHealthChecksForTest);
afterEach(() => {
  clearHealthChecksForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "reports pending Doctor phases only on human stderr (json=%s)",
  async (json) => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const entered = Promise.withResolvers<void>();
    const detection = Promise.withResolvers<void>();
    const repairing = Promise.withResolvers<void>();
    const repair = Promise.withResolvers<void>();
    let repaired = false;
    const checkId = "core/doctor/progress";
    const context = createDoctorHealthFlowContext({ env: {}, options: { json } });
    context.prompter.shouldRepair = true;
    const running = runDoctorHealthContributionList(context, [
      createDoctorHealthContribution("doctor:progress", "Progress", {
        healthChecks: {
          description: "Synthetic repair",
          async detect() {
            if (repaired) {
              return [];
            }
            entered.resolve();
            await detection.promise;
            return [{ checkId, severity: "warning", message: "Repair needed" }];
          },
          async repair() {
            repairing.resolve();
            await repair.promise;
            repaired = true;
            return { changes: [] };
          },
        },
      }),
    ]);
    const output = () => stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    const expectProgress = (text: string) => {
      expect(output()).toEqual(json ? "" : expect.stringContaining(text));
    };
    try {
      await entered.promise;
      expectProgress("Doctor: Progress");
      expectProgress(`${checkId}: check`);
      await vi.advanceTimersByTimeAsync(10_000);
      expectProgress("10s elapsed");
      detection.resolve();
      await repairing.promise;
      expectProgress(`${checkId}: repair`);
    } finally {
      detection.resolve();
      repair.resolve();
      await running;
    }
    expectProgress(`${checkId}: validation`);
    expect(stdout).not.toHaveBeenCalled();
    const finished = output();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(output()).toBe(finished);
  },
);

it("retains unavailable-plugin repair guidance in update warnings", async () => {
  const checkId = "core/doctor/codex-session-routes";
  const message =
    'Plugin "codex" is unavailable: health API could not be verified. Run `openclaw doctor --fix`.';
  registerBundledHealthChecks.mockReturnValue([
    { checkId, source: "codex", severity: "warning", message },
  ]);
  const root = tempDirs.make("openclaw-doctor-plugin-availability-");
  const ctx = createDoctorHealthFlowContext({
    cfg: { agents: { defaults: { workspace: root } } },
    configPath: `${root}/openclaw.json`,
    env: { OPENCLAW_STATE_DIR: root, OPENCLAW_UPDATE_POST_CORE: "1" },
    updateWarnings: ["earlier warning"],
  });
  ctx.prompter.shouldRepair = true;

  await runStructuredHealthRepairs(ctx, async () => []);

  expect(ctx.updateWarnings).toEqual(["earlier warning", `${checkId}: ${message}`]);
});

it("has structured repair work only while a plugin check that can repair has a finding", async () => {
  registerBundledHealthChecks.mockReturnValue([]);
  const finding = (checkId: string) => ({ checkId, severity: "warning" as const, message: "fix" });
  let repaired = false;
  registerHealthCheck({
    id: "example/repairable",
    kind: "plugin",
    source: "example",
    description: "Synthetic repairable plugin state",
    detect: async () => (repaired ? [] : [finding("example/repairable")]),
    async repair() {
      repaired = true;
      return { changes: ["Repaired synthetic plugin state."] };
    },
  });
  registerHealthCheck({
    id: "example/report-only",
    kind: "plugin",
    source: "example",
    description: "Synthetic diagnostic",
    detect: async () => [finding("example/report-only")],
  });
  const root = tempDirs.make("openclaw-doctor-structured-pending-");
  const ctx = createDoctorHealthFlowContext({
    cfg: { agents: { defaults: { workspace: root } } },
    configPath: `${root}/openclaw.json`,
    env: { OPENCLAW_STATE_DIR: root },
  });
  const pending = () => checkStructuredHealthRepairsContributionPending(ctx);

  await expect(pending()).resolves.toBe("none");
  ctx.prompter.shouldRepair = true;
  await expect(pending()).resolves.toBe("work");
  expect(repaired).toBe(false);
  await runStructuredHealthRepairs(ctx, async () => []);
  expect(repaired).toBe(true);
  // The diagnostic still reports, but nothing is left to repair.
  await expect(pending()).resolves.toBe("none");
});
