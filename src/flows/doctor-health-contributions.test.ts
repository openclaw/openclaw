import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveDoctorHealthContributions,
  shouldSkipLegacyUpdateDoctorConfigWrite,
} from "./doctor-health-contributions.js";

const mocks = vi.hoisted(() => ({
  maybeRunConfiguredPluginInstallReleaseStep: vi.fn(),
  note: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
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
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

describe("doctor health contributions", () => {
  beforeEach(() => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockReset();
    mocks.note.mockReset();
    mocks.readConfigFileSnapshot.mockReset();
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
    const contribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:release-configured-plugin-installs",
    );
    expect(contribution).toBeDefined();
    const ctx = {
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.4.29" },
      sourceConfigValid: true,
      prompter: { shouldRepair: false },
      env: {},
    } as Parameters<NonNullable<typeof contribution>["run"]>[0];

    await contribution?.run(ctx);

    expect(mocks.maybeRunConfiguredPluginInstallReleaseStep).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("stamps release configured plugin installs after repair changes", async () => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockResolvedValue({
      changes: ["Installed configured plugin matrix."],
      warnings: [],
      touchedConfig: true,
    });
    const contribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:release-configured-plugin-installs",
    );
    expect(contribution).toBeDefined();
    const ctx = {
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.4.29" },
      sourceConfigValid: true,
      prompter: { shouldRepair: true },
      env: {},
    } as Parameters<NonNullable<typeof contribution>["run"]>[0];

    await contribution?.run(ctx);

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

  describe("doctor:final-config-validation", () => {
    const previousExitCode = process.exitCode;

    afterEach(() => {
      process.exitCode = previousExitCode;
    });

    function getFinalConfigValidation() {
      const contribution = resolveDoctorHealthContributions().find(
        (entry) => entry.id === "doctor:final-config-validation",
      );
      if (!contribution) {
        throw new Error("doctor:final-config-validation contribution not registered");
      }
      return contribution;
    }

    function buildCtx(): Parameters<ReturnType<typeof getFinalConfigValidation>["run"]>[0] {
      const errors: string[] = [];
      return {
        runtime: {
          error: (msg: string) => errors.push(msg),
        },
      } as unknown as Parameters<ReturnType<typeof getFinalConfigValidation>["run"]>[0];
    }

    it("sets exitCode=1 and reports issues when final snapshot is invalid", async () => {
      process.exitCode = 0;
      mocks.readConfigFileSnapshot.mockResolvedValue({
        exists: true,
        valid: false,
        issues: [
          {
            path: "models.providers.bailian.models.0.compat.thinkingFormat",
            message: "Invalid input",
          },
        ],
      });

      await getFinalConfigValidation().run(buildCtx());

      expect(process.exitCode).toBe(1);
    });

    it("leaves exitCode untouched when final snapshot is valid", async () => {
      process.exitCode = 0;
      mocks.readConfigFileSnapshot.mockResolvedValue({
        exists: true,
        valid: true,
        issues: [],
      });

      await getFinalConfigValidation().run(buildCtx());

      expect(process.exitCode).toBe(0);
    });

    it("leaves exitCode untouched when config does not exist", async () => {
      process.exitCode = 0;
      mocks.readConfigFileSnapshot.mockResolvedValue({
        exists: false,
        valid: false,
        issues: [],
      });

      await getFinalConfigValidation().run(buildCtx());

      expect(process.exitCode).toBe(0);
    });

    it("does not lower a non-zero exitCode set earlier in the run", async () => {
      process.exitCode = 2;
      mocks.readConfigFileSnapshot.mockResolvedValue({
        exists: true,
        valid: false,
        issues: [{ path: "x", message: "y" }],
      });

      await getFinalConfigValidation().run(buildCtx());

      expect(process.exitCode).toBe(2);
    });
  });
});
