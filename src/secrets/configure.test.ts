import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupTempDirs } from "../../test/helpers/temp-dir.js";
import { createPluginSecretProviderFixture } from "./plugin-secret-provider.test-support.js";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  io: vi.fn(),
  auth: vi.fn(),
  plugins: vi.fn(),
  apply: vi.fn(),
}));
const tempDirs: string[] = [];
afterEach(() => cleanupTempDirs(tempDirs));

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: mocks.select,
  text: vi.fn(),
  log: { warn: vi.fn() },
}));

// mock-isolation: Interactive configuration reads a synthetic snapshot, never the operator's config.
vi.mock("./config-io.js", () => ({ createSecretsConfigIO: mocks.io }));
// mock-isolation: Providers-only cases must not read real persisted auth profiles.
vi.mock("../agents/auth-profiles/persisted.js", () => ({
  loadPersistedAuthProfileStore: mocks.auth,
}));

// mock-isolation: Preset discovery uses only the fixture manifest registry.
vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: mocks.plugins,
}));

// mock-isolation: Plan construction records apply options without writing config or executing providers.
vi.mock("./apply.js", () => ({ runSecretsApply: mocks.apply }));

const { runSecretsConfigureInteractive } = await import("./configure.js");

beforeEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.io.mockReturnValue({
    readConfigFileSnapshotForWrite: async () => ({
      snapshot: { valid: true, config: {}, resolved: {} },
    }),
  });
  mocks.plugins.mockReturnValue({ diagnostics: [], plugins: [] });
  mocks.apply.mockResolvedValue({});
});

it("does not load auth-profiles when running providers-only", async () => {
  mocks.select.mockResolvedValue("continue");
  await expect(runSecretsConfigureInteractive({ providersOnly: true })).rejects.toThrow(
    "No secrets changes were selected.",
  );
});

it("adds a plugin preset provider through providers-only configure", async () => {
  const { rootDir, manifestRegistry } = createPluginSecretProviderFixture();
  tempDirs.push(rootDir);
  mocks.select.mockResolvedValueOnce("preset");
  mocks.select.mockImplementationOnce(({ options }) => options[0].value);
  mocks.select.mockResolvedValueOnce("continue");
  mocks.plugins.mockReturnValue(manifestRegistry);

  const vault = {
    source: "exec",
    pluginIntegration: { pluginId: "vault-secrets", integrationId: "vault" },
  };
  const result = await runSecretsConfigureInteractive({ providersOnly: true });
  expect([result.plan.targets, result.plan.providerUpserts?.vault]).toEqual([[], vault]);
  expect(mocks.apply).toHaveBeenCalledWith(
    expect.objectContaining({ write: false, allowExec: false }),
  );
  expect(mocks.auth).not.toHaveBeenCalled();
});
