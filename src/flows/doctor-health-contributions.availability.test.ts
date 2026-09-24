import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runStructuredHealthRepairs } from "./doctor-health-contribution-core.js";
import { createDoctorHealthFlowContext } from "./doctor-health-contributions.test-support.js";
import { clearHealthChecksForTest } from "./health-check-registry.js";

const { registerBundledHealthChecks } = vi.hoisted(() => ({
  registerBundledHealthChecks: vi.fn(),
}));
vi.mock("./bundled-health-checks.js", () => ({ registerBundledHealthChecks }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(clearHealthChecksForTest);
afterEach(clearHealthChecksForTest);

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
