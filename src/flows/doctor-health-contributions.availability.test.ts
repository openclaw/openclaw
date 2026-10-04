import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runStructuredHealthRepairs } from "./doctor-health-contribution-core.js";
import {
  createDoctorHealthContribution,
  recordDoctorHealthWarnings,
} from "./doctor-health-contribution.js";
import {
  createDoctorHealthFlowContext,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";
import { clearHealthChecksForTest } from "./health-check-registry.js";

const { registerBundledHealthChecks, runDoctorHealthRepairs } = vi.hoisted(() => ({
  registerBundledHealthChecks: vi.fn(),
  runDoctorHealthRepairs: vi.fn(),
}));
vi.mock("./bundled-health-checks.js", () => ({ registerBundledHealthChecks }));
vi.mock("./doctor-repair-flow.js", () => ({ runDoctorHealthRepairs }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(clearHealthChecksForTest);
afterEach(clearHealthChecksForTest);
beforeEach(() => {
  runDoctorHealthRepairs.mockResolvedValue({
    config: {},
    findings: [],
    remainingFindings: [],
    changes: [],
    warnings: [],
  });
});

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
  expect(ctx.runtime.log).toHaveBeenCalledWith(`[warning] ${checkId} - ${message}`);
  expect(ctx.runtime.error).not.toHaveBeenCalled();
  expect(ctx.runtime.exit).not.toHaveBeenCalled();
});

it("passes progress through contribution-defined structured checks", async () => {
  const contribution = createDoctorHealthContribution({
    id: "doctor:structured-progress",
    label: "Structured progress",
    healthChecks: { description: "structured progress", detect: vi.fn(async () => []) },
  });
  const ctx = createDoctorHealthFlowContext({
    cfg: {},
    cfgForPersistence: {},
    configResult: { cfg: {} },
  });
  ctx.prompter.shouldRepair = true;

  await contribution.run(ctx);

  expect(runDoctorHealthRepairs).toHaveBeenCalledWith(expect.any(Object), {
    checks: contribution.healthChecks,
    dryRun: false,
    progress: true,
  });
});

it("reports a warning after the bounded warning digest is full", async () => {
  const ctx = createDoctorHealthFlowContext({
    updateWarnings: Array.from({ length: 32 }, (_, index) => `prior warning ${index}`),
  });
  await runDoctorHealthContributionList(ctx, [
    createDoctorHealthContribution({
      id: "doctor:bounded-warning",
      label: "Bounded warning",
      run: async (innerCtx) => {
        recordDoctorHealthWarnings(innerCtx, [], ["new warning"]);
      },
    }),
  ]);

  expect(ctx.runtime.log).toHaveBeenCalledWith(
    expect.stringMatching(/^Doctor: Bounded warning warning \(\d+ms\)$/),
  );
  expect(ctx.updateWarnings).toHaveLength(32);
  expect(ctx.updateWarnings).not.toContain("new warning");
});
