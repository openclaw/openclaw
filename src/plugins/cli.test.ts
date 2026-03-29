import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  memoryRegister: vi.fn(),
  otherRegister: vi.fn(),
  memoryListAction: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  discoverOpenClawPlugins: vi.fn(),
  loadPluginManifestRegistry: vi.fn(),
  resolveEffectiveEnableState: vi.fn(),
  resolveMemorySlotDecision: vi.fn(),
  createJiti: vi.fn(),
}));

vi.mock("jiti", () => ({
  createJiti: (...args: unknown[]) => mocks.createJiti(...args),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => mocks.loadOpenClawPlugins(...args),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => mocks.applyPluginAutoEnable(...args),
}));

vi.mock("./discovery.js", () => ({
  discoverOpenClawPlugins: (...args: unknown[]) => mocks.discoverOpenClawPlugins(...args),
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => mocks.loadPluginManifestRegistry(...args),
}));

vi.mock("./config-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config-state.js")>();
  return {
    ...actual,
    resolveEffectiveEnableState: (...args: unknown[]) => mocks.resolveEffectiveEnableState(...args),
    resolveMemorySlotDecision: (...args: unknown[]) => mocks.resolveMemorySlotDecision(...args),
  };
});

import { getPluginCliCommandDescriptors, registerPluginCliCommands } from "./cli.js";

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
  };
}

function expectPluginLoaderConfig(config: OpenClawConfig) {
  expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
    expect.objectContaining({
      config,
    }),
  );
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
}) {
  expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
    config: params.rawConfig,
    env: process.env,
  });
  expectPluginLoaderConfig(params.autoEnabledConfig);
}

describe("registerPluginCliCommands", () => {
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
    mocks.loadOpenClawPlugins.mockReset();
    mocks.loadOpenClawPlugins.mockReturnValue(createCliRegistry());
    mocks.applyPluginAutoEnable.mockReset();
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.discoverOpenClawPlugins.mockReset();
    mocks.discoverOpenClawPlugins.mockReturnValue({
      candidates: [],
      diagnostics: [],
    });
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    mocks.resolveEffectiveEnableState.mockReset();
    mocks.resolveEffectiveEnableState.mockReturnValue({ enabled: true });
    mocks.resolveMemorySlotDecision.mockReset();
    mocks.resolveMemorySlotDecision.mockReturnValue({ enabled: true });
    mocks.createJiti.mockReset();
    mocks.createJiti.mockReturnValue(() => ({}));
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

  it("loads plugin CLI commands from the auto-enabled config snapshot", async () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });

    await registerPluginCliCommands(createProgram(), rawConfig);

    expectAutoEnabledCliLoad({ rawConfig, autoEnabledConfig });
    expect(mocks.memoryRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
      }),
    );
  });

  it("captures channel plugin descriptors without using the activating loader", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-cli-descriptors-"));
    const pluginRoot = path.join(tempRoot, "matrix");
    const source = path.join(pluginRoot, "index.ts");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(source, "export default {}");
    mocks.discoverOpenClawPlugins.mockReturnValue({
      candidates: [],
      diagnostics: [],
    });
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "matrix",
          enabledByDefault: true,
          format: "openclaw",
          channels: ["matrix"],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "bundled",
          rootDir: pluginRoot,
          source,
          manifestPath: path.join(pluginRoot, "openclaw.plugin.json"),
        },
      ],
      diagnostics: [],
    });
    const registerFull = vi.fn();
    mocks.createJiti.mockReturnValue(
      () =>
        ({
          default: {
            id: "matrix",
            name: "Matrix",
            description: "Matrix channel plugin",
            channelPlugin: {},
            register(api: {
              registrationMode: "full" | "setup-only" | "setup-runtime";
              registerChannel: (registration: unknown) => void;
              registerCli: (
                registrar: () => void,
                opts: {
                  descriptors: Array<{
                    name: string;
                    description: string;
                    hasSubcommands: boolean;
                  }>;
                },
              ) => void;
            }) {
              api.registerChannel({ plugin: {} });
              api.registerCli(() => {}, {
                descriptors: [
                  {
                    name: "matrix",
                    description: "Matrix channel utilities",
                    hasSubcommands: true,
                  },
                ],
              });
              if (api.registrationMode === "full") {
                registerFull();
              }
            },
          },
        }) as never,
    );

    try {
      expect(getPluginCliCommandDescriptors({} as OpenClawConfig)).toEqual([
        {
          name: "matrix",
          description: "Matrix channel utilities",
          hasSubcommands: true,
        },
      ]);
      expect(registerFull).not.toHaveBeenCalled();
      expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps non-channel descriptor capture in full registration mode", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-cli-descriptors-"));
    const pluginRoot = path.join(tempRoot, "memory-core");
    const source = path.join(pluginRoot, "index.ts");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(source, "export default {}");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "memory-core",
          enabledByDefault: true,
          format: "openclaw",
          kind: "memory",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "bundled",
          rootDir: pluginRoot,
          source,
          manifestPath: path.join(pluginRoot, "openclaw.plugin.json"),
        },
      ],
      diagnostics: [],
    });
    const seenModes: string[] = [];
    mocks.createJiti.mockReturnValue(
      () =>
        ({
          default: {
            id: "memory-core",
            name: "Memory (Core)",
            description: "Memory plugin",
            register(api: {
              registrationMode: string;
              registerCli: (
                registrar: () => void,
                opts: {
                  descriptors: Array<{
                    name: string;
                    description: string;
                    hasSubcommands: boolean;
                  }>;
                },
              ) => void;
            }) {
              seenModes.push(api.registrationMode);
              api.registerCli(() => {}, {
                descriptors: [
                  {
                    name: "memory",
                    description: "Memory commands",
                    hasSubcommands: true,
                  },
                ],
              });
            },
          },
        }) as never,
    );

    try {
      expect(getPluginCliCommandDescriptors({} as OpenClawConfig)).toEqual([
        {
          name: "memory",
          description: "Memory commands",
          hasSubcommands: true,
        },
      ]);
      expect(seenModes).toEqual(["full"]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
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

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
      primary: "memory",
    });

    expect(program.commands.filter((command) => command.name() === "memory")).toHaveLength(1);

    await program.parseAsync(["memory", "list"], { from: "user" });

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
    expect(mocks.memoryListAction).toHaveBeenCalledTimes(1);
  });
});
