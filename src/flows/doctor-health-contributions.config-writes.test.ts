import { describe, expect, it, vi } from "vitest";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import {
  setupDoctorHealthContributionsFixture,
  mocks,
  requireDoctorContribution,
  type DoctorContributionRunContext,
  createDoctorContext,
  createDoctorLintFixture,
} from "./doctor-health-contributions-suite.test-support.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
  createGatewayWriterFixture,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";
import { runDoctorLintChecks } from "./doctor-lint-flow.js";
import type { HealthCheck } from "./health-checks.js";

// Install shared mocks before the production imports, regardless of import sorting.
await vi.hoisted(() => import("./doctor-health-contributions-suite.test-support.js"));

describe("doctor health contributions", () => {
  setupDoctorHealthContributionsFixture();

  it("stops after an optional contribution fails after writing config", async () => {
    const laterRun = vi.fn(async () => undefined);
    const ctx = createDoctorContext({ env: {} });
    const failure = new ConfigWritePostCommitError({
      configPath: ctx.configPath,
      rollbackStatus: "not-restored",
      cause: new Error("config path changed since last load"),
    });

    await expect(
      runDoctorHealthContributionList(ctx, [
        createDoctorHealthContribution("doctor:test-config-write", "Test config write", {
          run: async () => {
            throw failure;
          },
        }),
        createDoctorHealthContribution("doctor:test-later", "Test later", laterRun),
      ]),
    ).rejects.toBe(failure);

    expect(laterRun).not.toHaveBeenCalled();
  });

  it("rejects a failed initial config write before later work runs", async () => {
    const laterRun = vi.fn(async () => undefined);
    const cfg = { gateway: { mode: "invalid" } } as unknown as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: { cfg, shouldWriteConfig: true },
      shouldRepair: true,
      env: {},
      updateWarnings: ["earlier warning"],
    });
    mocks.replaceConfigFile.mockRejectedValueOnce(new Error("Config validation failed"));

    await expect(
      runDoctorHealthContributionList(ctx, [
        requireDoctorContribution("doctor:write-config-migrations"),
        createDoctorHealthContribution("doctor:test-later", "Test later", laterRun),
      ]),
    ).rejects.toThrow("Config validation failed");

    expect(laterRun).not.toHaveBeenCalled();
    expect(ctx.configResultWriteCommitted).not.toBe(true);
    expect(ctx.cfgForPersistence).toEqual(cfg);
    expect(ctx.updateWarnings).toEqual(["earlier warning"]);
  });

  it("keeps legacy plugin manifest lint opt-in for structured findings", async () => {
    const contribution = requireDoctorContribution("doctor:legacy-plugin-manifests");
    const check = contribution.healthChecks[0] as HealthCheck & { defaultEnabled?: boolean };
    expect(contribution.healthCheckIds).toEqual(["core/doctor/legacy-plugin-manifests"]);
    expect(check.defaultEnabled).toBe(false);

    const migration = {
      manifestPath: "/tmp/openclaw-plugin/openclaw.plugin.json",
      pluginId: "legacy-plugin",
      nextRaw: {},
      changeLines: ["- moved tools to contracts.tools"],
    };
    mocks.collectLegacyPluginManifestContractMigrations.mockReturnValueOnce([migration]);
    const ctx = createDoctorLintFixture({ plugins: { load: { paths: ["/tmp/openclaw-plugin"] } } });

    expect(mocks.collectLegacyPluginManifestContractMigrations).not.toHaveBeenCalled();

    await expect(
      runDoctorLintChecks(ctx, {
        checks: [check],
        onlyIds: ["core/doctor/legacy-plugin-manifests"],
      }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/legacy-plugin-manifests",
          target: "legacy-plugin",
          requirement: "contracts-capability-keys",
        }),
      ],
    });
    expect(mocks.collectLegacyPluginManifestContractMigrations).toHaveBeenCalledWith({
      config: ctx.cfg,
      env: process.env,
    });
    expect(mocks.legacyPluginManifestContractMigrationToHealthFinding).toHaveBeenCalledWith(
      migration,
      expect.any(Number),
      expect.any(Array),
    );
  });

  it("invalidates retained plugin metadata after rewriting a legacy manifest", async () => {
    mocks.maybeRepairLegacyPluginManifestContracts.mockResolvedValueOnce(true);
    const invalidatePluginMetadataSnapshot = vi.fn();
    const contribution = requireDoctorContribution("doctor:legacy-plugin-manifests");
    const ctx = createDoctorHealthFlowContext({
      cfg: {},
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createDoctorPrompterFixture(true),
      invalidatePluginMetadataSnapshot,
    });

    await contribution.run(ctx);

    expect(invalidatePluginMetadataSnapshot).toHaveBeenCalledOnce();
  });

  it("runs release configured plugin install repair before plugin registry and final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:release-configured-plugin-installs")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:plugin-registry")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:release-configured-plugin-installs")).toBeLessThan(
      ids.indexOf("doctor:plugin-registry"),
    );
    expect(ids.indexOf("doctor:plugin-registry")).toBeLessThan(ids.indexOf("doctor:write-config"));
    expect(ids.indexOf("doctor:plugin-registry")).toBeLessThan(
      ids.indexOf("doctor:runtime-tool-schemas"),
    );
  });

  it("repairs canonical session rows before downstream agent-state checks", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:legacy-state")).toBeLessThan(
      ids.indexOf("doctor:session-transcripts"),
    );
    expect(ids.indexOf("doctor:session-transcripts")).toBeLessThan(
      ids.indexOf("doctor:agent-memory-schema"),
    );
    expect(ids.indexOf("doctor:session-transcripts")).toBeLessThan(
      ids.indexOf("doctor:plugin-registry"),
    );
  });

  it("commits config migrations before reporting a runtime schema diagnostic failure", async () => {
    const cfg = { channels: { discord: { streaming: { mode: "partial" } } } } as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: { cfg, shouldWriteConfig: true },
      shouldRepair: true,
      env: {},
    });
    const failure = new Error("runtime plugin schema inspection failed");
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/runtime-tool-schemas",
    )!;
    const detect = vi.spyOn(check, "detect").mockRejectedValueOnce(failure);
    const contributions = resolveDoctorHealthContributions().filter((entry) =>
      ["doctor:write-config-migrations", "doctor:runtime-tool-schemas"].includes(entry.id),
    );

    await runDoctorHealthContributionList(ctx, contributions);

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(detect).toHaveBeenCalledOnce();
    expect(mocks.replaceConfigFile).toHaveBeenCalledBefore(detect);
    expect(ctx.configResultWriteCommitted).toBe(true);
    expect(ctx.cfgForPersistence).toEqual(cfg);
    const warning = `doctor:runtime-tool-schemas run failed: ${failure.message}`;
    expect(mocks.note).toHaveBeenCalledWith(warning, "Doctor warnings");
    expect(ctx.updateWarnings).toContain(warning);
    expect(ctx.runtime.exit).not.toHaveBeenCalled();
  });

  it("reports unapplied fixes and holds change panels when write validation refuses the candidate", async () => {
    // Regression: unknown root key repaired + type error elsewhere. Doctor used to
    // print "Doctor changes — gatway", then crash with a raw Error and persist nothing.
    const cfg = {
      agents: { defaults: { heartbeat: { every: 5 } } },
    } as unknown as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: {
        cfg,
        shouldWriteConfig: true,
        pendingChangePanels: ["- gatway"],
      },
      sourceConfigValid: false,
      shouldRepair: true,
      options: { nonInteractive: true, repair: true },
      env: {},
    });
    const pendingWarnings = [
      "Deferred legacy agent/session migration: select an agent owner",
      "Second pending owner needs operator input",
      ...Array.from({ length: 20 }, (_, index) => `Test owner ${index + 1} is blocked`),
    ];
    mocks.detectLegacyStateMigrations.mockResolvedValue({
      preview: [],
      warnings: pendingWarnings,
      notices: [],
    });
    mocks.replaceConfigFile.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "Config validation failed: agents.defaults.heartbeat.every: Invalid input: expected string, received number",
        ),
        {
          code: "CONFIG_VALIDATION_FAILED",
          issues: [
            {
              path: "agents.defaults.heartbeat.every",
              message: "Invalid input: expected string, received number",
            },
          ],
        },
      ),
    );

    const laterRun = vi.fn(async () => undefined);
    await runDoctorHealthContributionList(ctx, [
      requireDoctorContribution("doctor:write-config-migrations"),
      createDoctorHealthContribution("doctor:test-later", "Test later", laterRun),
    ]);

    // The refusal is a rendered warning, not a crash. Later repairs consume the
    // candidate config, so the loop stops before they persist state derived
    // from a config that never reached disk (same invariant as cron deferral).
    expect(laterRun).not.toHaveBeenCalled();
    expect(ctx.configWriteRefusal).toBe("validation");
    expect(ctx.configResultWriteCommitted).not.toBe(true);
    expect(ctx.cfgForPersistence).toEqual(cfg);
    // Never print "Doctor changes" for changes that were not persisted.
    expect(mocks.note).not.toHaveBeenCalledWith(expect.anything(), "Doctor changes");
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("No config changes were written"),
      "Doctor warnings",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("agents.defaults.heartbeat.every"),
      "Doctor warnings",
    );
    const deferredPanels = mocks.note.mock.calls.filter(
      ([, title]) => title === "Legacy state deferred",
    );
    expect(deferredPanels).toHaveLength(1);
    expect(deferredPanels[0]?.[0]).toContain(pendingWarnings[0]);
    expect(deferredPanels[0]?.[0]).toContain(pendingWarnings[1]);
    expect(deferredPanels[0]?.[0]).toContain("2 additional pending entries were omitted");
    expect(deferredPanels[0]?.[0]).toContain("No listed legacy source was removed.");
    expect(deferredPanels[0]?.[0]).toContain("Fix the config errors above.");
    expect(deferredPanels[0]?.[0]).not.toContain("doctor --fix");
    expect(mocks.runLegacyStateMigrations).not.toHaveBeenCalled();

    // A later write pass must not retry the identical candidate or duplicate the warning.
    mocks.note.mockClear();
    mocks.replaceConfigFile.mockClear();
    await requireDoctorContribution("doctor:write-config").run(ctx);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("describes only the failed later write after an earlier pass committed", async () => {
    // First write pass commits; a later health repair then produces a candidate the
    // writer refuses. The warning must not claim the whole run wrote nothing.
    const cfg = { gateway: { mode: "local" } } as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: { cfg, shouldWriteConfig: true },
      shouldRepair: true,
      env: {},
    });

    await requireDoctorContribution("doctor:write-config-migrations").run(ctx);
    expect(ctx.configResultWriteCommitted).toBe(true);

    // A later repair mutates the candidate; the final write pass is refused.
    ctx.cfg = {
      ...ctx.cfg,
      agents: { defaults: { heartbeat: { every: 5 } } },
    } as unknown as OpenClawConfig;
    mocks.note.mockClear();
    mocks.replaceConfigFile.mockRejectedValueOnce(
      Object.assign(new Error("Config validation failed: agents.defaults.heartbeat.every"), {
        code: "CONFIG_VALIDATION_FAILED",
        issues: [
          {
            path: "agents.defaults.heartbeat.every",
            message: "Invalid input: expected string, received number",
          },
        ],
      }),
    );
    await requireDoctorContribution("doctor:write-config").run(ctx);

    expect(ctx.configWriteRefusal).toBe("validation");
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Earlier config fixes were already saved"),
      "Doctor warnings",
    );
    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("No config changes were written"),
      "Doctor warnings",
    );
  });

  it("prints held change panels as Doctor changes only after the write commits", async () => {
    const cfg = { gateway: { mode: "local" } } as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: {
        cfg,
        shouldWriteConfig: true,
        pendingChangePanels: ["- gatway"],
        skipWizardMetadataForIncludeWrite: true,
      },
      shouldRepair: true,
      env: {},
    });

    await requireDoctorContribution("doctor:write-config-migrations").run(ctx);

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(mocks.applyWizardMetadata).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith("- gatway", "Doctor changes");
    expect(ctx.configResultWriteCommitted).toBe(true);
    // Panels print exactly once even when the final writer runs again.
    mocks.note.mockClear();
    await requireDoctorContribution("doctor:write-config").run(ctx);
    expect(mocks.note).not.toHaveBeenCalledWith(expect.anything(), "Doctor changes");
  });

  it("defers every config write after a cron ownership handoff refusal", async () => {
    const laterRun = vi.fn(async () => undefined);
    const cfg = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    } as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: { cfg, shouldWriteConfig: true },
      shouldRepair: true,
      options: { repair: true },
      env: {},
    });
    mocks.detectLegacyStateMigrations.mockResolvedValue({
      preview: ["- Workspace setup and attestations: legacy files → shared SQLite state"],
      warnings: [],
      notices: [],
    });
    mocks.replaceConfigFile.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'Config write refused: cannot inspect cron ownership. Run "openclaw doctor --fix", then retry.',
        ),
        { code: "CONFIG_WRITE_REJECTED", refusal: "cron-owner-safety" },
      ),
    );

    await runDoctorHealthContributionList(ctx, [
      requireDoctorContribution("doctor:write-config-migrations"),
      createDoctorHealthContribution("doctor:test-later", "Test later", laterRun),
    ]);

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(laterRun).not.toHaveBeenCalled();
    expect(ctx.configResultWriteCommitted).not.toBe(true);
    expect(ctx.configWriteRefusal).toBe("cron-owner-safety");
    expect(ctx.cfgForPersistence).toEqual(cfg);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("preserving any retained legacy owner"),
      "Doctor warnings",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Resolve the Gateway or cron-store condition above"),
      "Legacy state deferred",
    );
    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Fix the config errors above"),
      "Legacy state deferred",
    );
    expect(mocks.runLegacyStateMigrations).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "one authored target",
      includeTargets: ["./browser.json"],
      expected: "Repair browser in the included file ./browser.json by hand",
    },
    {
      name: "an include array",
      includeTargets: ["./a.json", "./b.json"],
      expected: "Repair browser in the included files ./a.json, ./b.json by hand",
    },
    {
      name: "no root-authored target",
      includeTargets: undefined,
      expected: "Repair browser in its included file by hand",
    },
  ])(
    "defers every config write after an include-ownership refusal with $name",
    async ({ includeTargets, expected }) => {
      const laterRun = vi.fn(async () => undefined);
      const cfg = {
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      } as OpenClawConfig;
      const ctx = createDoctorContext({
        cfg,
        cfgForPersistence: structuredClone(cfg),
        configResult: { cfg, shouldWriteConfig: true },
        shouldRepair: true,
        options: { repair: true },
        env: {},
      });
      mocks.detectLegacyStateMigrations.mockResolvedValue({
        preview: ["- Workspace setup and attestations: legacy files → shared SQLite state"],
        warnings: [],
        notices: [],
      });
      mocks.replaceConfigFile.mockRejectedValueOnce(
        Object.assign(
          new Error(
            "Config write would flatten $include-owned config at browser; edit that include file directly or remove the $include first.",
          ),
          {
            code: "CONFIG_INCLUDE_OWNERSHIP",
            ownedConfigPath: "browser",
            ...(includeTargets ? { includeTargets } : {}),
          },
        ),
      );

      await runDoctorHealthContributionList(ctx, [
        requireDoctorContribution("doctor:write-config-migrations"),
        createDoctorHealthContribution("doctor:test-later", "Test later", laterRun),
      ]);

      expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
      expect(laterRun).not.toHaveBeenCalled();
      expect(ctx.configResultWriteCommitted).not.toBe(true);
      expect(ctx.configWriteRefusal).toBe("include-ownership");
      expect(ctx.cfgForPersistence).toEqual(cfg);
      expect(mocks.note).toHaveBeenCalledWith(expect.stringContaining(expected), "Doctor warnings");
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining("Repair the include boundary named above by hand"),
        "Legacy state deferred",
      );
      expect(mocks.note).not.toHaveBeenCalledWith(expect.anything(), "Doctor changes");
    },
  );

  it("preserves gateway service config repairs for later doctor writes", async () => {
    const migrationWriteContribution = requireDoctorContribution("doctor:write-config-migrations");
    const gatewayServicesContribution = requireDoctorContribution("doctor:gateway-services");
    const writeConfigContribution = requireDoctorContribution("doctor:write-config");
    const originalCfg = { gateway: {} };
    const { config: repairedCfg, repair } = createGatewayWriterFixture("recovered-token");
    mocks.maybeRepairGatewayServiceConfig.mockImplementationOnce(repair);

    const ctx = createDoctorContext({
      cfg: originalCfg,
      cfgForPersistence: originalCfg,
      configResult: {
        cfg: originalCfg,
        preservedLegacyRootKeys: ["defaultModel"],
        shouldWriteConfig: true,
        skipPluginValidationOnWrite: true,
      },
      shouldRepair: true,
      options: { allowExec: true },
      env: {},
    });

    await migrationWriteContribution.run(ctx);
    await gatewayServicesContribution.run(ctx);
    expect(ctx.cfgForPersistence).toEqual(repairedCfg);
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
    await writeConfigContribution.run(ctx);

    expect(ctx.cfg).toBe(repairedCfg);
    expect(mocks.maybeRepairGatewayServiceConfig).toHaveBeenCalledWith(
      originalCfg,
      "local",
      ctx.runtime,
      ctx.prompter,
      expect.objectContaining({
        allowExecSecretRefs: true,
        writeConfig: expect.any(Function),
      }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
    expect(mocks.replaceConfigFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        nextConfig: originalCfg,
        baseHash: "planning-revision",
        writeOptions: expect.objectContaining({ expectedConfigPath: ctx.configPath }),
      }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nextConfig: repairedCfg,
        baseHash: "committed-revision",
        writeOptions: expect.objectContaining({
          expectedConfigPath: ctx.configPath,
          allowConfigSizeDrop: true,
          preservedLegacyRootKeys: ["defaultModel"],
          skipPluginValidation: true,
        }),
      }),
    );
  });

  it("does not commit deferred cron migration when the config write fails", async () => {
    const cfg = { agents: { defaults: { models: {} } } } as OpenClawConfig;
    mocks.replaceConfigFile.mockRejectedValueOnce(new Error("config write failed"));
    const ctx = {
      cfg,
      cfgForPersistence: cfg,
      configResult: {
        cfg,
        shouldWriteConfig: true,
        shouldRepairCronCodexModelRefsAfterConfigWrite: true,
        confirmedConfigSource: { path: "/tmp/fake-openclaw.json", hash: "planning-revision" },
        blockedCodexModelIdentities: ["codex\u0000gpt-5.6-sol"],
      },
      configPath: "/tmp/fake-openclaw.json",
      sourceConfigValid: true,
      prompter: createDoctorPrompterFixture(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      env: {},
    } as DoctorContributionRunContext;

    await expect(requireDoctorContribution("doctor:write-config").run(ctx)).rejects.toThrow(
      "config write failed",
    );
    expect(mocks.repairCronCodexModelRefsAfterConfigWrite).not.toHaveBeenCalled();
  });

  it("keeps deferred legacy cron migration after the early write without repair mode", async () => {
    const cfg = { agents: { defaults: { models: {} } } } as OpenClawConfig;
    const retiredModelRefConfig = { agents: { defaults: { model: "openai/retired-model" } } };
    const ctx = {
      cfg,
      cfgForPersistence: cfg,
      configResult: {
        cfg,
        shouldWriteConfig: true,
        shouldRepairCronCodexModelRefsAfterConfigWrite: true,
        confirmedConfigSource: { path: "/tmp/fake-openclaw.json", hash: "planning-revision" },
        retiredModelRefConfig,
        blockedCodexModelIdentities: ["codex\u0000gpt-5.6-sol"],
      },
      configPath: "/tmp/fake-openclaw.json",
      sourceConfigValid: true,
      prompter: createDoctorPrompterFixture(false),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
      env: {},
    } as DoctorContributionRunContext;

    await requireDoctorContribution("doctor:write-config-migrations").run(ctx);

    expect(mocks.repairCronCodexModelRefsAfterConfigWrite).not.toHaveBeenCalled();

    await requireDoctorContribution("doctor:write-config").run(ctx);

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(mocks.repairCronCodexModelRefsAfterConfigWrite).toHaveBeenCalledWith({
      cfg,
      retiredModelRefConfig,
      migrateCodexModelRefs: true,
      repairRetiredModelRefs: false,
      blockedModelIdentities: new Set(["codex\u0000gpt-5.6-sol"]),
    });
    expect(mocks.replaceConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.repairCronCodexModelRefsAfterConfigWrite.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
