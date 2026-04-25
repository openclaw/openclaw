import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  memoryRegister: vi.fn(),
  otherRegister: vi.fn(),
  memoryListAction: vi.fn(),
  loadOpenClawPluginCliRegistry: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
  resolveManifestActivationPluginIds: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  loadConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPluginCliRegistry: (...args: unknown[]) =>
    mocks.loadOpenClawPluginCliRegistry(...args),
  loadOpenClawPlugins: (...args: unknown[]) => mocks.loadOpenClawPlugins(...args),
}));

vi.mock("./activation-planner.js", () => ({
  resolveManifestActivationPluginIds: (...args: unknown[]) =>
    mocks.resolveManifestActivationPluginIds(...args),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => mocks.applyPluginAutoEnable(...args),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: (...args: unknown[]) => mocks.loadConfig(...args),
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
}));

let getPluginCliCommandDescriptors: typeof import("./cli.js").getPluginCliCommandDescriptors;
let loadValidatedConfigForPluginRegistration: typeof import("./cli.js").loadValidatedConfigForPluginRegistration;
let registerPluginCliCommands: typeof import("./cli.js").registerPluginCliCommands;
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
  memoryOrigin?: "bundled" | "global" | "workspace" | "config";
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
        commands: ["other"],
        descriptors: [],
        source: "bundled",
      },
    ],
    plugins: [
      {
        id: "memory-core",
        origin: params?.memoryOrigin ?? "bundled",
      },
      {
        id: "other",
        origin: "bundled",
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

function expectAutoEnabledCliLoad(params: {
  rawConfig: OpenClawConfig;
  autoEnabledConfig: OpenClawConfig;
  autoEnabledReasons?: Record<string, string[]>;
}) {
  expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
    config: params.rawConfig,
    env: process.env,
  });
  expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
    expect.objectContaining({
      config: params.autoEnabledConfig,
      activationSourceConfig: params.rawConfig,
      autoEnabledReasons: params.autoEnabledReasons ?? {},
    }),
  );
}

describe("registerPluginCliCommands", () => {
  beforeAll(async () => {
    ({
      getPluginCliCommandDescriptors,
      loadValidatedConfigForPluginRegistration,
      registerPluginCliCommands,
      registerPluginCliCommandsFromValidatedConfig,
    } = await import("./cli.js"));
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
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({
      config,
      changes: [],
      autoEnabledReasons: {},
    }));
    mocks.loadConfig.mockReset();
    mocks.loadConfig.mockReturnValue({} as OpenClawConfig);
    mocks.readConfigFileSnapshot.mockReset();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: {},
    });
  });

  it("skips plugin CLI registrars when commands already exist", async () => {
    const program = createProgram("memory");

    await registerPluginCliCommands(program, {} as OpenClawConfig);

    expect(mocks.memoryRegister).not.toHaveBeenCalled();
    expect(mocks.otherRegister).toHaveBeenCalledTimes(1);
  });

  it("forwards an explicit env to plugin loading", async () => {
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    await registerPluginCliCommands(createProgram(), {} as OpenClawConfig, env);

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
      }),
    );
  });

  it("probes cli-metadata when the loader reports an async register rejected as non-synchronous", async () => {
    mocks.loadOpenClawPlugins.mockReturnValue({
      ...createCliRegistry(),
      diagnostics: [
        {
          level: "error" as const,
          pluginId: "memory-core",
          source: "bundled" as const,
          message: "plugin failed during register: Error: plugin register must be synchronous",
        },
      ],
    });

    await registerPluginCliCommands(createProgram(), {} as OpenClawConfig);

    expect(mocks.loadOpenClawPluginCliRegistry).toHaveBeenCalled();
  });

  it("loads plugin CLI commands from the auto-enabled config snapshot", async () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });

    await registerPluginCliCommands(createProgram(), rawConfig);

    expectAutoEnabledCliLoad({
      rawConfig,
      autoEnabledConfig,
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });
    expect(mocks.memoryRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
      }),
    );
  });

  it("loads root-help descriptors through the dedicated non-activating CLI collector", async () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue({
      cliRegistrars: [
        {
          pluginId: "matrix",
          register: vi.fn(),
          commands: ["matrix"],
          descriptors: [
            {
              name: "matrix",
              description: "Matrix channel utilities",
              hasSubcommands: true,
            },
          ],
          source: "bundled",
        },
        {
          pluginId: "duplicate-matrix",
          register: vi.fn(),
          commands: ["matrix"],
          descriptors: [
            {
              name: "matrix",
              description: "Duplicate Matrix channel utilities",
              hasSubcommands: true,
            },
          ],
          source: "bundled",
        },
      ],
    });

    await expect(getPluginCliCommandDescriptors(rawConfig)).resolves.toEqual([
      {
        name: "matrix",
        description: "Matrix channel utilities",
        hasSubcommands: true,
      },
    ]);
    expect(mocks.loadOpenClawPluginCliRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
        activationSourceConfig: rawConfig,
        autoEnabledReasons: {
          demo: ["demo configured"],
        },
      }),
    );
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

    await registerPluginCliCommands(createProgram(), rawConfig, undefined, undefined, {
      mode: "lazy",
    });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
        activationSourceConfig: rawConfig,
        autoEnabledReasons: {
          demo: ["demo configured"],
        },
        activate: false,
        cache: false,
      }),
    );
    expect(mocks.loadOpenClawPluginCliRegistry).not.toHaveBeenCalled();
  });

  it("lazy-registers descriptor-backed plugin commands on first invocation", async () => {
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
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

    await registerPluginCliCommands(createProgram(), {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
    });

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
  });

  it("registers a selected plugin primary eagerly during lazy startup", async () => {
    const program = createProgram();
    program.exitOverride();
    mocks.resolveManifestActivationPluginIds.mockReturnValue(["memory-core"]);

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
      primary: "memory",
    });

    expect(program.commands.filter((command) => command.name() === "memory")).toHaveLength(1);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["memory-core"],
      }),
    );

    await program.parseAsync(["memory", "list"], { from: "user" });

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
    expect(mocks.memoryListAction).toHaveBeenCalledTimes(1);
  });

  it("prefers cli-metadata registration for a selected lazy primary", async () => {
    mocks.resolveManifestActivationPluginIds.mockReturnValue(["memory-core"]);
    const metadataRegister = vi.fn(async ({ program }: { program: Command }) => {
      const memory = program.command("memory").description("Memory commands");
      memory.command("list").action(mocks.memoryListAction);
    });
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue({
      cliRegistrars: [
        {
          pluginId: "memory-core",
          register: metadataRegister,
          commands: ["memory"],
          descriptors: [
            {
              name: "memory",
              description: "Memory commands",
              hasSubcommands: true,
            },
          ],
          source: "bundled",
        },
      ],
      diagnostics: [],
    });
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
      primary: "memory",
    });

    expect(mocks.loadOpenClawPluginCliRegistry).toHaveBeenCalledTimes(1);
    expect(metadataRegister).toHaveBeenCalledTimes(1);
    expect(mocks.memoryRegister).not.toHaveBeenCalled();

    await program.parseAsync(["memory", "list"], { from: "user" });

    expect(metadataRegister).toHaveBeenCalledTimes(1);
    expect(mocks.memoryListAction).toHaveBeenCalledTimes(1);
  });

  it("prefers cli-metadata for a selected lazy primary when metadata is command-only (no descriptor rows)", async () => {
    mocks.resolveManifestActivationPluginIds.mockReturnValue(["memory-core"]);
    const metadataRegister = vi.fn(async ({ program }: { program: Command }) => {
      const memory = program.command("memory").description("Memory");
      memory.command("list").action(mocks.memoryListAction);
    });
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue({
      cliRegistrars: [
        {
          pluginId: "memory-core",
          register: metadataRegister,
          commands: ["memory"],
          descriptors: [],
          source: "bundled",
        },
      ],
      diagnostics: [],
    });
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
      primary: "memory",
    });

    expect(mocks.loadOpenClawPluginCliRegistry).toHaveBeenCalledTimes(1);
    expect(metadataRegister).toHaveBeenCalledTimes(1);
    expect(mocks.memoryRegister).not.toHaveBeenCalled();

    await program.parseAsync(["memory", "list"], { from: "user" });
    expect(mocks.memoryListAction).toHaveBeenCalledTimes(1);
  });

  it("keeps runtime registration when metadata only provides a command stub", async () => {
    mocks.resolveManifestActivationPluginIds.mockReturnValue(["memory-core"]);
    const metadataRegister = vi.fn();
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue({
      cliRegistrars: [
        {
          pluginId: "memory-core",
          register: metadataRegister,
          commands: ["memory"],
          descriptors: [],
          source: "bundled",
        },
      ],
      diagnostics: [],
    });
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
      primary: "memory",
    });

    expect(mocks.loadOpenClawPluginCliRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
    expect(metadataRegister).not.toHaveBeenCalled();
  });

  it("keeps runtime registration when metadata only covers part of the command roots", async () => {
    mocks.resolveManifestActivationPluginIds.mockReturnValue(["memory-core"]);
    const metadataRegister = vi.fn(async ({ program }: { program: Command }) => {
      const memory = program.command("memory").description("Memory commands");
      memory.command("list").action(mocks.memoryListAction);
    });
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
      const memory = program.command("memory").description("Memory commands");
      memory.command("list").action(mocks.memoryListAction);
      program.command("memory-admin").description("Memory admin");
    });
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue({
      cliRegistrars: [
        {
          pluginId: "memory-core",
          register: metadataRegister,
          commands: ["memory"],
          descriptors: [
            {
              name: "memory",
              description: "Memory commands",
              hasSubcommands: true,
            },
          ],
          source: "bundled",
        },
      ],
      diagnostics: [],
    });
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
      primary: "memory",
    });

    expect(mocks.loadOpenClawPluginCliRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
    expect(metadataRegister).not.toHaveBeenCalled();
  });

  it("keeps full CLI loading when primary command planning finds no plugin match", async () => {
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
      primary: "memory",
    });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.not.objectContaining({
        onlyPluginIds: expect.anything(),
      }),
    );
    expect(mocks.loadOpenClawPluginCliRegistry).not.toHaveBeenCalled();
  });

  it("keeps runtime registration for scoped non-bundled primaries", async () => {
    mocks.resolveManifestActivationPluginIds.mockReturnValue(["memory-core"]);
    mocks.loadOpenClawPlugins.mockReturnValue({
      ...createCliRegistry({
        memoryOrigin: "workspace",
      }),
      diagnostics: [],
    });
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
      primary: "memory",
    });

    expect(mocks.loadOpenClawPluginCliRegistry).not.toHaveBeenCalled();
    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
  });

  it("uses the first registry row for duplicate plugin ids when gating metadata", async () => {
    mocks.resolveManifestActivationPluginIds.mockReturnValue(["memory-core"]);
    mocks.loadOpenClawPlugins.mockReturnValue({
      ...createCliRegistry(),
      plugins: [
        { id: "memory-core", origin: "config" },
        { id: "memory-core", origin: "bundled" },
        { id: "other", origin: "bundled" },
      ],
      diagnostics: [],
    });
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
      primary: "memory",
    });

    expect(mocks.loadOpenClawPluginCliRegistry).not.toHaveBeenCalled();
    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
  });

  it("returns null for validated plugin CLI config when the snapshot is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: false,
      config: { plugins: { load: { paths: ["/tmp/evil"] } } },
    });

    await expect(loadValidatedConfigForPluginRegistration()).resolves.toBeNull();
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });

  it("loads validated plugin CLI config when the snapshot is valid", async () => {
    const loadedConfig = { plugins: { enabled: true } } as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: true,
      config: loadedConfig,
    });
    mocks.loadConfig.mockReturnValueOnce(loadedConfig);

    await expect(loadValidatedConfigForPluginRegistration()).resolves.toBe(loadedConfig);
    expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
  });

  it("skips plugin CLI registration from validated config when the snapshot is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: false,
      config: {},
    });

    await expect(registerPluginCliCommandsFromValidatedConfig(createProgram())).resolves.toBeNull();
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });
});
