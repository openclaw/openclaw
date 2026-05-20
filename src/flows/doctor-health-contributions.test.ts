import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorPrompter } from "../commands/doctor-prompter.js";
import {
  resolveDoctorHealthContributions,
  shouldSkipLegacyUpdateDoctorConfigWrite,
} from "./doctor-health-contributions.js";

const mocks = vi.hoisted(() => ({
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
  resolveGatewayService: vi.fn(),
  ensureSystemdUserLingerInteractive: vi.fn(),
  detectSystemdUserLingerFindings: vi.fn(),
  repairSystemdUserLingerFinding: vi.fn(),
  maybeRunDoctorStartupChannelMaintenance: vi.fn(),
  detectShellCompletionHealth: vi.fn(),
  repairShellCompletionHealth: vi.fn(),
  registerBundledHealthChecks: vi.fn(),
  noteChromeMcpBrowserReadiness: vi.fn(),
  detectLegacyClawdBrowserProfileResidue: vi.fn(),
  maybeArchiveLegacyClawdBrowserProfileResidue: vi.fn(),
}));

vi.mock("../commands/doctor/shared/release-configured-plugin-installs.js", () => ({
  maybeRunConfiguredPluginInstallReleaseStep: mocks.maybeRunConfiguredPluginInstallReleaseStep,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("../version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../version.js")>();
  return {
    ...actual,
    VERSION: "2026.5.2-test",
  };
});

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

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    shortenHomePath: mocks.shortenHomePath,
  };
});

vi.mock("../cli/command-format.js", () => ({
  formatCliCommand: mocks.formatCliCommand,
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: mocks.resolveGatewayService,
}));

vi.mock("../commands/systemd-linger.js", () => ({
  SYSTEMD_GATEWAY_LINGER_REASON:
    "Gateway runs as a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
  ensureSystemdUserLingerInteractive: mocks.ensureSystemdUserLingerInteractive,
  detectSystemdUserLingerFindings: mocks.detectSystemdUserLingerFindings,
  repairSystemdUserLingerFinding: mocks.repairSystemdUserLingerFinding,
}));

vi.mock("./doctor-startup-channel-maintenance.js", () => ({
  maybeRunDoctorStartupChannelMaintenance: mocks.maybeRunDoctorStartupChannelMaintenance,
}));

vi.mock("./bundled-health-checks.js", () => ({
  registerBundledHealthChecks: mocks.registerBundledHealthChecks,
}));

vi.mock("../commands/doctor-completion.js", () => ({
  detectShellCompletionHealth: mocks.detectShellCompletionHealth,
  repairShellCompletionHealth: mocks.repairShellCompletionHealth,
}));

vi.mock("../commands/doctor-browser.js", () => ({
  noteChromeMcpBrowserReadiness: mocks.noteChromeMcpBrowserReadiness,
  detectLegacyClawdBrowserProfileResidue: mocks.detectLegacyClawdBrowserProfileResidue,
  maybeArchiveLegacyClawdBrowserProfileResidue: mocks.maybeArchiveLegacyClawdBrowserProfileResidue,
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
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockReset();
    mocks.note.mockReset();
    mocks.readConfigFileSnapshot.mockReset();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      issues: [],
    });
    mocks.resolveGatewayService.mockReset();
    mocks.resolveGatewayService.mockReturnValue({
      isLoaded: vi.fn(async () => true),
    });
    mocks.ensureSystemdUserLingerInteractive.mockReset();
    mocks.ensureSystemdUserLingerInteractive.mockResolvedValue(undefined);
    mocks.detectSystemdUserLingerFindings.mockReset();
    mocks.detectSystemdUserLingerFindings.mockResolvedValue([
      {
        kind: "disabled",
        user: "alice",
        message: "Gateway needs lingering.",
        fixHint: "Run manually: sudo loginctl enable-linger alice",
      },
    ]);
    mocks.repairSystemdUserLingerFinding.mockReset();
    mocks.repairSystemdUserLingerFinding.mockResolvedValue({
      status: "repaired",
      changes: ["Enabled systemd lingering for alice."],
      warnings: [],
    });
    mocks.maybeRunDoctorStartupChannelMaintenance.mockReset();
    mocks.maybeRunDoctorStartupChannelMaintenance.mockResolvedValue(undefined);
    mocks.detectShellCompletionHealth.mockReset();
    mocks.detectShellCompletionHealth.mockResolvedValue([]);
    mocks.repairShellCompletionHealth.mockReset();
    mocks.repairShellCompletionHealth.mockResolvedValue({
      status: "repaired",
      changes: ["Shell completion repaired."],
      warnings: [],
    });
    mocks.registerBundledHealthChecks.mockReset();
    mocks.noteChromeMcpBrowserReadiness.mockReset();
    mocks.noteChromeMcpBrowserReadiness.mockResolvedValue(undefined);
    mocks.detectLegacyClawdBrowserProfileResidue.mockReset();
    mocks.detectLegacyClawdBrowserProfileResidue.mockResolvedValue(undefined);
    mocks.maybeArchiveLegacyClawdBrowserProfileResidue.mockReset();
    mocks.maybeArchiveLegacyClawdBrowserProfileResidue.mockResolvedValue({
      changes: ["Archived legacy clawd managed browser profile residue."],
      warnings: [],
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

  it("keeps converted structured repairs at their original contribution positions", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids).not.toContain("doctor:structured-health-repairs");
    expect(ids.indexOf("doctor:startup-channel-maintenance")).toBeGreaterThan(
      ids.indexOf("doctor:gateway-services"),
    );
    expect(ids.indexOf("doctor:systemd-linger")).toBeGreaterThan(ids.indexOf("doctor:hooks-model"));
    expect(ids.indexOf("doctor:shell-completion")).toBeGreaterThan(
      ids.indexOf("doctor:bootstrap-size"),
    );
  });

  it("runs multiple positional core repairs without registering bundled checks repeatedly", async () => {
    mocks.detectShellCompletionHealth
      .mockResolvedValueOnce([
        {
          checkId: "core/doctor/shell-completion",
          severity: "warning",
          message: "Shell completion cache is missing.",
          path: "shellCompletion.zsh",
        },
      ])
      .mockResolvedValueOnce([]);
    const ctx = {
      cfg: {
        plugins: {
          entries: {
            policy: {
              enabled: true,
              config: { enabled: true },
            },
          },
        },
      },
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.5.2-test" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      env: { OPENCLAW_TEST: "1" },
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
    } as Parameters<ReturnType<typeof requireDoctorContribution>["run"]>[0];

    await requireDoctorContribution("doctor:startup-channel-maintenance").run(ctx);
    await requireDoctorContribution("doctor:shell-completion").run(ctx);

    expect(mocks.registerBundledHealthChecks).not.toHaveBeenCalled();
  });

  it("runs structured systemd linger repair at the systemd contribution position", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const contribution = requireDoctorContribution("doctor:systemd-linger");
    const ctx = {
      cfg: { gateway: { mode: "local" } },
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.5.2-test" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      env: {},
      cfgForPersistence: { gateway: { mode: "local" } },
      configPath: "/tmp/fake-openclaw.json",
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.repairSystemdUserLingerFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {},
        requireConfirm: true,
      }),
    );
  });

  it("runs structured startup channel maintenance repair at its contribution position", async () => {
    const contribution = requireDoctorContribution("doctor:startup-channel-maintenance");
    const ctx = {
      cfg: { channels: { matrix: { homeserver: "https://matrix.example.org" } } },
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.5.2-test" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      env: { OPENCLAW_TEST: "1" },
      cfgForPersistence: { channels: { matrix: { homeserver: "https://matrix.example.org" } } },
      configPath: "/tmp/fake-openclaw.json",
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.maybeRunDoctorStartupChannelMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        shouldRepair: true,
      }),
    );
  });

  it("previews startup channel maintenance during positional dry-run without side effects", async () => {
    const contribution = requireDoctorContribution("doctor:startup-channel-maintenance");
    const ctx = {
      cfg: { channels: { matrix: { homeserver: "https://matrix.example.org" } } },
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.5.2-test" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { dryRun: true, diff: true },
      env: { OPENCLAW_TEST: "1" },
      cfgForPersistence: { channels: { matrix: { homeserver: "https://matrix.example.org" } } },
      configPath: "/tmp/fake-openclaw.json",
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.maybeRunDoctorStartupChannelMaintenance).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      "Would run channel plugin startup maintenance.",
      "Doctor changes",
    );
  });

  it("runs structured browser residue repair at the browser contribution position", async () => {
    const residue = {
      legacyProfileDir: "/tmp/openclaw-home/browser/clawd",
      legacyUserDataDir: "/tmp/openclaw-home/browser/clawd/user-data",
      canonicalUserDataDir: "/tmp/openclaw-home/browser/openclaw/user-data",
    };
    mocks.detectLegacyClawdBrowserProfileResidue
      .mockResolvedValueOnce(residue)
      .mockResolvedValueOnce(residue)
      .mockResolvedValueOnce(undefined);
    const contribution = requireDoctorContribution("doctor:browser");
    const ctx = {
      cfg: { browser: { profiles: { openclaw: { color: "#FF4500" } } } },
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.5.2-test" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      env: {},
      cfgForPersistence: { browser: { profiles: { openclaw: { color: "#FF4500" } } } },
      configPath: "/tmp/openclaw-home/openclaw.json",
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.noteChromeMcpBrowserReadiness).toHaveBeenCalledWith(ctx.cfg);
    expect(mocks.maybeArchiveLegacyClawdBrowserProfileResidue).toHaveBeenCalledWith(ctx.cfg, {
      configDir: "/tmp/openclaw-home",
    });
  });

  it("passes dry-run and diff into positional structured repairs before doctor exposes the flags", async () => {
    const residue = {
      legacyProfileDir: "/tmp/openclaw-home/browser/clawd",
      legacyUserDataDir: "/tmp/openclaw-home/browser/clawd/user-data",
      canonicalUserDataDir: "/tmp/openclaw-home/browser/openclaw/user-data",
    };
    mocks.detectLegacyClawdBrowserProfileResidue.mockResolvedValue(residue);
    const contribution = requireDoctorContribution("doctor:browser");
    const ctx = {
      cfg: { browser: { profiles: { openclaw: { color: "#FF4500" } } } },
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.5.2-test" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { dryRun: true, diff: true },
      env: {},
      cfgForPersistence: { browser: { profiles: { openclaw: { color: "#FF4500" } } } },
      configPath: "/tmp/openclaw-home/openclaw.json",
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.maybeArchiveLegacyClawdBrowserProfileResidue).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Would archive legacy clawd managed browser profile residue."),
      "Doctor changes",
    );
  });

  it("runs structured shell completion repair at the shell contribution position", async () => {
    mocks.detectShellCompletionHealth
      .mockResolvedValueOnce([
        {
          checkId: "core/doctor/shell-completion",
          severity: "warning",
          message: "Shell completion cache is missing.",
          path: "shellCompletion.zsh",
        },
      ])
      .mockResolvedValueOnce([]);
    const contribution = requireDoctorContribution("doctor:shell-completion");
    const ctx = {
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.5.2-test" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      env: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.repairShellCompletionHealth).toHaveBeenCalledWith({
      options: ctx.options,
      deps: {
        confirm: expect.any(Function),
      },
    });
  });

  it("previews shell completion during positional dry-run without installing completion", async () => {
    mocks.detectShellCompletionHealth.mockResolvedValueOnce([
      {
        checkId: "core/doctor/shell-completion",
        severity: "warning",
        message: "Shell completion cache is missing.",
        path: "shellCompletion.zsh",
      },
    ]);
    const contribution = requireDoctorContribution("doctor:shell-completion");
    const ctx = {
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.5.2-test" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { dryRun: true, diff: true },
      env: {},
      cfgForPersistence: {},
      configPath: "/tmp/fake-openclaw.json",
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.repairShellCompletionHealth).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      "Would repair shell completion setup.",
      "Doctor changes",
    );
  });

  it("previews systemd linger during positional dry-run without enabling linger", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const contribution = requireDoctorContribution("doctor:systemd-linger");
    const ctx = {
      cfg: { gateway: { mode: "local" } },
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.5.2-test" },
      sourceConfigValid: true,
      prompter: buildDoctorPrompter(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { dryRun: true, diff: true },
      env: {},
      cfgForPersistence: { gateway: { mode: "local" } },
      configPath: "/tmp/fake-openclaw.json",
    } as Parameters<(typeof contribution)["run"]>[0];

    await contribution.run(ctx);

    expect(mocks.repairSystemdUserLingerFinding).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      "Would enable systemd lingering if it is disabled for the Gateway user.",
      "Doctor changes",
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
