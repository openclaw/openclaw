import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  memoryRegister: vi.fn(),
  otherRegister: vi.fn(),
  memoryListAction: vi.fn(),
  loadOpenClawPluginCliRegistry: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
  resolveManifestActivationPluginIds: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
  loadConfig: vi.fn(),
  getRuntimeConfigSnapshot: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
}));

// mock-isolation: Synthetic registries avoid loading installed plugin code.
vi.mock("./loader.js", () => ({
  loadOpenClawPluginCliRegistry: mocks.loadOpenClawPluginCliRegistry,
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
  loadPluginRegistryHandle: (options: Record<string, unknown> = {}) =>
    mocks.loadOpenClawPlugins({ ...options, activate: false }),
}));

// mock-isolation: Fixture activation plans isolate CLI registration from plugin discovery.
vi.mock("./activation-planner.js", () => ({
  resolveManifestActivationPluginIds: mocks.resolveManifestActivationPluginIds,
}));

// mock-isolation: Fixture auto-enable results avoid changing operator configuration.
vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

// mock-isolation: Fixture metadata avoids reading operator configuration.
vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
  isPluginMetadataSnapshotCompatible: () => true,
  rebasePluginMetadataSnapshotManifestRegistry: <T>(snapshot: T) => snapshot,
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

// mock-isolation: Fixture config readers avoid accessing operator configuration.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.loadConfig,
  getRuntimeConfigSnapshot: mocks.getRuntimeConfigSnapshot,
  loadConfig: mocks.loadConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../config/runtime-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/runtime-snapshot.js")>()),
  loadPinnedRuntimeConfigAsync: async (
    loadFresh: (assertCurrent: () => void) => Promise<{ config: OpenClawConfig }>,
  ) => mocks.getRuntimeConfigSnapshot() ?? (await loadFresh(() => {})).config,
}));

let getPluginCliCommandDescriptors: typeof import("./cli-root-descriptors.js").getPluginCliCommandDescriptors;
let registerPluginCliCommandsFromValidatedConfig: typeof import("./cli.js").registerPluginCliCommandsFromValidatedConfig;

const createProgram = () => new Command();
const registerCli = (
  program: Command,
  options?: Parameters<typeof registerPluginCliCommandsFromValidatedConfig>[3],
) => registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, options);
const descriptor = (name: string, description: string) => ({
  name,
  description,
  hasSubcommands: true,
});

function createCliRegistry(params?: {
  memoryCommands?: string[];
  memoryDescriptors?: ReturnType<typeof descriptor>[];
}) {
  return {
    cliRegistrars: [
      {
        pluginId: "memory-core",
        register: mocks.memoryRegister,
        parentPath: [],
        commands: params?.memoryCommands ?? ["memory"],
        descriptors: params?.memoryDescriptors ?? [descriptor("memory", "Memory commands")],
        source: "bundled",
      },
      {
        pluginId: "other",
        register: mocks.otherRegister,
        parentPath: [],
        commands: ["other"],
        descriptors: [],
        source: "bundled",
      },
    ],
  };
}

function createAutoEnabledCliFixture() {
  const rawConfig = {
    plugins: {},
    channels: { demo: { enabled: true } },
  } as OpenClawConfig;
  const autoEnabledConfig = {
    ...rawConfig,
    plugins: { entries: { demo: { enabled: true } } },
  } as OpenClawConfig;
  mocks.applyPluginAutoEnable.mockReturnValue({
    config: autoEnabledConfig,
    changes: [],
    autoEnabledReasons: { demo: ["demo configured"] },
  });
  return { rawConfig, autoEnabledConfig };
}

const matrixPlugin = {
  id: "matrix",
  origin: "bundled",
  format: "openclaw",
  cliCommands: [descriptor("matrix", "Matrix channel utilities")],
};
const legacyPlugin = { id: "legacy-cli", origin: "config", format: "openclaw" };

function createCliMetadataSnapshot(
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

async function rootHelp(config: OpenClawConfig) {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  onTestFinished(() => write.mockRestore());
  const { outputRootHelp } = await import("../cli/program/root-help.js");
  await outputRootHelp({ config });
  return write.mock.calls.map(([chunk]) => String(chunk)).join("");
}

function getMockCallObject(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const value = mock.mock.calls[callIndex]?.[argIndex];
  if (!value || typeof value !== "object") {
    throw new Error(`expected mock call ${callIndex} arg ${argIndex} object`);
  }
  return value as Record<string, unknown>;
}

describe("registerPluginCliCommandsFromValidatedConfig", () => {
  beforeAll(async () => {
    ({ getPluginCliCommandDescriptors } = await import("./cli-root-descriptors.js"));
    ({ registerPluginCliCommandsFromValidatedConfig } = await import("./cli.js"));
  });

  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.memoryRegister.mockImplementation(({ program }: { program: Command }) => {
      const memory = program.command("memory").description("Memory commands");
      memory.command("list").action(mocks.memoryListAction);
    });
    mocks.otherRegister.mockImplementation(({ program }: { program: Command }) => {
      program.command("other").description("Other commands");
    });
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue(createCliRegistry());
    mocks.loadOpenClawPlugins.mockReturnValue({ ...createCliRegistry(), diagnostics: [] });
    mocks.resolveManifestActivationPluginIds.mockReturnValue([]);
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(undefined);
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({
      config,
      changes: [],
      autoEnabledReasons: {},
    }));
    mocks.loadConfig.mockReturnValue({} as OpenClawConfig);
    mocks.getRuntimeConfigSnapshot.mockReturnValue(null);
    mocks.readConfigFileSnapshot.mockResolvedValue({ valid: true, config: {}, runtimeConfig: {} });
  });

  it("skips plugin CLI registrars when an existing command alias matches", async () => {
    const program = createProgram();
    // Alias-only root names (e.g. cron|automations) are owned commands too.
    program.command("mem-core").alias("memory");
    await registerPluginCliCommandsFromValidatedConfig(program);
    expect(mocks.memoryRegister).not.toHaveBeenCalled();
    expect(mocks.otherRegister).toHaveBeenCalledTimes(1);
  });

  it("loads root-help descriptors from manifests without entering the plugin module loader", async () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    const siblingConfig = { enabled: false };
    autoEnabledConfig.plugins!.entries!["external-cli"] = siblingConfig;
    const sibling = {
      id: "external-cli",
      origin: "global",
      format: "openclaw",
      cliCommands: [
        { name: "external-cli", description: "External utilities", hasSubcommands: false },
      ],
    };
    const snapshot = createCliMetadataSnapshot(matrixPlugin, sibling);
    snapshot.index.plugins.splice(1, 0, {
      pluginId: "matrix",
      enabled: true,
      enabledByDefault: false,
      origin: "bundled",
    });
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(snapshot);
    await expect(getPluginCliCommandDescriptors(rawConfig)).resolves.toEqual([
      descriptor("matrix", "Matrix channel utilities"),
    ]);
    const help = await rootHelp(rawConfig);
    expect(help).toContain("matrix *");
    expect(help).toContain("Matrix channel utilities");
    expect(help).not.toContain("External utilities");

    autoEnabledConfig.plugins!.entries!.matrix = { enabled: false };
    siblingConfig.enabled = true;
    await expect(getPluginCliCommandDescriptors(rawConfig)).resolves.toEqual(sibling.cliCommands);
    expect(mocks.loadOpenClawPluginCliRegistry).not.toHaveBeenCalled();
    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith(
      expect.objectContaining({ config: rawConfig }),
    );
    expect(autoEnabledConfig.plugins?.entries?.demo?.enabled).toBe(true);
  });

  it("preserves manifest-backed root help when an unrelated legacy CLI plugin fails", async () => {
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as unknown as typeof process.stderr.write);
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(
      createCliMetadataSnapshot(
        {
          ...matrixPlugin,
          cliCommands: [...matrixPlugin.cliCommands, ...matrixPlugin.cliCommands],
        },
        legacyPlugin,
      ),
    );
    mocks.loadOpenClawPluginCliRegistry.mockRejectedValue(new Error("broken legacy CLI plugin"));
    const config: OpenClawConfig = { plugins: { entries: { "legacy-cli": { enabled: true } } } };
    await expect(getPluginCliCommandDescriptors(config)).resolves.toEqual([
      descriptor("matrix", "Matrix channel utilities"),
    ]);
    expect(await rootHelp(config)).toContain("matrix *");
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(getMockCallObject(mocks.loadOpenClawPluginCliRegistry).onlyPluginIds).toEqual([
      "legacy-cli",
    ]);
  });

  it("preserves root help for external plugins without manifest CLI descriptors", async () => {
    const config: OpenClawConfig = { plugins: { entries: { "legacy-cli": { enabled: true } } } };
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(createCliMetadataSnapshot(legacyPlugin));
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue({
      cliRegistrars: [
        {
          pluginId: "legacy-cli",
          register: vi.fn(),
          parentPath: [],
          commands: ["legacy"],
          descriptors: [descriptor("legacy", "Legacy external command")],
          source: "/tmp/legacy-cli/index.js",
        },
      ],
    });
    await expect(getPluginCliCommandDescriptors(config)).resolves.toEqual([
      descriptor("legacy", "Legacy external command"),
    ]);
    expect(getMockCallObject(mocks.loadOpenClawPluginCliRegistry).onlyPluginIds).toEqual([
      "legacy-cli",
    ]);
  });

  it("keeps runtime CLI command registration on the full plugin loader for legacy channel plugins", async () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    mocks.loadOpenClawPlugins.mockReturnValue(
      createCliRegistry({
        memoryCommands: ["legacy-channel"],
        memoryDescriptors: [descriptor("legacy-channel", "Legacy channel commands")],
      }),
    );

    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: rawConfig,
      runtimeConfig: rawConfig,
    });
    await registerCli(createProgram(), { mode: "lazy" });
    const loadOptions = getMockCallObject(mocks.loadOpenClawPlugins);
    expect(loadOptions.config).toBe(autoEnabledConfig);
    expect(loadOptions.activationSourceConfig).toBe(rawConfig);
    expect(loadOptions.autoEnabledReasons).toEqual({ demo: ["demo configured"] });
    expect(loadOptions).toMatchObject({ cache: false, channelPluginLoadIntent: "full" });
    expect(mocks.loadOpenClawPluginCliRegistry).not.toHaveBeenCalled();
  });

  it("lazy-registers descriptor-backed plugin commands on first invocation", async () => {
    const program = createProgram();
    program.exitOverride();
    await registerCli(program, { mode: "lazy" });
    expect(program.commands.map((command) => command.name())).toEqual(["memory", "other"]);
    expect(mocks.memoryRegister).not.toHaveBeenCalled();
    expect(mocks.otherRegister).toHaveBeenCalledTimes(1);
    await program.parseAsync(["memory", "list"], { from: "user" });
    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
    expect(mocks.memoryListAction).toHaveBeenCalledTimes(1);
  });

  it("falls back to eager registration when descriptors do not cover every command root", async () => {
    mocks.loadOpenClawPlugins.mockReturnValue(
      createCliRegistry({
        memoryCommands: ["memory", "memory-admin"],
        memoryDescriptors: [descriptor("memory", "Memory commands")],
      }),
    );
    mocks.memoryRegister.mockImplementation(({ program }: { program: Command }) => {
      program.command("memory");
      program.command("memory-admin");
    });
    await registerCli(createProgram(), { mode: "lazy" });
    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
  });

  it("skips full plugin runtime loading when no metadata owns the requested primary", async () => {
    const program = createProgram();
    program.exitOverride();
    await registerCli(program, {
      mode: "lazy",
      primary: "missing-command",
    });
    expect(mocks.loadOpenClawPluginCliRegistry).toHaveBeenCalled();
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
    expect(program.commands.map((command) => command.name())).not.toContain("missing-command");
  });

  it("preserves an already-active runtime config snapshot", async () => {
    const snapshotConfig = { plugins: { enabled: true } } as OpenClawConfig;
    const activeConfig = { plugins: { enabled: false } } as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: true,
      config: {},
      runtimeConfig: snapshotConfig,
    });
    mocks.getRuntimeConfigSnapshot.mockReturnValueOnce(activeConfig);
    await expect(registerPluginCliCommandsFromValidatedConfig(createProgram())).resolves.toBe(
      activeConfig,
    );
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });

  it("reports invalid configuration without loading plugins", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: false,
      path: "/tmp/openclaw.json",
      config: { plugins: { load: { paths: ["/tmp/unvalidated-plugin"] } } },
      issues: [{ path: "gateway.port", message: "Expected a number" }],
    });
    await expect(
      registerPluginCliCommandsFromValidatedConfig(createProgram()),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: "Invalid config at /tmp/openclaw.json:\n- gateway.port: Expected a number",
    });
    expect(mocks.getRuntimeConfigSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });
});
