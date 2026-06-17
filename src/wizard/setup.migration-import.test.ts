// Setup migration import tests cover importing existing config into onboarding.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  inspectSetupMigrationFreshness,
  isSetupMigrationTargetFresh,
  listSetupMigrationOptions,
  runSetupMigrationImport,
} from "./setup.migration-import.js";

const tempRoots = new Set<string>();
const migrationPlan = vi.hoisted(() => vi.fn());
const migrationApply = vi.hoisted(() => vi.fn());
const resolveStateDir = vi.hoisted(() => vi.fn(() => "/tmp/openclaw-setup-migration-state"));
const resolvePluginMigrationProvider = vi.hoisted(() => vi.fn());
const resolvePluginMigrationProviders = vi.hoisted(() => vi.fn());
const ensureOnboardingPluginInstalled = vi.hoisted(() => vi.fn());

function buildRegisteredMigrationProviders() {
  return [
    {
      id: "codex",
      label: "Codex",
      description: "Import Codex auth and skills.",
      plan: migrationPlan,
      apply: migrationApply,
    },
    {
      id: "hermes",
      label: "Hermes",
      description: "Import Hermes setup.",
      plan: migrationPlan,
      apply: migrationApply,
    },
  ];
}

vi.mock("../plugins/migration-provider-runtime.js", () => {
  return {
    ensureStandaloneMigrationProviderRegistryLoaded: vi.fn(),
    resolvePluginMigrationProvider,
    resolvePluginMigrationProviders,
  };
});

vi.mock("../commands/onboarding-plugin-install.js", () => ({
  ensureOnboardingPluginInstalled,
}));

vi.mock("../commands/migrate/context.js", () => ({
  buildMigrationReportDir: vi.fn(() => "/tmp/openclaw-migration-report"),
  createMigrationLogger: vi.fn(() => ({ debug: vi.fn() })),
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir,
}));

vi.mock("../commands/onboard-config.js", () => ({
  applyLocalSetupWorkspaceConfig: vi.fn((config) => config),
  applySkipBootstrapConfig: vi.fn((config) => config),
}));

vi.mock("../commands/migrate/apply.js", () => ({
  createPreMigrationBackup: vi.fn(async () => undefined),
}));

vi.mock("../commands/migrate/output.js", () => ({
  assertApplySucceeded: vi.fn(),
  assertConflictFreePlan: vi.fn(),
  formatMigrationPreview: vi.fn(() => ["migration preview"]),
  formatMigrationResult: vi.fn(() => ["migration result"]),
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/openclaw-workspace",
  applyWizardMetadata: vi.fn((config) => config),
}));

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-migration-"));
  tempRoots.add(root);
  return root;
}

async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

describe("setup migration import freshness", () => {
  afterEach(async () => {
    for (const root of tempRoots) {
      await fs.rm(root, { force: true, recursive: true });
    }
    tempRoots.clear();
    vi.clearAllMocks();
  });

  it("allows empty config and empty target directories", async () => {
    const root = await makeTempRoot();
    const result = await inspectSetupMigrationFreshness({
      baseConfig: {},
      stateDir: path.join(root, "state"),
      workspaceDir: path.join(root, "workspace"),
    });

    expect(result).toEqual({ fresh: true, reasons: [] });
  });

  it("rejects existing config, workspace files, and state", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    await writeFile(path.join(workspaceDir, "MEMORY.md"), "existing memory\n");
    await writeFile(path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"), "{}\n");

    const result = await inspectSetupMigrationFreshness({
      baseConfig: { gateway: { port: 3131 } },
      stateDir,
      workspaceDir,
    });

    expect(result.fresh).toBe(false);
    expect(result.reasons).toEqual([
      "existing config values are loaded",
      "workspace MEMORY.md exists",
      "state agents/ exists",
    ]);
  });

  it("allows an enabled-only official migration provider after a cancelled import", async () => {
    const root = await makeTempRoot();
    const result = await inspectSetupMigrationFreshness({
      baseConfig: {
        plugins: {
          entries: {
            codex: { enabled: true },
          },
        },
      },
      stateDir: path.join(root, "state"),
      workspaceDir: path.join(root, "workspace"),
    });

    expect(result).toEqual({ fresh: true, reasons: [] });
  });

  it("allows an official source-linked migration provider install after a cancelled import", async () => {
    const root = await makeTempRoot();
    const result = await inspectSetupMigrationFreshness({
      baseConfig: {
        plugins: {
          entries: {
            codex: { enabled: true },
          },
          installs: {
            codex: {
              source: "npm",
              spec: "@openclaw/codex",
              installPath: "/tmp/openclaw-extensions/codex",
            },
          },
        },
      },
      stateDir: path.join(root, "state"),
      workspaceDir: path.join(root, "workspace"),
    });

    expect(result).toEqual({ fresh: true, reasons: [] });
  });

  it.each([
    {
      name: "custom npm",
      record: {
        source: "npm" as const,
        spec: "@example/codex",
        installPath: "/tmp/openclaw-extensions/codex",
      },
    },
    {
      name: "path",
      record: {
        source: "path" as const,
        sourcePath: "/tmp/custom-codex",
        installPath: "/tmp/custom-codex",
      },
    },
    {
      name: "community ClawHub",
      record: {
        source: "clawhub" as const,
        spec: "clawhub:@openclaw/codex",
        installPath: "/tmp/openclaw-extensions/codex",
        clawhubPackage: "@openclaw/codex",
        clawhubUrl: "https://clawhub.ai",
        clawhubChannel: "community" as const,
      },
    },
  ])("rejects a $name install record for a migration provider", async ({ record }) => {
    const root = await makeTempRoot();

    await expect(
      inspectSetupMigrationFreshness({
        baseConfig: {
          plugins: {
            entries: {
              codex: { enabled: true },
            },
            installs: {
              codex: record,
            },
          },
        },
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    ).resolves.toMatchObject({ fresh: false });
  });

  it("rejects configured migration providers and unrelated plugins", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");

    await expect(
      inspectSetupMigrationFreshness({
        baseConfig: {
          plugins: {
            entries: {
              codex: { enabled: true, config: { option: true } },
            },
          },
        },
        stateDir,
        workspaceDir,
      }),
    ).resolves.toMatchObject({ fresh: false });
    await expect(
      inspectSetupMigrationFreshness({
        baseConfig: {
          plugins: {
            entries: {
              example: { enabled: true },
            },
          },
        },
        stateDir,
        workspaceDir,
      }),
    ).resolves.toMatchObject({ fresh: false });
    await expect(
      inspectSetupMigrationFreshness({
        baseConfig: {
          plugins: {
            installs: {
              example: { source: "npm", spec: "example" },
            },
          },
        },
        stateDir,
        workspaceDir,
      }),
    ).resolves.toMatchObject({ fresh: false });
  });

  it("checks the configured state directory when deciding whether to offer import", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    resolveStateDir.mockReturnValue(stateDir);
    await writeFile(path.join(stateDir, "credentials", "provider.json"), "{}\n");

    await expect(
      isSetupMigrationTargetFresh({
        baseConfig: {},
        workspaceDir,
      }),
    ).resolves.toBe(false);
  });
});

describe("setup migration import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const providers = buildRegisteredMigrationProviders();
    resolvePluginMigrationProviders.mockReturnValue(providers);
    resolvePluginMigrationProvider.mockImplementation(({ providerId }) =>
      providers.find((provider) => provider.id === providerId),
    );
  });

  it("lists installable official migration providers that are not installed yet", async () => {
    resolvePluginMigrationProviders.mockReturnValueOnce([]);

    const options = await listSetupMigrationOptions({
      baseConfig: {},
      detections: [],
    });

    expect(options).toEqual([
      {
        providerId: "codex",
        label: "Codex",
        hint: "OpenClaw Codex harness and model provider plugin",
      },
    ]);
  });

  it("lists detected providers first and keeps other providers available", async () => {
    const options = await listSetupMigrationOptions({
      baseConfig: {},
      detections: [
        {
          providerId: "hermes",
          label: "Hermes",
          source: "/tmp/hermes-home",
        },
      ],
    });

    expect(options).toEqual([
      {
        providerId: "hermes",
        label: "Hermes",
        hint: "/tmp/hermes-home",
      },
      {
        providerId: "codex",
        label: "Codex",
        hint: "Import Codex auth and skills.",
      },
    ]);
  });

  it("asks before including supported credentials and replans before apply", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    resolveStateDir.mockReturnValue(stateDir);
    const makePlan = (includeSecrets: boolean) => ({
      providerId: "codex",
      source: "/tmp/codex-home",
      target: workspaceDir,
      summary: {
        total: 1,
        planned: includeSecrets ? 1 : 0,
        migrated: 0,
        skipped: includeSecrets ? 0 : 1,
        conflicts: 0,
        errors: 0,
        sensitive: 1,
      },
      items: [
        {
          id: "auth:openai",
          kind: "auth",
          action: "copy",
          status: includeSecrets ? "planned" : "skipped",
          sensitive: true,
        },
      ],
    });
    migrationPlan.mockImplementation(async (ctx: { includeSecrets?: boolean }) =>
      makePlan(Boolean(ctx.includeSecrets)),
    );
    migrationApply.mockResolvedValue({
      ...makePlan(true),
      items: [{ ...makePlan(true).items[0], status: "migrated" }],
    });
    const confirm = vi.fn(async () => true);
    const prompter = createWizardPrompter({ confirm });
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await runSetupMigrationImport({
      opts: {
        importFrom: "codex",
        importSource: "/tmp/codex-home",
        workspace: workspaceDir,
      },
      baseConfig: {},
      detections: [],
      prompter,
      runtime,
      commitConfigFile: async (config) => config,
    });

    expect(migrationPlan).toHaveBeenCalledTimes(2);
    expect(migrationPlan.mock.calls.map(([ctx]) => ctx.includeSecrets)).toEqual([false, true]);
    expect(confirm).toHaveBeenNthCalledWith(1, {
      message: "Import supported auth credentials too?",
      initialValue: true,
    });
    expect(confirm).toHaveBeenNthCalledWith(2, {
      message: "Apply this migration now?",
      initialValue: true,
    });
    expect(migrationApply).toHaveBeenCalledWith(
      expect.objectContaining({ includeSecrets: true }),
      expect.objectContaining({ providerId: "codex" }),
    );
    expect(prompter.outro).toHaveBeenCalledWith("Migration complete. Run `openclaw doctor` next.");
  });

  it("confirms and persists a selected official migration provider before planning", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    resolveStateDir.mockReturnValue(stateDir);
    resolvePluginMigrationProviders.mockReturnValue([]);
    resolvePluginMigrationProvider
      .mockReturnValueOnce(undefined)
      .mockImplementation(({ providerId }) =>
        buildRegisteredMigrationProviders().find((provider) => provider.id === providerId),
      );
    const installedConfig = {
      plugins: {
        entries: {
          codex: { enabled: true },
        },
        installs: {
          codex: {
            source: "npm" as const,
            spec: "@openclaw/codex",
            installPath: "/tmp/openclaw-extensions/codex",
          },
        },
      },
    };
    ensureOnboardingPluginInstalled.mockResolvedValue({
      cfg: installedConfig,
      installed: true,
      pluginId: "codex",
      status: "installed",
    });
    const plan = {
      providerId: "codex",
      source: "/tmp/codex-home",
      target: workspaceDir,
      summary: {
        total: 1,
        planned: 1,
        migrated: 0,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
      items: [
        {
          id: "skill:example",
          kind: "skill",
          action: "copy",
          status: "planned",
          sensitive: false,
        },
      ],
    };
    migrationPlan.mockResolvedValue(plan);
    migrationApply.mockResolvedValue({
      ...plan,
      items: [{ ...plan.items[0], status: "migrated" }],
    });
    const prompter = createWizardPrompter({ confirm: vi.fn(async () => true) });
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const commitConfigFile = vi.fn(async (config) => config);

    await runSetupMigrationImport({
      opts: {
        importFrom: "codex",
        importSource: "/tmp/codex-home",
        workspace: workspaceDir,
      },
      baseConfig: {},
      detections: [],
      prompter,
      runtime,
      commitConfigFile,
    });

    expect(ensureOnboardingPluginInstalled).toHaveBeenCalledWith({
      cfg: {},
      entry: {
        pluginId: "codex",
        label: "Codex",
        install: {
          npmSpec: "@openclaw/codex",
          defaultChoice: "npm",
          minHostVersion: ">=2026.5.1-beta.1",
        },
        trustedSourceLinkedOfficialInstall: true,
      },
      prompter,
      runtime,
      workspaceDir,
      promptInstall: true,
    });
    expect(commitConfigFile).toHaveBeenCalledWith(expect.objectContaining(installedConfig));
    expect(commitConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      migrationPlan.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(migrationPlan).toHaveBeenCalledOnce();
  });

  it("rejects a missing non-interactive source before installing a migration provider", async () => {
    const root = await makeTempRoot();
    const workspaceDir = path.join(root, "workspace");
    resolvePluginMigrationProviders.mockReturnValue([]);

    await expect(
      runSetupMigrationImport({
        opts: {
          importFrom: "codex",
          nonInteractive: true,
          workspace: workspaceDir,
        },
        baseConfig: {},
        detections: [],
        prompter: createWizardPrompter(),
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn(),
        },
        commitConfigFile: vi.fn(async (config) => config),
      }),
    ).rejects.toThrow("--import-source is required for non-interactive migration import.");

    expect(ensureOnboardingPluginInstalled).not.toHaveBeenCalled();
    expect(migrationPlan).not.toHaveBeenCalled();
  });

  it("keeps an installed migration provider managed when migration apply is cancelled", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    resolveStateDir.mockReturnValue(stateDir);
    resolvePluginMigrationProviders.mockReturnValue([]);
    resolvePluginMigrationProvider
      .mockReturnValueOnce(undefined)
      .mockImplementation(({ providerId }) =>
        buildRegisteredMigrationProviders().find((provider) => provider.id === providerId),
      );
    const installedConfig = {
      plugins: {
        entries: {
          codex: { enabled: true },
        },
      },
    };
    ensureOnboardingPluginInstalled.mockResolvedValue({
      cfg: installedConfig,
      installed: true,
      pluginId: "codex",
      status: "installed",
    });
    migrationPlan.mockResolvedValue({
      providerId: "codex",
      source: "/tmp/codex-home",
      target: workspaceDir,
      summary: {
        total: 0,
        planned: 0,
        migrated: 0,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
      items: [],
    });
    const prompter = createWizardPrompter({ confirm: vi.fn(async () => false) });
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const commitConfigFile = vi.fn(async (config) => config);

    await expect(
      runSetupMigrationImport({
        opts: {
          importFrom: "codex",
          importSource: "/tmp/codex-home",
          workspace: workspaceDir,
        },
        baseConfig: {},
        detections: [],
        prompter,
        runtime,
        commitConfigFile,
      }),
    ).rejects.toMatchObject({ name: "WizardCancelledError" });

    expect(ensureOnboardingPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({ promptInstall: true }),
    );
    expect(commitConfigFile).toHaveBeenCalledOnce();
    expect(commitConfigFile).toHaveBeenCalledWith(installedConfig);
    expect(migrationApply).not.toHaveBeenCalled();
    await expect(
      inspectSetupMigrationFreshness({
        baseConfig: installedConfig,
        stateDir,
        workspaceDir,
      }),
    ).resolves.toEqual({ fresh: true, reasons: [] });
  });

  it("continues onboarding without showing a terminal migration outro", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    resolveStateDir.mockReturnValue(stateDir);
    const plan = {
      providerId: "codex",
      source: "/tmp/codex-home",
      target: workspaceDir,
      summary: {
        total: 1,
        planned: 1,
        migrated: 0,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
      items: [
        {
          id: "skill:example",
          kind: "skill",
          action: "copy",
          status: "planned",
          sensitive: false,
        },
      ],
    };
    migrationPlan.mockResolvedValue(plan);
    migrationApply.mockResolvedValue({
      ...plan,
      items: [{ ...plan.items[0], status: "migrated" }],
    });
    const prompter = createWizardPrompter({ confirm: vi.fn(async () => true) });
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await runSetupMigrationImport({
      opts: {
        importFrom: "codex",
        importSource: "/tmp/codex-home",
        workspace: workspaceDir,
      },
      baseConfig: {},
      detections: [],
      prompter,
      runtime,
      commitConfigFile: async (config) => config,
      continueOnboarding: true,
    });

    expect(prompter.outro).not.toHaveBeenCalled();
    expect(prompter.note).toHaveBeenCalledWith(
      "Migration complete. Continuing setup.",
      "Migration applied",
    );
  });
});
