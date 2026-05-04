import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorPrompter } from "../commands/doctor-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveDoctorHealthContributions,
  shouldSkipLegacyUpdateDoctorConfigWrite,
} from "./doctor-health-contributions.js";

const mocks = vi.hoisted(() => ({
  getModelRefStatus: vi.fn(),
  loadModelCatalog: vi.fn(),
  maybeRunConfiguredPluginInstallReleaseStep: vi.fn(),
  note: vi.fn(),
  replaceConfigFile: vi.fn().mockResolvedValue(undefined),
  readConfigFileSnapshot: vi.fn().mockResolvedValue({
    exists: true,
    valid: true,
    config: {},
    issues: [],
  }),
  applyWizardMetadata: vi.fn((cfg: unknown) => cfg),
  logConfigUpdated: vi.fn(),
  shortenHomePath: vi.fn((p: string) => p),
  formatCliCommand: vi.fn((cmd: string) => cmd),
  resolveConfiguredModelRef: vi.fn(),
}));

vi.mock("../agents/defaults.js", () => ({
  DEFAULT_MODEL: "gpt-5.5",
  DEFAULT_PROVIDER: "openai",
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("../agents/model-selection.js", () => ({
  getModelRefStatus: mocks.getModelRefStatus,
  resolveConfiguredModelRef: mocks.resolveConfiguredModelRef,
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
  CONFIG_PATH: "/tmp/fake-openclaw.json",
  replaceConfigFile: mocks.replaceConfigFile,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  applyWizardMetadata: mocks.applyWizardMetadata,
}));

vi.mock("../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../utils.js", () => ({
  shortenHomePath: mocks.shortenHomePath,
}));

vi.mock("../cli/command-format.js", () => ({
  formatCliCommand: mocks.formatCliCommand,
}));

function requireDoctorContribution(id: string) {
  const contribution = resolveDoctorHealthContributions().find((entry) => entry.id === id);
  if (!contribution) {
    throw new Error(`expected doctor contribution ${id}`);
  }
  return contribution;
}

function buildDoctorPrompter(shouldRepair: boolean): DoctorPrompter {
  return {
    confirm: vi.fn(async () => shouldRepair),
    confirmAutoFix: vi.fn(async () => shouldRepair),
    confirmAggressiveAutoFix: vi.fn(async () => shouldRepair),
    confirmRuntimeRepair: vi.fn(async () => shouldRepair),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair,
    shouldForce: false,
    repairMode: {
      shouldRepair,
      shouldForce: false,
      nonInteractive: true,
      canPrompt: false,
      updateInProgress: false,
    },
  };
}

describe("doctor health contributions", () => {
  beforeEach(() => {
    mocks.getModelRefStatus.mockReset();
    mocks.loadModelCatalog.mockReset();
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockReset();
    mocks.note.mockReset();
    mocks.resolveConfiguredModelRef.mockReset();
    mocks.resolveConfiguredModelRef.mockReturnValue({ provider: "openai", model: "gpt-5.5" });
    mocks.readConfigFileSnapshot.mockReset();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      issues: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      prompter: buildDoctorPrompter(false),
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
      prompter: buildDoctorPrompter(true),
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

  it("keeps legacy parent writable release repairs old-parent-readable", async () => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockResolvedValue({
      changes: ["Installed configured plugin matrix."],
      warnings: [],
      touchedConfig: true,
    });
    const contribution = requireDoctorContribution("doctor:release-configured-plugin-installs");
    const ctx = {
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.5.16-beta.4" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      },
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(ctx.cfg.meta?.lastTouchedVersion).toBe("2026.5.16-beta.4");
    expect(ctx.cfg.meta?.lastTouchedAt).toEqual(expect.any(String));
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

  it("runs structured repairs before legacy skill repairs and config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:structured-health-repairs")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:structured-health-repairs")).toBeLessThan(
      ids.indexOf("doctor:skills"),
    );
    expect(ids.indexOf("doctor:structured-health-repairs")).toBeLessThan(
      ids.indexOf("doctor:write-config"),
    );
  });

  it("skips model allowlist catalog checks when no allowlist is configured", async () => {
    const contribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:model-allowlist-catalog",
    );
    expect(contribution).toBeDefined();

    await contribution?.run(makeHealthContext({}));

    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("warns when provider-supplied catalog rows are hidden by the model allowlist", async () => {
    const contribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:model-allowlist-catalog",
    );
    expect(contribution).toBeDefined();
    mocks.loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
      },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        catalogSource: "provider-supplemental",
      },
      {
        provider: "openai-codex",
        id: "gpt-5.5",
        name: "GPT-5.5 Codex",
        catalogSource: "provider-supplemental",
      },
    ]);
    mocks.getModelRefStatus.mockImplementation(({ ref }) => ({
      key: `${ref.provider}/${ref.model}`,
      inCatalog: true,
      allowAny: false,
      allowed: ref.provider === "openai" && ref.model === "gpt-5.4",
    }));

    await contribution?.run(
      makeHealthContext({
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {},
            },
          },
        },
      } as OpenClawConfig),
    );

    expect(mocks.note).toHaveBeenCalledTimes(1);
    const message = String(mocks.note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("2 provider-supplied catalog models are available");
    expect(message).toContain("openai/gpt-5.5");
    expect(message).toContain("openai-codex/gpt-5.5");
    expect(message).toContain(
      `openclaw config set agents.defaults.models '{"openai/gpt-5.5":{}}' --strict-json --merge`,
    );
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

  describe("config size drops during update", () => {
    beforeEach(() => {
      mocks.replaceConfigFile.mockReset();
      mocks.replaceConfigFile.mockResolvedValue(undefined);
      mocks.applyWizardMetadata.mockImplementation((cfg: unknown) => cfg);
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
    });

    function buildWriteConfigCtx(env: Record<string, string | undefined>) {
      const cfg = { gateway: { mode: "local" } };
      return {
        cfg,
        cfgForPersistence: { gateway: { mode: "remote" } },
        configResult: {
          cfg,
          shouldWriteConfig: true,
          skipPluginValidationOnWrite: false,
        },
        configPath: "/tmp/fake-openclaw.json",
        sourceConfigValid: true,
        prompter: buildDoctorPrompter(true),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: {},
        env,
      } as Parameters<(typeof writeConfigContribution)["run"]>[0];
    }

    const writeConfigContribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:write-config",
    )!;

    it("allows config size drops when OPENCLAW_UPDATE_IN_PROGRESS=1", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      await writeConfigContribution.run(ctx);
      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            allowConfigSizeDrop: true,
          }),
        }),
      );
    });

    it("skips plugin schema validation during update doctor writes", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      await writeConfigContribution.run(ctx);
      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            skipPluginValidation: true,
          }),
        }),
      );
    });

    it("preserves source config version for legacy parent writable update doctor writes", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      ctx.configResult.sourceLastTouchedVersion = "2026.5.16-beta.4";

      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            lastTouchedVersionOverride: "2026.5.16-beta.4",
          }),
        }),
      );
    });

    it("does not preserve source config version for explicit deferral update doctors", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      ctx.configResult.sourceLastTouchedVersion = "2026.5.16-beta.4";

      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.not.objectContaining({
            lastTouchedVersionOverride: expect.anything(),
          }),
        }),
      );
    });

    it("keeps plugin schema validation for ordinary doctor writes", async () => {
      const ctx = buildWriteConfigCtx({});
      await writeConfigContribution.run(ctx);
      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            skipPluginValidation: false,
          }),
        }),
      );
    });

    it("points update-time config rewrites at the pre-update backup", async () => {
      vi.mocked(fs.existsSync).mockImplementation((value) => String(value).endsWith(".pre-update"));
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });

      await writeConfigContribution.run(ctx);

      expect(ctx.runtime.log).toHaveBeenCalledWith(
        "Update changed config; pre-update backup: /tmp/fake-openclaw.json.pre-update",
      );
    });

    it("skips plugin schema validation for final validation during update doctor runs", async () => {
      const contribution = requireDoctorContribution("doctor:final-config-validation");

      await contribution.run({
        cfg: {},
        cfgForPersistence: {},
        configResult: { cfg: {} },
        configPath: "/tmp/fake-openclaw.json",
        sourceConfigValid: true,
        prompter: buildDoctorPrompter(true),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: {},
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
        },
      } as Parameters<(typeof contribution)["run"]>[0]);

      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({
        skipPluginValidation: true,
      });
    });

    it("keeps plugin schema validation for ordinary doctor final validation", async () => {
      const contribution = requireDoctorContribution("doctor:final-config-validation");

      await contribution.run({
        cfg: {},
        cfgForPersistence: {},
        configResult: { cfg: {} },
        configPath: "/tmp/fake-openclaw.json",
        sourceConfigValid: true,
        prompter: buildDoctorPrompter(true),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: {},
        env: {},
      } as Parameters<(typeof contribution)["run"]>[0]);

      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({
        skipPluginValidation: false,
      });
    });

    it("allows allowConfigSizeDrop when not in update", async () => {
      const ctx = buildWriteConfigCtx({});
      await writeConfigContribution.run(ctx);
      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            allowConfigSizeDrop: true,
          }),
        }),
      );
    });
  });
});

function makeHealthContext(cfg: OpenClawConfig) {
  return {
    cfg,
    cfgForPersistence: cfg,
    configPath: "/tmp/openclaw.json",
    configResult: { cfg },
    env: {},
    options: {},
    prompter: { shouldRepair: false },
    runtime: {},
    sourceConfigValid: true,
  } as Parameters<ReturnType<typeof resolveDoctorHealthContributions>[number]["run"]>[0];
}
