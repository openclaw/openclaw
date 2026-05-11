import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveDoctorHealthContributions,
  shouldSkipLegacyUpdateDoctorConfigWrite,
} from "./doctor-health-contributions.js";

const mocks = vi.hoisted(() => ({
  maybeRunConfiguredPluginInstallReleaseStep: vi.fn(),
  note: vi.fn(),
  replaceConfigFile: vi.fn(),
  logConfigUpdated: vi.fn(),
  applyWizardMetadata: vi.fn((cfg: unknown) => cfg),
  formatCliCommand: vi.fn((cmd: string) => cmd),
  shortenHomePath: vi.fn((p: string) => p),
}));

vi.mock("../commands/doctor/shared/release-configured-plugin-installs.js", () => ({
  maybeRunConfiguredPluginInstallReleaseStep: mocks.maybeRunConfiguredPluginInstallReleaseStep,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("../version.js", () => ({
  VERSION: "2026.5.2-test",
}));

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/mock/.openclaw/openclaw.json",
  replaceConfigFile: (...args: unknown[]) => mocks.replaceConfigFile(...args),
}));

vi.mock("../config/logging.js", () => ({
  logConfigUpdated: (...args: unknown[]) => mocks.logConfigUpdated(...args),
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  applyWizardMetadata: (...args: Parameters<typeof mocks.applyWizardMetadata>) =>
    mocks.applyWizardMetadata(...args),
}));

vi.mock("../cli/command-format.js", () => ({
  formatCliCommand: (...args: Parameters<typeof mocks.formatCliCommand>) =>
    mocks.formatCliCommand(...args),
}));

vi.mock("../utils.js", () => ({
  shortenHomePath: (...args: Parameters<typeof mocks.shortenHomePath>) =>
    mocks.shortenHomePath(...args),
}));

function requireDoctorContribution(id: string) {
  const contribution = resolveDoctorHealthContributions().find((entry) => entry.id === id);
  if (!contribution) {
    throw new Error(`expected doctor contribution ${id}`);
  }
  return contribution;
}

describe("doctor health contributions", () => {
  beforeEach(() => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockReset();
    mocks.note.mockReset();
  });

  it("runs release configured plugin install repair before plugin registry and final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:release-configured-plugin-installs")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:plugin-registry")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:release-configured-plugin-installs")).toBeLessThan(
      ids.indexOf("doctor:plugin-registry"),
    );
    expect(ids.indexOf("doctor:plugin-registry")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("keeps release configured plugin installs repair-only", async () => {
    const contribution = requireDoctorContribution("doctor:release-configured-plugin-installs");
    const ctx = {
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.4.29" },
      sourceConfigValid: true,
      prompter: { shouldRepair: false },
      env: {},
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.maybeRunConfiguredPluginInstallReleaseStep).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("stamps release configured plugin installs after repair changes", async () => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockResolvedValue({
      changes: ["Installed configured plugin matrix."],
      warnings: [],
      touchedConfig: true,
    });
    const contribution = requireDoctorContribution("doctor:release-configured-plugin-installs");
    const ctx = {
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.4.29" },
      sourceConfigValid: true,
      prompter: { shouldRepair: true },
      env: {},
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.maybeRunConfiguredPluginInstallReleaseStep).toHaveBeenCalledWith({
      cfg: {},
      env: {},
      touchedVersion: "2026.4.29",
    });
    expect(mocks.note).toHaveBeenCalledWith(
      "Installed configured plugin matrix.",
      "Doctor changes",
    );
    expect(ctx.cfg.meta?.lastTouchedVersion).toBe("2026.5.2-test");
  });

  it("checks command owner configuration before final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:command-owner")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:command-owner")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("checks skill readiness before final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:skills")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:skills")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("skips doctor config writes under legacy update parents", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      }),
    ).toBe(true);
  });

  it("keeps doctor writes outside legacy update writable", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: {},
      }),
    ).toBe(false);
  });

  it("keeps current update parents writable", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        },
      }),
    ).toBe(false);
  });

  it("treats falsey update env values as normal writes", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "0",
        },
      }),
    ).toBe(false);
  });

  describe("doctor:write-config trailer", () => {
    function makeWriteConfigCtx(
      opts: { shouldWriteConfig?: boolean; shouldRepair?: boolean; cfgDirty?: boolean } = {},
    ) {
      const cfg = { meta: {} } as Parameters<
        ReturnType<typeof resolveDoctorHealthContributions>[number]["run"]
      >[0]["cfg"];
      const cfgForPersistence = opts.cfgDirty ? ({ meta: { dirty: true } } as typeof cfg) : cfg;
      const logMock = vi.fn();
      return {
        ctx: {
          cfg,
          cfgForPersistence,
          configResult: { cfg, shouldWriteConfig: opts.shouldWriteConfig ?? false },
          sourceConfigValid: true,
          prompter: { shouldRepair: opts.shouldRepair ?? false },
          configPath: "/mock/.openclaw/openclaw.json",
          options: {},
          runtime: { log: logMock, error: vi.fn(), warn: vi.fn() },
          env: {},
        } as unknown as Parameters<
          ReturnType<typeof resolveDoctorHealthContributions>[number]["run"]
        >[0],
        logMock,
      };
    }

    beforeEach(() => {
      mocks.replaceConfigFile.mockResolvedValue(undefined);
      mocks.logConfigUpdated.mockReturnValue(undefined);
      mocks.applyWizardMetadata.mockImplementation((cfg: unknown) => cfg);
    });

    it("suppresses trailer on clean run with no pending changes", async () => {
      const contribution = requireDoctorContribution("doctor:write-config");
      const { ctx, logMock } = makeWriteConfigCtx({
        shouldWriteConfig: false,
        shouldRepair: false,
      });

      await contribution.run(ctx);

      expect(logMock).not.toHaveBeenCalledWith(expect.stringContaining("to apply changes"));
    });

    it("suppresses trailer on write even when --fix was not passed (hint emitted upstream by finalize flow)", async () => {
      const contribution = requireDoctorContribution("doctor:write-config");
      const { ctx, logMock } = makeWriteConfigCtx({ shouldWriteConfig: true, shouldRepair: false });

      await contribution.run(ctx);

      expect(logMock).not.toHaveBeenCalledWith(expect.stringContaining("to apply changes"));
    });

    it("suppresses trailer when pending changes exist but --fix was passed", async () => {
      const contribution = requireDoctorContribution("doctor:write-config");
      const { ctx, logMock } = makeWriteConfigCtx({ shouldWriteConfig: true, shouldRepair: true });

      await contribution.run(ctx);

      expect(logMock).not.toHaveBeenCalledWith(expect.stringContaining("to apply changes"));
    });
  });
});
