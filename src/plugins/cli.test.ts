/** CLI integration coverage for plugin commands, setup, status, and registry flows. */
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

vi.mock("./loader.js", () => ({
  loadOpenClawPluginCliRegistry: (...args: unknown[]) =>
    mocks.loadOpenClawPluginCliRegistry(...args),
  loadOpenClawPlugins: (...args: unknown[]) => mocks.loadOpenClawPlugins(...args),
  loadPluginRegistryHandle: (options: Record<string, unknown> = {}) =>
    mocks.loadOpenClawPlugins({ ...options, activate: false }),
}));

vi.mock("./activation-planner.js", () => ({
  resolveManifestActivationPluginIds: (...args: unknown[]) =>
    mocks.resolveManifestActivationPluginIds(...args),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => mocks.applyPluginAutoEnable(...args),
}));

vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginMetadataSnapshot: (...args: unknown[]) =>
    mocks.resolvePluginMetadataSnapshot(...args),
}));

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
  isPluginMetadataSnapshotCompatible: () => true,
  rebasePluginMetadataSnapshotManifestRegistry: <T>(snapshot: T) => snapshot,
  resolvePluginMetadataSnapshot: (...args: unknown[]) =>
    mocks.resolvePluginMetadataSnapshot(...args),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: (...args: unknown[]) => mocks.loadConfig(...args),
  getRuntimeConfigSnapshot: (...args: unknown[]) => mocks.getRuntimeConfigSnapshot(...args),
  loadConfig: (...args: unknown[]) => mocks.loadConfig(...args),
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
}));

let getPluginCliCommandDescriptors: typeof import("./cli-root-descriptors.js").getPluginCliCommandDescriptors;
let registerPluginCliCommandsFromValidatedConfig: typeof import("./cli.js").registerPluginCliCommandsFromValidatedConfig;

function createProgram(existingCommandName?: string) {
  const program = new Command();
  if (existingCommandName) {
    program.command(existingCommandName);
  }
  return program;
}

function createCliRegistry(params?: {
  memoryCommands?: string[];
  memoryDescriptors?: Array<{
    name: string;
    description: string;
    hasSubcommands: boolean;
  }>;
}) {
  return {
    cliRegistrars: [
      {
        pluginId: "memory-core",
        register: mocks.memoryRegister,
        parentPath: [],
        commands: params?.memoryCommands ?? ["memory"],
        descriptors: params?.memoryDescriptors ?? [
          {
            name: "memory",
            description: "Memory commands",
            hasSubcommands: true,
          },
        ],
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
    plugins: {
      entries: {
        demo: { enabled: true },
      },
    },
  } as OpenClawConfig;
  return { rawConfig, autoEnabledConfig };
}

function createCliMetadataSnapshot() {
  const plugin = {
    id: "matrix",
    origin: "bundled",
    format: "openclaw",
    cliCommands: [
      {
        name: "matrix",
        description: "Matrix channel utilities",
        hasSubcommands: true,
      },
    ],
  };
  return {
    policyHash: "test",
    index: {
      installRecords: {},
      plugins: [{ pluginId: "matrix", enabled: true, enabledByDefault: true, origin: "bundled" }],
    },
    manifestRegistry: { plugins: [plugin], diagnostics: [] },
    plugins: [plugin],
    diagnostics: [],
    byPluginId: new Map([[plugin.id, plugin]]),
    owners: {},
  };
}

function createLegacyExternalCliMetadataSnapshot() {
  const plugin = {
    id: "legacy-cli",
    origin: "config",
    format: "openclaw",
  };
  return {
    policyHash: "test",
    index: {
      installRecords: {},
      plugins: [{ pluginId: plugin.id, enabled: true, origin: plugin.origin }],
    },
    manifestRegistry: { plugins: [plugin], diagnostics: [] },
    plugins: [plugin],
    diagnostics: [],
    byPluginId: new Map([[plugin.id, plugin]]),
    owners: {},
  };
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
    mocks.memoryRegister.mockReset();
    mocks.memoryRegister.mockImplementation(({ program }: { program: Command }) => {
      const memory = program.command("memory").description("Memory commands");
      memory.command("list").action(mocks.memoryListAction);
    });
    mocks.otherRegister.mockReset();
    mocks.otherRegister.mockImplementation(({ program }: { program: Command }) => {
      program.command("other").description("Other commands");
    });
    mocks.memoryListAction.mockReset();
    mocks.loadOpenClawPluginCliRegistry.mockReset();
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue(createCliRegistry());
    mocks.loadOpenClawPlugins.mockReset();
    mocks.loadOpenClawPlugins.mockReturnValue({
      ...createCliRegistry(),
      diagnostics: [],
    });
    mocks.resolveManifestActivationPluginIds.mockReset();
    mocks.resolveManifestActivationPluginIds.mockReturnValue([]);
    mocks.applyPluginAutoEnable.mockReset();
    mocks.resolvePluginMetadataSnapshot.mockReset();
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(undefined);
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({
      config,
      changes: [],
      autoEnabledReasons: {},
    }));
    mocks.loadConfig.mockReset();
    mocks.loadConfig.mockReturnValue({} as OpenClawConfig);
    mocks.getRuntimeConfigSnapshot.mockReset();
    mocks.getRuntimeConfigSnapshot.mockReturnValue(null);
    mocks.readConfigFileSnapshot.mockReset();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: {},
      runtimeConfig: {},
    });
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
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });
    const snapshot = createCliMetadataSnapshot();
    const sibling = {
      id: "external-cli",
      origin: "global",
      format: "openclaw",
      cliCommands: [
        { name: "external-cli", description: "External utilities", hasSubcommands: false },
      ],
    };
    const plugins = [...snapshot.plugins, sibling];
    mocks.resolvePluginMetadataSnapshot.mockReturnValue({
      ...snapshot,
      index: {
        ...snapshot.index,
        plugins: [
          ...snapshot.index.plugins,
          { pluginId: "matrix", enabled: true, enabledByDefault: false, origin: "bundled" },
          { pluginId: sibling.id, enabled: true, origin: sibling.origin },
        ],
      },
      manifestRegistry: { plugins, diagnostics: [] },
      plugins,
      byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    });

    await expect(getPluginCliCommandDescriptors(rawConfig)).resolves.toEqual([
      {
        name: "matrix",
        description: "Matrix channel utilities",
        hasSubcommands: true,
      },
    ]);
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    onTestFinished(() => write.mockRestore());
    const { outputRootHelp } = await import("../cli/program/root-help.js");
    await outputRootHelp({ config: rawConfig });
    const help = write.mock.calls.map(([chunk]) => String(chunk)).join("");
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
    const healthySnapshot = createCliMetadataSnapshot();
    const legacySnapshot = createLegacyExternalCliMetadataSnapshot();
    const plugins = [
      ...healthySnapshot.plugins.map((plugin) => ({
        ...plugin,
        cliCommands: [...plugin.cliCommands, ...plugin.cliCommands],
      })),
      ...legacySnapshot.plugins,
    ];
    mocks.resolvePluginMetadataSnapshot.mockReturnValue({
      ...healthySnapshot,
      index: {
        ...healthySnapshot.index,
        plugins: [...healthySnapshot.index.plugins, ...legacySnapshot.index.plugins],
      },
      manifestRegistry: { plugins, diagnostics: [] },
      plugins,
      byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    });
    mocks.loadOpenClawPluginCliRegistry.mockRejectedValue(new Error("broken legacy CLI plugin"));
    const config = {
      plugins: { entries: { "legacy-cli": { enabled: true } } },
    } as OpenClawConfig;

    await expect(getPluginCliCommandDescriptors(config)).resolves.toEqual([
      {
        name: "matrix",
        description: "Matrix channel utilities",
        hasSubcommands: true,
      },
    ]);
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    onTestFinished(() => write.mockRestore());
    const { outputRootHelp } = await import("../cli/program/root-help.js");
    await outputRootHelp({ config });
    expect(write.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("matrix *");
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(getMockCallObject(mocks.loadOpenClawPluginCliRegistry).onlyPluginIds).toEqual([
      "legacy-cli",
    ]);
  });

  it("preserves root help for external plugins without manifest CLI descriptors", async () => {
    const config = {
      plugins: {
        entries: { "legacy-cli": { enabled: true } },
      },
    } as OpenClawConfig;
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(createLegacyExternalCliMetadataSnapshot());
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue({
      cliRegistrars: [
        {
          pluginId: "legacy-cli",
          register: vi.fn(),
          parentPath: [],
          commands: ["legacy"],
          descriptors: [
            {
              name: "legacy",
              description: "Legacy external command",
              hasSubcommands: true,
            },
          ],
          source: "/tmp/legacy-cli/index.js",
        },
      ],
    });

    await expect(getPluginCliCommandDescriptors(config)).resolves.toEqual([
      {
        name: "legacy",
        description: "Legacy external command",
        hasSubcommands: true,
      },
    ]);
    expect(getMockCallObject(mocks.loadOpenClawPluginCliRegistry).onlyPluginIds).toEqual([
      "legacy-cli",
    ]);
  });

  it("keeps runtime CLI command registration on the full plugin loader for legacy channel plugins", async () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });
    mocks.loadOpenClawPlugins.mockReturnValue(
      createCliRegistry({
        memoryCommands: ["legacy-channel"],
        memoryDescriptors: [
          {
            name: "legacy-channel",
            description: "Legacy channel commands",
            hasSubcommands: true,
          },
        ],
      }),
    );

    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: rawConfig,
      runtimeConfig: rawConfig,
    });
    await registerPluginCliCommandsFromValidatedConfig(createProgram(), undefined, undefined, {
      mode: "lazy",
    });

    const loadOptions = getMockCallObject(mocks.loadOpenClawPlugins);
    expect(loadOptions.config).toBe(autoEnabledConfig);
    expect(loadOptions.activationSourceConfig).toBe(rawConfig);
    expect(loadOptions.autoEnabledReasons).toEqual({
      demo: ["demo configured"],
    });
    expect(loadOptions.cache).toBe(false);
    expect(loadOptions.channelPluginLoadIntent).toBe("full");
    expect(mocks.loadOpenClawPluginCliRegistry).not.toHaveBeenCalled();
  });

  it("lazy-registers descriptor-backed plugin commands on first invocation", async () => {
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
      mode: "lazy",
    });

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
        memoryDescriptors: [
          {
            name: "memory",
            description: "Memory commands",
            hasSubcommands: true,
          },
        ],
      }),
    );
    mocks.memoryRegister.mockImplementation(({ program }: { program: Command }) => {
      program.command("memory");
      program.command("memory-admin");
    });

    await registerPluginCliCommandsFromValidatedConfig(createProgram(), undefined, undefined, {
      mode: "lazy",
    });

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
  });

  it("skips full plugin runtime loading when no metadata owns the requested primary", async () => {
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
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
