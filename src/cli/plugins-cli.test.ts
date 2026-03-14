import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import type { PluginInstallUpdate } from "../plugins/installs.js";
import type { SlotSelectionResult } from "../plugins/slots.js";
import type { PluginStatusReport } from "../plugins/status.js";

const mockReadConfigFileSnapshotForWrite =
  vi.fn<() => Promise<{ snapshot: ConfigFileSnapshot; writeOptions: Record<string, unknown> }>>();
const mockWriteConfigFile = vi.fn<
  (cfg: OpenClawConfig, options?: Record<string, unknown>) => Promise<void>
>(async () => {});
const mockInstallPluginFromPath =
  vi.fn<(params: { path: string; dryRun?: boolean }) => Promise<unknown>>();
const mockInstallPluginFromNpmSpec =
  vi.fn<(params: { spec: string; dryRun?: boolean }) => Promise<unknown>>();
const mockClearPluginManifestRegistryCache = vi.fn<() => void>();
const mockEnablePluginInConfig = vi.fn(
  (config: OpenClawConfig, pluginId: string): { config: OpenClawConfig; enabled: true } => ({
    config: {
      ...config,
      plugins: {
        ...config.plugins,
        entries: {
          ...config.plugins?.entries,
          [pluginId]: {
            enabled: true,
          },
        },
      },
    },
    enabled: true,
  }),
);
const mockRecordPluginInstall = vi.fn(
  (config: OpenClawConfig, install: PluginInstallUpdate): OpenClawConfig => ({
    ...config,
    plugins: {
      ...config.plugins,
      installs: {
        ...config.plugins?.installs,
        [install.pluginId]: {
          source: install.source,
          sourcePath: install.sourcePath,
          installPath: install.installPath,
          version: install.version,
        },
      },
    },
  }),
);
const mockBuildPluginStatusReport = vi.fn<() => PluginStatusReport>(() => ({
  workspaceDir: "/tmp",
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: [],
  providers: [],
  gatewayHandlers: {},
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  commands: [],
  diagnostics: [],
}));
const mockApplyExclusiveSlotSelection = vi.fn(
  ({ config }: { config: OpenClawConfig }): SlotSelectionResult => ({
    config,
    warnings: [],
    changed: false,
  }),
);
const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../config/config.js", () => ({
  loadConfig: () => {
    throw new Error("loadConfig should not be used for plugin install writes");
  },
  readConfigFileSnapshotForWrite: () => mockReadConfigFileSnapshotForWrite(),
  writeConfigFile: (cfg: OpenClawConfig, options?: Record<string, unknown>) =>
    mockWriteConfigFile(cfg, options),
}));

vi.mock("../plugins/install.js", () => ({
  installPluginFromPath: (params: { path: string; dryRun?: boolean }) =>
    mockInstallPluginFromPath(params),
  installPluginFromNpmSpec: (params: { spec: string; dryRun?: boolean }) =>
    mockInstallPluginFromNpmSpec(params),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  clearPluginManifestRegistryCache: () => mockClearPluginManifestRegistryCache(),
}));

vi.mock("../plugins/enable.js", () => ({
  enablePluginInConfig: (config: OpenClawConfig, pluginId: string) =>
    mockEnablePluginInConfig(config, pluginId),
}));

vi.mock("../plugins/installs.js", () => ({
  recordPluginInstall: (config: OpenClawConfig, install: PluginInstallUpdate) =>
    mockRecordPluginInstall(config, install),
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginStatusReport: () => mockBuildPluginStatusReport(),
}));

vi.mock("../plugins/slots.js", () => ({
  applyExclusiveSlotSelection: (params: { config: OpenClawConfig }) =>
    mockApplyExclusiveSlotSelection(params),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let registerPluginsCli: typeof import("./plugins-cli.js").registerPluginsCli;
let processExitSpy: ReturnType<typeof vi.spyOn>;
let tempPluginDir = "";

function buildSnapshot(params: {
  resolved: OpenClawConfig;
  config: OpenClawConfig;
}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: JSON.stringify(params.resolved),
    parsed: { $include: "./plugins.json" },
    resolved: params.resolved,
    valid: true,
    config: params.config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

async function runPluginsCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerPluginsCli(program);
  await program.parseAsync(args, { from: "user" });
}

describe("plugins cli", () => {
  beforeAll(async () => {
    processExitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code ?? 0}`);
    }) as never);
    tempPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-cli-"));
    ({ registerPluginsCli } = await import("./plugins-cli.js"));
  });

  afterAll(() => {
    processExitSpy.mockRestore();
    fs.rmSync(tempPluginDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("installs linked plugins from snapshot.resolved and preserves include-aware write options", async () => {
    const resolved: OpenClawConfig = {
      plugins: {
        entries: {
          existing: {
            enabled: true,
          },
        },
      },
    };
    const runtimeMerged: OpenClawConfig = {
      ...resolved,
      agents: {
        defaults: {
          model: "gpt-5.2",
        },
      } as never,
      commands: {
        ownerDisplay: "raw",
      } as never,
    };

    mockReadConfigFileSnapshotForWrite.mockResolvedValueOnce({
      snapshot: buildSnapshot({
        resolved,
        config: runtimeMerged,
      }),
      writeOptions: {
        expectedConfigPath: "/tmp/openclaw.json",
      },
    });
    mockInstallPluginFromPath.mockResolvedValueOnce({
      ok: true,
      pluginId: "discord",
      version: "2026.3.9",
    });

    await runPluginsCommand(["plugins", "install", tempPluginDir, "--link"]);

    expect(mockInstallPluginFromPath).toHaveBeenCalledWith({
      path: tempPluginDir,
      dryRun: true,
    });
    expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);

    const written = mockWriteConfigFile.mock.calls[0]?.[0];
    const options = mockWriteConfigFile.mock.calls[0]?.[1] as Record<string, unknown>;

    expect(written.plugins?.load?.paths).toEqual([tempPluginDir]);
    expect(written.plugins?.entries).toEqual({
      existing: {
        enabled: true,
      },
      discord: {
        enabled: true,
      },
    });
    expect(written.plugins?.installs?.discord).toEqual({
      source: "path",
      sourcePath: tempPluginDir,
      installPath: tempPluginDir,
      version: "2026.3.9",
    });
    expect(written).not.toHaveProperty("agents.defaults");
    expect(written).not.toHaveProperty("commands.ownerDisplay");
    expect(options).toMatchObject({
      expectedConfigPath: "/tmp/openclaw.json",
      preserveIncludes: true,
    });
  });
});
