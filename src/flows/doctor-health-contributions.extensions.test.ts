import { describe, expect, it, vi } from "vitest";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import {
  setupDoctorHealthContributionsFixture,
  mocks,
  requireDoctorContribution,
  type DoctorContributionRunContext,
  createDoctorContext,
  setRegisteredHealthChecks,
} from "./doctor-health-contributions-suite.test-support.js";
import { runDoctorHealthContributionList } from "./doctor-health-contributions.test-support.js";
import { getHealthCheck } from "./health-check-registry.js";
import type { HealthFinding } from "./health-checks.js";

// Install shared mocks before the production imports, regardless of import sorting.
await vi.hoisted(() => import("./doctor-health-contributions-suite.test-support.js"));

describe("doctor health contributions", () => {
  setupDoctorHealthContributionsFixture();

  it("lets structured health own execution when legacy run is omitted", async () => {
    const healthChecks = {
      description: "test structured run",
      detect: vi.fn(async () => []),
    };
    mocks.runDoctorHealthRepairs.mockResolvedValue({
      config: { updated: true },
      findings: [],
      remainingFindings: [],
      changes: ["changed from structured health"],
      warnings: ["structured warning"],
      diffs: [],
      effects: [],
      checksRun: 1,
      checksRepaired: 1,
      checksValidated: 0,
    });
    const contribution = createDoctorHealthContribution(
      "doctor:test-structured-run",
      "Test structured run",
      {
        healthChecks,
      },
    );
    const ctx = createDoctorContext({
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
      shouldRepair: true,
    });

    await contribution.run(ctx);

    expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/openclaw-workspace",
        configPath: "/tmp/fake-openclaw.json",
      }),
      {
        checks: contribution.healthChecks,
        dryRun: false,
      },
    );
    expect(ctx.cfg).toEqual({ updated: true });
    expect(ctx.cfgForPersistence).toEqual({});
    expect(ctx.runtime.error).toHaveBeenCalledWith("structured warning");
    expect(ctx.runtime.log).not.toHaveBeenCalledWith("changed from structured health");
    expect(ctx.configResult.pendingChangePanels).toEqual(["changed from structured health"]);
  });

  it("leaves workspace scope unset for explicit multi-agent config", async () => {
    mocks.tryResolveSoleAgentId.mockReturnValue(undefined);
    const runWithPluginMetadataSnapshot = vi.fn((_scope: unknown, run: () => unknown) =>
      run(),
    ) as unknown as NonNullable<DoctorContributionRunContext["runWithPluginMetadataSnapshot"]>;
    const contribution = createDoctorHealthContribution(
      "doctor:test-workspace-scope",
      "Test workspace scope",
      {
        healthChecks: {
          description: "test workspace scope",
          detect: vi.fn(async () => []),
        },
      },
    );
    const ctx = createDoctorContext({
      cfg: { agents: { ownership: "explicit" } },
      cfgForPersistence: {},
      configResult: { cfg: {} },
      shouldRepair: true,
      env: {},
      runWithPluginMetadataSnapshot,
    });

    await runDoctorHealthContributionList(ctx, [contribution]);

    expect(runWithPluginMetadataSnapshot).toHaveBeenCalledWith(
      { config: ctx.cfg, workspaceDir: undefined },
      expect.any(Function),
    );
    expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: undefined }),
      {
        checks: contribution.healthChecks,
        dryRun: false,
      },
    );
    expect(mocks.resolveAgentWorkspaceDir).not.toHaveBeenCalled();
  });

  it("renders findings from structured health when legacy run is omitted", async () => {
    const healthChecks = {
      description: "test structured findings",
      detect: vi.fn(async () => []),
    };
    mocks.runDoctorHealthRepairs.mockResolvedValue({
      config: {},
      findings: [
        {
          checkId: "core/doctor/test-structured-findings",
          severity: "warning",
          message: "structured finding needs attention",
          path: "openclaw.json",
          line: 12,
          fixHint: "run openclaw doctor --fix",
        },
      ],
      remainingFindings: [],
      changes: [],
      warnings: [],
      diffs: [],
      effects: [],
      checksRun: 1,
      checksRepaired: 0,
      checksValidated: 0,
    });
    const contribution = createDoctorHealthContribution(
      "doctor:test-structured-findings",
      "Test structured findings",
      {
        healthChecks,
      },
    );
    const ctx = createDoctorContext({
      cfg: {},
      cfgForPersistence: {},
      configResult: { cfg: {} },
    });

    await contribution.run(ctx);

    expect(ctx.runtime.log).toHaveBeenCalledWith(
      "[warning] core/doctor/test-structured-findings openclaw.json:12 - structured finding needs attention",
    );
    expect(ctx.runtime.log).toHaveBeenCalledWith("  fix: run openclaw doctor --fix");
  });

  it("requires explicit health check ids for multi-check contributions", () => {
    expect(() =>
      createDoctorHealthContribution("doctor:test-multiple-checks", "Test multiple checks", {
        healthChecks: [
          {
            description: "first",
            detect: vi.fn(async () => []),
          },
          {
            description: "second",
            detect: vi.fn(async () => []),
          },
        ],
      }),
    ).toThrow("must specify health check ids when it declares multiple healthChecks");
  });

  it("skips opt-in extension checks during routine repair", async () => {
    setRegisteredHealthChecks([
      { id: "core/example/internal", kind: "core" },
      { id: "plugin/example/regular", kind: "plugin" },
      { id: "plugin/example/opt-in", kind: "plugin", defaultEnabled: false },
    ]);
    const contribution = requireDoctorContribution("doctor:structured-health-repairs");
    const ctx = createDoctorContext({
      cfg: {},
      configResult: { cfg: {} },
      cfgForPersistence: {},
      shouldRepair: true,
      env: { OPENCLAW_UPDATE_POST_CORE: "1" },
    });

    await contribution.run(ctx);

    expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(
      expect.objectContaining({ env: { OPENCLAW_UPDATE_POST_CORE: "1" } }),
      { checks: [getHealthCheck("plugin/example/regular")] },
    );
  });

  it("retains extension repair warnings without resolved or non-warning findings", async () => {
    const checkId = "plugin/example/probe";
    const contribution = requireDoctorContribution("doctor:structured-health-repairs");
    const ctx = createDoctorContext({
      cfg: {},
      configResult: { cfg: {} },
      cfgForPersistence: {},
      shouldRepair: true,
      env: { OPENCLAW_UPDATE_POST_CORE: "1" },
      updateWarnings: ["earlier warning"],
    });
    const remainingFindings: HealthFinding[] = [
      { checkId, severity: "warning", message: "optional maintenance incomplete" },
      { checkId, severity: "error", message: "required artifact missing" },
      { checkId, severity: "info", message: "optional setup is available" },
    ];
    mocks.runDoctorHealthRepairs.mockResolvedValue({
      config: {},
      changes: [],
      warnings: ["optional repair unavailable"],
      remainingFindings,
      findings: [
        ...remainingFindings,
        { checkId, severity: "warning", message: "already repaired" },
      ],
    });

    await contribution.run(ctx);

    expect(ctx.updateWarnings).toEqual([
      "earlier warning",
      `${checkId}: optional maintenance incomplete`,
      "optional repair unavailable",
    ]);
    expect(ctx.runtime.log).toHaveBeenCalledWith(
      `[warning] ${checkId} - optional maintenance incomplete`,
    );
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      `[error] ${checkId} - required artifact missing`,
    );
    expect(ctx.runtime.exit).not.toHaveBeenCalled();
  });

  it.each(["warning", "info"] as const)(
    "records %s finding-only output without changing health or exit policy",
    async (severity) => {
      const contribution = requireDoctorContribution("doctor:model-references");
      const check = CORE_HEALTH_CHECKS.find(
        (entry) => entry.id === "core/doctor/model-references",
      )!;
      vi.spyOn(check, "detect").mockResolvedValue([
        { checkId: check.id, severity, message: "configured model needs attention" },
      ]);
      const ctx = createDoctorContext({ healthOk: true, updateWarnings: ["earlier warning"] });

      await contribution.run(ctx);

      expect(ctx.updateWarnings).toEqual([
        "earlier warning",
        ...(severity === "warning" ? [`${check.id}: configured model needs attention`] : []),
      ]);
      expect(ctx.healthOk).toBe(severity === "info");
      expect(mocks.note).toHaveBeenCalledWith(
        "- configured model needs attention",
        severity === "info" ? "Doctor information" : "Doctor warnings",
      );
      expect(ctx.runtime.exit).not.toHaveBeenCalled();
    },
  );

  it("rejects extension repairs that claim reserved core doctor ids", async () => {
    setRegisteredHealthChecks([
      { id: "plugin/example/unrelated", kind: "plugin" },
      { id: "core/doctor/shell-completion", kind: "plugin" },
    ]);
    const contribution = requireDoctorContribution("doctor:structured-health-repairs");
    const ctx = createDoctorContext({
      cfg: {},
      configResult: { cfg: {} },
      cfgForPersistence: {},
      shouldRepair: true,
      env: {},
    });

    await expect(contribution.run(ctx)).rejects.toThrow(
      "health check already registered: core/doctor/shell-completion",
    );
    expect(mocks.runDoctorHealthRepairs).not.toHaveBeenCalled();
  });
});
