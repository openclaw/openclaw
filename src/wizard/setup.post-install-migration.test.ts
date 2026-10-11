import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MigrationProviderPlugin } from "../plugins/types.js";
import { createNonExitingRuntime } from "../runtime.js";
import { offerPostInstallMigrations } from "./setup.post-install-migration.js";

const migrationProviders = vi.hoisted(() => vi.fn<() => MigrationProviderPlugin[]>(() => []));
vi.mock("../plugins/migration-provider-runtime.js", () => ({
  withPluginMigrationProviders: async (
    _params: unknown,
    run: (providers: MigrationProviderPlugin[]) => Promise<unknown>,
  ) => await run(migrationProviders()),
}));
const resolveManifestContractRuntimePluginResolution = vi.hoisted(() =>
  vi.fn((_params: { contract: string; value?: string }) => ({
    pluginIds: [] as string[],
    bundledCompatPluginIds: [] as string[],
  })),
);
vi.mock("../plugins/manifest-contract-runtime.js", () => ({
  resolveManifestContractRuntimePluginResolution,
}));
vi.mock("../commands/migrate/context.js", () => ({
  createMigrationLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../config/paths.js", () => ({ resolveStateDir: () => "/tmp/state" }));
const migrateDefaultCommand = vi.hoisted(() =>
  vi.fn<typeof import("../commands/migrate.js").migrateDefaultCommand>(),
);
vi.mock("../commands/migrate.js", () => ({ migrateDefaultCommand }));

const originalStdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
function setTTY(isTTY: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
}
function buildProvider(overrides: Partial<MigrationProviderPlugin> = {}): MigrationProviderPlugin {
  return {
    id: "codex",
    label: "Codex",
    plan: vi.fn<MigrationProviderPlugin["plan"]>(),
    apply: vi.fn<MigrationProviderPlugin["apply"]>(),
    detect: vi.fn(async () => ({ found: true, source: "/home/user/.codex" })),
    ...overrides,
  };
}
function runOffer(overrides: Partial<Parameters<typeof offerPostInstallMigrations>[0]> = {}) {
  return offerPostInstallMigrations({
    config: {},
    runtime: createNonExitingRuntime(),
    prompter: createWizardPrompter(),
    installedPluginIds: ["codex"],
    ...overrides,
  });
}

let provider: MigrationProviderPlugin;
describe("offerPostInstallMigrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    provider = buildProvider();
    migrationProviders.mockReset().mockReturnValue([provider]);
    resolveManifestContractRuntimePluginResolution.mockReset().mockReturnValue({
      pluginIds: ["codex"],
      bundledCompatPluginIds: [],
    });
    migrateDefaultCommand.mockReset();
    setTTY(true);
  });
  afterEach(() => {
    if (originalStdinIsTTYDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", originalStdinIsTTYDescriptor);
    } else {
      delete (process.stdin as Partial<typeof process.stdin>).isTTY;
    }
  });

  it("returns unchanged without loading providers when no plugins were installed", async () => {
    const config: OpenClawConfig = { plugins: { entries: { codex: { enabled: true } } } };
    const result = await runOffer({ config, installedPluginIds: [] });
    expect(migrationProviders).not.toHaveBeenCalled();
    expect(migrateDefaultCommand).not.toHaveBeenCalled();
    expect(result.config).toBe(config);
  });

  it("excludes unowned, absent, low-confidence, and failed detections from migration offers", async () => {
    const unowned = buildProvider({ id: "unowned" });
    const absent = buildProvider({ id: "absent", detect: vi.fn(async () => ({ found: false })) });
    const low = buildProvider({
      id: "low",
      detect: vi.fn(async () => ({ found: true, confidence: "low" as const })),
    });
    const failed = buildProvider({
      id: "failed",
      detect: vi.fn(async () => {
        throw new Error("detect failure");
      }),
    });
    migrationProviders.mockReturnValue([unowned, absent, low, failed]);
    resolveManifestContractRuntimePluginResolution.mockImplementation(({ value }) => ({
      pluginIds: value === "unowned" ? ["other"] : ["codex"],
      bundledCompatPluginIds: [],
    }));
    const prompter = createWizardPrompter();
    await runOffer({ prompter });
    expect(unowned.detect).not.toHaveBeenCalled();
    expect(absent.detect).toHaveBeenCalledOnce();
    expect(low.detect).toHaveBeenCalledOnce();
    expect(failed.detect).toHaveBeenCalledOnce();
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(migrateDefaultCommand).not.toHaveBeenCalled();
  });

  it("invokes the selected provider when the user accepts", async () => {
    const prompter = createWizardPrompter({ confirm: vi.fn(async () => true) });
    const result = await runOffer({ prompter });
    expect(prompter.confirm).toHaveBeenCalledExactlyOnceWith({
      message: "Review migration from Codex at /home/user/.codex?",
      initialValue: false,
    });
    expect(migrateDefaultCommand).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        provider: "codex",
        configPatchMode: "return",
        suppressPlanLog: true,
      }),
      provider,
    );
    expect(result.config).toEqual({});
  });

  it("shows provider-owned import scope before asking and respects a decline", async () => {
    const description = "Import Example skills. Example conversations are not imported.";
    migrationProviders.mockReturnValue([buildProvider({ label: "Example", description })]);
    const prompter = createWizardPrompter();
    await runOffer({ prompter });
    expect(prompter.note).toHaveBeenCalledWith(
      `${description}\n\nYou will review import options and confirm before applying.`,
      "Example migration",
    );
    expect(prompter.note).toHaveBeenCalledBefore(vi.mocked(prompter.confirm));
    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "Review migration from Example at /home/user/.codex?",
      initialValue: false,
    });
    expect(migrateDefaultCommand).not.toHaveBeenCalled();
  });

  it("returns migrated config patches without mutating the input or replacing sibling settings", async () => {
    const inputConfig: OpenClawConfig = {
      plugins: {
        entries: {
          codex: { enabled: true, config: { appServer: { sandbox: "workspace-write" } } },
        },
      },
    };
    migrateDefaultCommand.mockResolvedValueOnce({
      providerId: "codex",
      source: "/home/user/.codex",
      summary: {
        total: 1,
        planned: 0,
        migrated: 1,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
      items: [
        {
          id: "config:codex-plugins",
          kind: "config",
          action: "merge",
          status: "migrated",
          details: {
            path: ["plugins", "entries", "codex"],
            value: { enabled: true, config: { codexPlugins: { enabled: true } } },
          },
        },
      ],
    });
    const result = await runOffer({
      config: inputConfig,
      prompter: createWizardPrompter({ confirm: vi.fn(async () => true) }),
    });
    expect(migrateDefaultCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ configOverride: inputConfig, configPatchMode: "return" }),
      provider,
    );
    expect(result.config).not.toBe(inputConfig);
    expect(result.config.plugins?.entries?.codex?.config).toEqual({
      appServer: { sandbox: "workspace-write" },
      codexPlugins: { enabled: true },
    });
    expect(inputConfig.plugins?.entries?.codex?.config).toEqual({
      appServer: { sandbox: "workspace-write" },
    });
  });

  it.each(["stdin"])(
    "never prompts or applies when %s selects non-interactive mode",
    async (mode) => {
      setTTY(mode !== "stdin");
      const prompter = createWizardPrompter();
      await runOffer({ prompter, ...(mode === "flag" ? { nonInteractive: true } : {}) });
      expect(prompter.note).not.toHaveBeenCalled();
      expect(prompter.confirm).not.toHaveBeenCalled();
      expect(migrateDefaultCommand).not.toHaveBeenCalled();
    },
  );

  it("swallows migration command failures so onboarding can continue", async () => {
    migrateDefaultCommand.mockRejectedValueOnce(new Error("boom"));
    await expect(
      runOffer({ prompter: createWizardPrompter({ confirm: vi.fn(async () => true) }) }),
    ).resolves.toEqual({ config: {} });
    expect(migrateDefaultCommand).toHaveBeenCalledOnce();
  });
});
