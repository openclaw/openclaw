import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getPluginCliCommandDescriptors } from "./cli-root-descriptors.js";

const mocks = vi.hoisted(() => ({ load: vi.fn(), snapshot: vi.fn() }));
// mock-isolation: CLI discovery uses fixture registries without loading plugin runtimes.
vi.mock("./loader.js", () => ({ loadOpenClawPluginCliRegistry: mocks.load }));
// mock-isolation: Metadata selection uses the fixture snapshot, never host config or plugin state.
vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginMetadataSnapshot: mocks.snapshot,
}));
// mock-isolation: Explicit fixture enablement keeps auto-detection outside descriptor discovery proof.
vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config }: { config: OpenClawConfig }) => ({
    config,
    changes: [],
    autoEnabledReasons: {},
  }),
}));
vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
  isPluginMetadataSnapshotCompatible: () => true,
  rebasePluginMetadataSnapshotManifestRegistry: <T>(value: T) => value,
  resolvePluginMetadataSnapshot: mocks.snapshot,
}));

const descriptor = (name: string, description: string) => ({
  name,
  description,
  hasSubcommands: true,
});
const matrixPlugin = {
  id: "matrix",
  origin: "bundled",
  format: "openclaw",
  cliCommands: [descriptor("matrix", "Matrix channel utilities")],
};
const legacyPlugin = { id: "legacy-cli", origin: "config", format: "openclaw" };
function snapshot(
  ...plugins: Array<{
    id: string;
    origin: string;
    format: string;
    cliCommands?: ReturnType<typeof descriptor>[];
  }>
) {
  return {
    policyHash: "test",
    index: {
      installRecords: {},
      plugins: plugins.map(({ id, origin }) => ({
        pluginId: id,
        enabled: true,
        origin,
        ...(origin === "bundled" ? { enabledByDefault: true } : {}),
      })),
    },
    manifestRegistry: { plugins, diagnostics: [] },
    plugins,
    diagnostics: [],
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    owners: {},
  };
}
beforeEach(() => {
  mocks.load.mockReset();
  mocks.snapshot.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it("loads manifest root help without plugin code and respects enabled policy", async () => {
  const sibling = {
    id: "external-cli",
    origin: "global",
    format: "openclaw",
    cliCommands: [{ ...descriptor("external-cli", "External utilities"), hasSubcommands: false }],
  };
  const metadata = snapshot(matrixPlugin, sibling);
  metadata.index.plugins.splice(1, 0, {
    pluginId: "matrix",
    enabled: true,
    enabledByDefault: false,
    origin: "bundled",
  });
  mocks.snapshot.mockReturnValue(metadata);
  const config: OpenClawConfig = {
    plugins: { entries: { matrix: { enabled: true }, "external-cli": { enabled: false } } },
  };
  await expect(getPluginCliCommandDescriptors(config)).resolves.toEqual(matrixPlugin.cliCommands);
  config.plugins!.entries!.matrix = { enabled: false };
  config.plugins!.entries!["external-cli"] = { enabled: true };
  await expect(getPluginCliCommandDescriptors(config)).resolves.toEqual(sibling.cliCommands);
  expect(mocks.load).not.toHaveBeenCalled();
});

it("preserves deduplicated manifest root help when an unrelated legacy plugin fails", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  mocks.snapshot.mockReturnValue(
    snapshot(
      {
        ...matrixPlugin,
        cliCommands: [...matrixPlugin.cliCommands, ...matrixPlugin.cliCommands],
      },
      legacyPlugin,
    ),
  );
  mocks.load.mockRejectedValue(new Error("broken legacy CLI plugin"));
  const config: OpenClawConfig = { plugins: { entries: { "legacy-cli": { enabled: true } } } };
  await expect(getPluginCliCommandDescriptors(config)).resolves.toEqual(matrixPlugin.cliCommands);
  expect(stderr).not.toHaveBeenCalled();
  expect(mocks.load).toHaveBeenCalledWith(
    expect.objectContaining({ onlyPluginIds: ["legacy-cli"] }),
  );
});

it("preserves root help for external plugins without manifest descriptors", async () => {
  mocks.snapshot.mockReturnValue(snapshot(legacyPlugin));
  const descriptors = [descriptor("legacy", "Legacy external command")];
  mocks.load.mockResolvedValue({
    cliRegistrars: [
      {
        pluginId: "legacy-cli",
        register: vi.fn(),
        parentPath: [],
        commands: ["legacy"],
        descriptors,
        source: "/tmp/legacy-cli/index.js",
      },
    ],
  });
  const config: OpenClawConfig = { plugins: { entries: { "legacy-cli": { enabled: true } } } };
  await expect(getPluginCliCommandDescriptors(config)).resolves.toEqual(descriptors);
  expect(mocks.load).toHaveBeenCalledWith(
    expect.objectContaining({ onlyPluginIds: ["legacy-cli"] }),
  );
});
