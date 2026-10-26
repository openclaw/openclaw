import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createCliTtyMock } from "../cli/test-runtime-capture.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { summarizeMigrationItems } from "../plugin-sdk/migration.js";
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
const resolveOwnership = vi.hoisted(() =>
  vi.fn((_params: { value?: string }) => ({ pluginIds: ["codex"], bundledCompatPluginIds: [] })),
);
// mock-isolation: Only fixture migration owners participate; do not discover installed plugins.
vi.mock("../plugins/manifest-contract-runtime.js", () => ({
  resolveManifestContractRuntimePluginResolution: resolveOwnership,
}));
vi.mock("../commands/migrate/context.js", () => ({
  createMigrationLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../config/paths.js", () => ({ resolveStateDir: () => "/tmp/state" }));
const migrateDefaultCommand = vi.hoisted(() =>
  vi.fn<typeof import("../commands/migrate.js").migrateDefaultCommand>(),
);
vi.mock("../commands/migrate.js", () => ({ migrateDefaultCommand }));

const ttyMock = createCliTtyMock([process.stdin]);
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
    prompter,
    installedPluginIds: ["codex"],
    ...overrides,
  });
}

let provider: MigrationProviderPlugin;
let prompter: ReturnType<typeof createWizardPrompter>;
beforeEach(() => {
  provider = buildProvider();
  prompter = createWizardPrompter();
  migrationProviders.mockReset().mockReturnValue([provider]);
  resolveOwnership.mockReset().mockReturnValue({
    pluginIds: ["codex"],
    bundledCompatPluginIds: [],
  });
  migrateDefaultCommand.mockReset();
  ttyMock.set(true);
});
afterEach(ttyMock.restore);

it.each(["unowned", "absent", "low", "failed"])(
  "excludes %s providers from migration offers",
  async (mode) => {
    const detect = vi.fn<NonNullable<MigrationProviderPlugin["detect"]>>(async () => {
      if (mode === "failed") {
        throw new Error("detect failure");
      }
      return { found: mode !== "absent", confidence: mode === "low" ? "low" : "high" };
    });
    migrationProviders.mockReturnValue([buildProvider({ detect })]);
    resolveOwnership.mockReturnValue({
      pluginIds: mode === "unowned" ? ["other"] : ["codex"],
      bundledCompatPluginIds: [],
    });
    await runOffer();
    expect(detect).toHaveBeenCalledTimes(mode === "unowned" ? 0 : 1);
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(migrateDefaultCommand).not.toHaveBeenCalled();
  },
);

it("shows provider-owned import scope before asking and respects a decline", async () => {
  const description = "Import Example skills. Example conversations are not imported.";
  migrationProviders.mockReturnValue([buildProvider({ label: "Example", description })]);
  await runOffer();
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

it.each(["empty", "failure", "patch"])("preserves input for %s migration results", async (mode) => {
  const inputConfig: OpenClawConfig = { env: { vars: { KEEP: "original" } } };
  const items = [
    {
      id: "config:env",
      kind: "config",
      action: "merge",
      status: "migrated",
      details: { path: ["env"], value: { vars: { IMPORTED: "yes" } } },
    },
  ] satisfies import("../plugins/types.js").MigrationPlan["items"];
  if (mode === "failure") {
    migrateDefaultCommand.mockRejectedValueOnce(new Error("boom"));
  }
  if (mode === "patch") {
    migrateDefaultCommand.mockResolvedValueOnce({
      providerId: "codex",
      source: "/home/user/.codex",
      summary: summarizeMigrationItems(items),
      items,
    });
  }
  vi.mocked(prompter.confirm).mockResolvedValue(true);
  const result = await runOffer({ config: inputConfig });
  expect(migrateDefaultCommand.mock.calls[0]?.[1]).toMatchObject({
    provider: "codex",
    configOverride: inputConfig,
    configPatchMode: "return",
  });
  expect(migrateDefaultCommand.mock.calls[0]?.[2]).toBe(provider);
  expect(result.config === inputConfig).toBe(mode !== "patch");
  expect(result.config).toEqual({
    env: {
      vars: mode === "patch" ? { KEEP: "original", IMPORTED: "yes" } : { KEEP: "original" },
    },
  });
  expect(inputConfig).toEqual({ env: { vars: { KEEP: "original" } } });
});

it.each(["no plugins", "flag", "stdin"])("skips migration when %s", async (mode) => {
  const config: OpenClawConfig = { env: { vars: { KEEP: "original" } } };
  ttyMock.set(mode !== "stdin");
  const result = await runOffer({
    config,
    nonInteractive: mode === "flag",
    installedPluginIds: mode === "no plugins" ? [] : ["codex"],
  });
  if (mode === "no plugins") {
    expect(migrationProviders).not.toHaveBeenCalled();
  }
  expect(result.config).toBe(config);
  expect(prompter.note).not.toHaveBeenCalled();
  expect(prompter.confirm).not.toHaveBeenCalled();
  expect(migrateDefaultCommand).not.toHaveBeenCalled();
});
