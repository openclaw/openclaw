import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runStructuredHealthRepairs } from "./doctor-health-contribution-core.js";
import {
  createDoctorHealthContribution,
  showDoctorHealthSummary,
} from "./doctor-health-contribution.js";
import {
  createDoctorHealthFlowContext,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";
import { clearHealthChecksForTest } from "./health-check-registry.js";

const { registerBundledHealthChecks } = vi.hoisted(() => ({
  registerBundledHealthChecks: vi.fn(),
}));
vi.mock("./bundled-health-checks.js", () => ({ registerBundledHealthChecks }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(clearHealthChecksForTest);
afterEach(clearHealthChecksForTest);
afterEach(() => {
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
    const context = createDoctorHealthFlowContext({ env: {}, options: { json } });
    context.prompter.shouldRepair = true;
    const running = runDoctorHealthContributionList(context, [
      createDoctorHealthContribution("doctor:progress-fixture", "Progress fixture", {
        healthChecks: {
          description: "Synthetic repair",
          async detect() {
            if (repaired) {
              return [];
            }
            entered.resolve();
            await detection.promise;
            return [
              {
                checkId: "core/doctor/progress-fixture",
                severity: "warning",
                message: "Repair needed",
              },
            ];
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
    try {
      await entered.promise;
      if (!json) {
        expect(output()).toContain("Doctor: Progress fixture");
        expect(output()).toContain("core/doctor/progress-fixture: check");
      }
      await vi.advanceTimersByTimeAsync(10_000);
      if (!json) {
        expect(output()).toContain("10s elapsed");
      }
      detection.resolve();
      await repairing.promise;
      if (!json) {
        expect(output()).toContain("core/doctor/progress-fixture: repair");
      }
    } finally {
      detection.resolve();
      repair.resolve();
      await running;
    }
    if (json) {
      expect(output()).toBe("");
    } else {
      expect(output()).toContain("core/doctor/progress-fixture: validation");
    }
    expect(stdout).not.toHaveBeenCalled();
    const finished = output();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(output()).toBe(finished);
  },
);

it("retains unavailable-plugin repair guidance in Doctor output and update warnings", async () => {
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
  showDoctorHealthSummary(ctx);
  expect(ctx.runtime.log).toHaveBeenCalledWith("Fix now:");
  expect(ctx.runtime.log).toHaveBeenCalledWith(`- ${message}`);
  expect(ctx.runtime.error).not.toHaveBeenCalled();
  expect(ctx.runtime.exit).not.toHaveBeenCalled();
});
