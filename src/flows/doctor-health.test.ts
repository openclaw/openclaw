import { beforeEach, describe, expect, it, vi } from "vitest";
import { doctorCommand } from "./doctor-health.js";

const mocks = vi.hoisted(() => ({
  assertConfigWriteAllowedInCurrentMode: vi.fn(),
  loadAndMaybeMigrateDoctorConfig: vi.fn().mockResolvedValue({
    cfg: {},
    sourceConfigValid: true,
  }),
  maybeOfferUpdateBeforeDoctor: vi.fn().mockResolvedValue({ handled: false, updated: false }),
  maybeRepairUiProtocolFreshness: vi.fn().mockResolvedValue(undefined),
  note: vi.fn(),
  noteSourceInstallIssues: vi.fn(),
  noteStalePluginRuntimeSymlinks: vi.fn().mockResolvedValue(undefined),
  noteStartupOptimizationHints: vi.fn(),
  printWizardHeader: vi.fn(),
  resolveOpenClawPackageRoot: vi.fn().mockResolvedValue("/tmp/openclaw"),
  createDoctorRepairPreviewReport: vi.fn((params: { diff: boolean }) => ({
    mode: "dry-run" as const,
    diff: params.diff,
    checksRun: 0,
    checksRepaired: 0,
    checksValidated: 0,
    findings: [],
    changes: [],
    warnings: [],
    effects: [],
    diffs: [],
    skipped: [],
  })),
  finalizeDoctorRepairPreviewReport: vi.fn((report: unknown) => ({
    ok: false,
    ...(report as Record<string, unknown>),
  })),
  recordDoctorPreviewSkippedContribution: vi.fn(
    (params: {
      report: { skipped: unknown[] };
      id: string;
      label: string;
      healthCheckIds?: readonly string[];
      targets?: readonly string[];
      reason: string;
    }) => {
      params.report.skipped.push({
        id: params.id,
        label: params.label,
        healthCheckIds: params.healthCheckIds ?? [],
        targets: params.targets ?? [],
        reason: params.reason,
      });
    },
  ),
  runDoctorHealthContributions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  printWizardHeader: mocks.printWizardHeader,
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: mocks.resolveOpenClawPackageRoot,
}));

vi.mock("../commands/doctor-update.js", () => ({
  maybeOfferUpdateBeforeDoctor: mocks.maybeOfferUpdateBeforeDoctor,
}));

vi.mock("../commands/doctor-ui.js", () => ({
  maybeRepairUiProtocolFreshness: mocks.maybeRepairUiProtocolFreshness,
}));

vi.mock("../commands/doctor-install.js", () => ({
  noteSourceInstallIssues: mocks.noteSourceInstallIssues,
}));

vi.mock("../commands/doctor/shared/plugin-runtime-symlinks.js", () => ({
  noteStalePluginRuntimeSymlinks: mocks.noteStalePluginRuntimeSymlinks,
}));

vi.mock("../commands/doctor-platform-notes.js", () => ({
  noteStartupOptimizationHints: mocks.noteStartupOptimizationHints,
}));

vi.mock("../commands/doctor-config-flow.js", () => ({
  loadAndMaybeMigrateDoctorConfig: mocks.loadAndMaybeMigrateDoctorConfig,
}));

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/tmp/openclaw.json",
  assertConfigWriteAllowedInCurrentMode: mocks.assertConfigWriteAllowedInCurrentMode,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./doctor-health-contributions.js", () => ({
  createDoctorRepairPreviewReport: mocks.createDoctorRepairPreviewReport,
  finalizeDoctorRepairPreviewReport: mocks.finalizeDoctorRepairPreviewReport,
  recordDoctorPreviewSkippedContribution: mocks.recordDoctorPreviewSkippedContribution,
  runDoctorHealthContributions: mocks.runDoctorHealthContributions,
}));

describe("doctorCommand preview mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadAndMaybeMigrateDoctorConfig.mockResolvedValue({
      cfg: {},
      sourceConfigValid: true,
    });
    mocks.maybeOfferUpdateBeforeDoctor.mockResolvedValue({ handled: false, updated: false });
    mocks.resolveOpenClawPackageRoot.mockResolvedValue("/tmp/openclaw");
    delete process.env.OPENCLAW_SUPPRESS_NOTES;
  });

  it("treats dry-run as repair preview without allowing legacy UI repair side effects", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await doctorCommand(runtime, { dryRun: true, diff: true });

    expect(mocks.assertConfigWriteAllowedInCurrentMode).not.toHaveBeenCalled();
    expect(mocks.maybeOfferUpdateBeforeDoctor).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ dryRun: true, diff: true, repair: true }),
      }),
    );
    expect(mocks.maybeRepairUiProtocolFreshness).not.toHaveBeenCalled();
    expect(mocks.loadAndMaybeMigrateDoctorConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          dryRun: true,
          diff: true,
          repair: false,
          yes: false,
          generateGatewayToken: false,
        }),
        preflight: {
          migrateState: false,
          migrateLegacyConfig: false,
        },
      }),
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Skipped UI freshness repair during doctor preview."),
      "Doctor preview",
    );
    expect(mocks.runDoctorHealthContributions).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ dryRun: true, diff: true, repair: true }),
      }),
    );
  });

  it("treats diff-only direct calls as dry-run repair previews", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await doctorCommand(runtime, { diff: true });

    expect(mocks.assertConfigWriteAllowedInCurrentMode).not.toHaveBeenCalled();
    expect(mocks.maybeRepairUiProtocolFreshness).not.toHaveBeenCalled();
    expect(mocks.loadAndMaybeMigrateDoctorConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ dryRun: true, diff: true, repair: false }),
        preflight: {
          migrateState: false,
          migrateLegacyConfig: false,
        },
      }),
    );
    expect(mocks.runDoctorHealthContributions).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ dryRun: true, diff: true, repair: true }),
      }),
    );
  });

  it("disables config-flow confirmation during preview runs", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await doctorCommand(runtime, { dryRun: true, yes: true, generateGatewayToken: true });

    const [{ confirm }] = mocks.loadAndMaybeMigrateDoctorConfig.mock.calls[0] as [
      {
        confirm: (params: { message: string; initialValue: boolean }) => Promise<boolean>;
      },
    ];
    await expect(confirm({ message: "Apply?", initialValue: true })).resolves.toBe(false);
    expect(mocks.loadAndMaybeMigrateDoctorConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        preflight: {
          migrateState: false,
          migrateLegacyConfig: false,
        },
      }),
    );
    expect(mocks.runDoctorHealthContributions).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          dryRun: true,
          repair: true,
          yes: true,
          generateGatewayToken: true,
        }),
      }),
    );
  });

  it("keeps normal repair runs on the legacy UI repair path and write guard", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await doctorCommand(runtime, { repair: true });

    expect(mocks.assertConfigWriteAllowedInCurrentMode).toHaveBeenCalledTimes(1);
    expect(mocks.maybeRepairUiProtocolFreshness).toHaveBeenCalledTimes(1);
    expect(mocks.note).not.toHaveBeenCalledWith(expect.any(String), "Doctor preview");
    expect(mocks.loadAndMaybeMigrateDoctorConfig).toHaveBeenCalledWith(
      expect.not.objectContaining({ preflight: expect.anything() }),
    );
    expect(mocks.runDoctorHealthContributions).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ repair: true }),
      }),
    );
  });

  it("does not run config or health contributions when update fully handles doctor", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    mocks.maybeOfferUpdateBeforeDoctor.mockResolvedValueOnce({ handled: true, updated: true });

    await doctorCommand(runtime, { dryRun: true });

    expect(mocks.maybeRepairUiProtocolFreshness).not.toHaveBeenCalled();
    expect(mocks.loadAndMaybeMigrateDoctorConfig).not.toHaveBeenCalled();
    expect(mocks.runDoctorHealthContributions).not.toHaveBeenCalled();
  });

  it("writes a structured JSON dry-run report with skipped legacy preflights", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await doctorCommand(runtime, { dryRun: true, diff: true, json: true });

    expect(mocks.printWizardHeader).not.toHaveBeenCalled();
    expect(mocks.createDoctorRepairPreviewReport).toHaveBeenCalledWith({ diff: true });
    expect(mocks.recordDoctorPreviewSkippedContribution).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "doctor:ui-freshness",
        targets: ["core/doctor/ui-freshness"],
      }),
    );
    expect(mocks.runDoctorHealthContributions).toHaveBeenCalledWith(
      expect.objectContaining({
        previewReport: expect.objectContaining({
          mode: "dry-run",
          diff: true,
          skipped: [
            expect.objectContaining({
              id: "doctor:ui-freshness",
              targets: ["core/doctor/ui-freshness"],
            }),
            expect.objectContaining({
              id: "doctor:config-flow",
              targets: ["doctor-config-flow"],
            }),
          ],
        }),
      }),
    );
    expect(write).toHaveBeenCalledTimes(1);
    const json = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(json).toMatchObject({
      ok: false,
      mode: "dry-run",
      diff: true,
      skipped: [
        expect.objectContaining({
          id: "doctor:ui-freshness",
          targets: ["core/doctor/ui-freshness"],
        }),
        expect.objectContaining({
          id: "doctor:config-flow",
          targets: ["doctor-config-flow"],
        }),
      ],
    });
    expect(process.env.OPENCLAW_SUPPRESS_NOTES).toBeUndefined();
    write.mockRestore();
  });
});
