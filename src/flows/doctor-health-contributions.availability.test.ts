import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
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

const { registerBundledHealthChecks } = vi.hoisted(() => ({
  registerBundledHealthChecks: vi.fn(),
}));
vi.mock("./bundled-health-checks.js", () => ({ registerBundledHealthChecks }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(clearHealthChecksForTest);
afterEach(clearHealthChecksForTest);
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "reports pending structured-check lifecycle outside JSON mode (%s)",
  async (json) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const root = tempDirs.make("openclaw-doctor-check-progress-");
    const ctx = createDoctorHealthFlowContext({
      cfg: { agents: { defaults: { workspace: root } } },
      configPath: `${root}/openclaw.json`,
      env: {},
      options: { json },
    });
    const contribution = createDoctorHealthContribution("doctor:test-progress", "test-progress", {
      healthChecks: {
        description: "progress fixture",
        async detect() {
          entered.resolve();
          await release.promise;
          return [];
        },
      },
    });
    const running = contribution.run(ctx);

    await entered.promise;
    try {
      expect(vi.mocked(ctx.runtime.log).mock.calls).toEqual(
        json ? [] : [["Doctor: core/doctor/test-progress started"]],
      );
      now = 125;
    } finally {
      release.resolve();
      await running;
    }
    expect(vi.mocked(ctx.runtime.log).mock.calls).toEqual(
      json
        ? []
        : [
            ["Doctor: core/doctor/test-progress started"],
            ["Doctor: core/doctor/test-progress completed (25ms)"],
          ],
    );
  },
);

it.each([false, true])(
  "reports pending contribution lifecycle outside JSON mode (%s)",
  async (json) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const ctx = createDoctorHealthFlowContext({ env: {}, options: { json } });
    const running = runDoctorHealthContributionList(ctx, [
      createDoctorHealthContribution("doctor:test-progress", "test-progress", async () => {
        entered.resolve();
        await release.promise;
      }),
    ]);

    await entered.promise;
    try {
      expect(vi.mocked(ctx.runtime.log).mock.calls).toEqual(
        json ? [] : [["Doctor: test-progress started"]],
      );
      now = 125;
    } finally {
      release.resolve();
      await running;
    }
    expect(vi.mocked(ctx.runtime.log).mock.calls).toEqual(
      json ? [] : [["Doctor: test-progress started"], ["Doctor: test-progress completed (25ms)"]],
    );
  },
);

it("stops after an optional contribution fails after writing config", async () => {
  const ctx = createDoctorHealthFlowContext({ env: {} });
  const failure = new ConfigWritePostCommitError({
    configPath: ctx.configPath,
    rollbackStatus: "not-restored",
    cause: new Error("config path changed since last load"),
  });
  const laterRun = vi.fn(async () => undefined);
  const promise = runDoctorHealthContributionList(ctx, [
    createDoctorHealthContribution("doctor:test-config-write", "Test config write", {
      run: async () => {
        throw failure;
      },
    }),
    createDoctorHealthContribution("doctor:test-later", "Test later", laterRun),
  ]);
  await expect(promise).rejects.toBe(failure);
  expect(laterRun).not.toHaveBeenCalled();
  expect(ctx.runtime.log).toHaveBeenCalledWith(
    expect.stringMatching(/^Doctor: Test config write failed \(\d+ms\)$/),
  );
});

it("reports each contribution's warnings after the update digest is full or deduplicates", async () => {
  const warnings = Array.from({ length: 32 }, (_, index) => `warning-${index}`);
  const ctx = createDoctorHealthFlowContext({ env: {}, updateWarnings: [...warnings] });
  await runDoctorHealthContributionList(ctx, [
    createDoctorHealthContribution("doctor:repeat", "test-repeat", async (context) => {
      recordDoctorHealthWarnings(context, [], [warnings[0]!]);
    }),
    createDoctorHealthContribution("doctor:overflow", "test-overflow", async (context) => {
      recordDoctorHealthWarnings(context, [], ["new-warning"]);
    }),
    createDoctorHealthContribution("doctor:healthy", "test-healthy", async () => {}),
  ]);

  expect(ctx.updateWarnings).toEqual(warnings);
  for (const label of ["test-repeat", "test-overflow"]) {
    expect(ctx.runtime.log).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^Doctor: ${label} warning \\(\\d+ms\\)$`)),
    );
  }
  expect(ctx.runtime.log).toHaveBeenCalledWith(
    expect.stringMatching(/^Doctor: test-healthy completed \(\d+ms\)$/),
  );
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
