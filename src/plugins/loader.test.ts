import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";
async function importFreshPluginTestModules() {
  vi.resetModules();
  vi.doUnmock("node:fs");
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("node:module");
  vi.doUnmock("./hook-runner-global.js");
  vi.doUnmock("./hooks.js");
  vi.doUnmock("./loader.js");
  vi.doUnmock("jiti");
  const [loader, hookRunnerGlobal, hooks, runtime, registry] = await Promise.all([
    import("./loader.js"),
    import("./hook-runner-global.js"),
    import("./hooks.js"),
    import("./runtime.js"),
    import("./registry.js"),
  ]);
  return {
    ...loader,
    ...hookRunnerGlobal,
    ...hooks,
    ...runtime,
    ...registry,
  };
}

const {
  __testing,
  clearPluginLoaderCache,
  createHookRunner,
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getGlobalHookRunner,
  loadOpenClawPlugins,
  resetGlobalHookRunner,
  setActivePluginRegistry,
} = await importFreshPluginTestModules();

type TempPlugin = { dir: string; file: string; id: string };

function chmodSafeDir(dir: string) {
  if (process.platform === "win32") {
    return;
  }
  fs.chmodSync(dir, 0o755);
}

function mkdtempSafe(prefix: string) {
  const dir = fs.mkdtempSync(prefix);
  chmodSafeDir(dir);
  return dir;
}

function mkdirSafe(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  chmodSafeDir(dir);
}

const fixtureRoot = mkdtempSafe(path.join(os.tmpdir(), "openclaw-plugin-"));
let tempDirIndex = 0;
const prevBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };
let cachedBundledTelegramDir = "";
let cachedBundledMemoryDir = "";
const BUNDLED_TELEGRAM_PLUGIN_BODY = `module.exports = {
  id: "telegram",
  register(api) {
    api.registerChannel({
      plugin: {
        id: "telegram",
        meta: {
          id: "telegram",
          label: "Telegram",
          selectionLabel: "Telegram",
          docsPath: "/channels/telegram",
          blurb: "telegram channel",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
};`;

function makeTempDir() {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  mkdirSafe(dir);
  return dir;
}

function writePlugin(params: {
  id: string;
  body: string;
  dir?: string;
  filename?: string;
}): TempPlugin {
  const dir = params.dir ?? makeTempDir();
  const filename = params.filename ?? `${params.id}.cjs`;
  mkdirSafe(dir);
  const file = path.join(dir, filename);
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return { dir, file, id: params.id };
}

function loadBundledMemoryPluginRegistry(options?: {
  packageMeta?: { name: string; version: string; description?: string };
  pluginBody?: string;
  pluginFilename?: string;
}) {
  if (!options && cachedBundledMemoryDir) {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = cachedBundledMemoryDir;
    return loadOpenClawPlugins({
      cache: false,
      workspaceDir: cachedBundledMemoryDir,
      config: {
        plugins: {
          slots: {
            memory: "memory-core",
          },
        },
      },
    });
  }

  const bundledDir = makeTempDir();
  let pluginDir = bundledDir;
  let pluginFilename = options?.pluginFilename ?? "memory-core.cjs";

  if (options?.packageMeta) {
    pluginDir = path.join(bundledDir, "memory-core");
    pluginFilename = options.pluginFilename ?? "index.js";
    mkdirSafe(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: options.packageMeta.name,
          version: options.packageMeta.version,
          description: options.packageMeta.description,
          openclaw: { extensions: [`./${pluginFilename}`] },
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  writePlugin({
    id: "memory-core",
    body:
      options?.pluginBody ??
      `module.exports = { id: "memory-core", kind: "memory", register() {} };`,
    dir: pluginDir,
    filename: pluginFilename,
  });
  if (!options) {
    cachedBundledMemoryDir = bundledDir;
  }
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

  return loadOpenClawPlugins({
    cache: false,
    workspaceDir: bundledDir,
    config: {
      plugins: {
        slots: {
          memory: "memory-core",
        },
      },
    },
  });
}

function setupBundledTelegramPlugin() {
  if (!cachedBundledTelegramDir) {
    cachedBundledTelegramDir = makeTempDir();
    writePlugin({
      id: "telegram",
      body: BUNDLED_TELEGRAM_PLUGIN_BODY,
      dir: cachedBundledTelegramDir,
      filename: "telegram.cjs",
    });
  }
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = cachedBundledTelegramDir;
}

function expectTelegramLoaded(registry: ReturnType<typeof loadOpenClawPlugins>) {
  const telegram = registry.plugins.find((entry) => entry.id === "telegram");
  expect(telegram?.status).toBe("loaded");
  expect(registry.channels.some((entry) => entry.plugin.id === "telegram")).toBe(true);
}

function useNoBundledPlugins() {
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
}

function loadRegistryFromSinglePlugin(params: {
  plugin: TempPlugin;
  pluginConfig?: Record<string, unknown>;
  includeWorkspaceDir?: boolean;
  options?: Omit<Parameters<typeof loadOpenClawPlugins>[0], "cache" | "workspaceDir" | "config">;
}) {
  const pluginConfig = params.pluginConfig ?? {};
  return loadOpenClawPlugins({
    cache: false,
    ...(params.includeWorkspaceDir === false ? {} : { workspaceDir: params.plugin.dir }),
    ...params.options,
    config: {
      plugins: {
        load: { paths: [params.plugin.file] },
        ...pluginConfig,
      },
    },
  });
}

function createWarningLogger(warnings: string[]) {
  return {
    info: () => {},
    warn: (msg: string) => warnings.push(msg),
    error: () => {},
  };
}

function createErrorLogger(errors: string[]) {
  return {
    info: () => {},
    warn: () => {},
    error: (msg: string) => errors.push(msg),
    debug: () => {},
  };
}

function createEscapingEntryFixture(params: { id: string; sourceBody: string }) {
  const pluginDir = makeTempDir();
  const outsideDir = makeTempDir();
  const outsideEntry = path.join(outsideDir, "outside.cjs");
  const linkedEntry = path.join(pluginDir, "entry.cjs");
  fs.writeFileSync(outsideEntry, params.sourceBody, "utf-8");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return { pluginDir, outsideEntry, linkedEntry };
}

function createPluginSdkAliasFixture(params?: {
  srcFile?: string;
  distFile?: string;
  srcBody?: string;
  distBody?: string;
}) {
  const root = makeTempDir();
  const srcFile = path.join(root, "src", "plugin-sdk", params?.srcFile ?? "index.ts");
  const distFile = path.join(root, "dist", "plugin-sdk", params?.distFile ?? "index.js");
  mkdirSafe(path.dirname(srcFile));
  mkdirSafe(path.dirname(distFile));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(srcFile, params?.srcBody ?? "export {};\n", "utf-8");
  fs.writeFileSync(distFile, params?.distBody ?? "export {};\n", "utf-8");
  return { root, srcFile, distFile };
}

function createPluginRuntimeAliasFixture(params?: { srcBody?: string; distBody?: string }) {
  const root = makeTempDir();
  const srcFile = path.join(root, "src", "plugins", "runtime", "index.ts");
  const distFile = path.join(root, "dist", "plugins", "runtime", "index.js");
  mkdirSafe(path.dirname(srcFile));
  mkdirSafe(path.dirname(distFile));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    srcFile,
    params?.srcBody ?? "export const createPluginRuntime = () => ({});\n",
    "utf-8",
  );
  fs.writeFileSync(
    distFile,
    params?.distBody ?? "export const createPluginRuntime = () => ({});\n",
    "utf-8",
  );
  return { root, srcFile, distFile };
}

function loadBundleFixture(params: {
  pluginId: string;
  build: (bundleRoot: string) => void;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}) {
  useNoBundledPlugins();
  const workspaceDir = makeTempDir();
  const stateDir = makeTempDir();
  const bundleRoot = path.join(workspaceDir, ".openclaw", "extensions", params.pluginId);
  params.build(bundleRoot);
  return withEnv({ OPENCLAW_STATE_DIR: stateDir, ...params.env }, () =>
    loadOpenClawPlugins({
      workspaceDir,
      onlyPluginIds: params.onlyPluginIds ?? [params.pluginId],
      config: {
        plugins: {
          entries: {
            [params.pluginId]: {
              enabled: true,
            },
          },
        },
      },
      cache: false,
    }),
  );
}

function expectNoUnwiredBundleDiagnostic(
  registry: ReturnType<typeof loadOpenClawPlugins>,
  pluginId: string,
) {
  expect(
    registry.diagnostics.some(
      (diag) =>
        diag.pluginId === pluginId &&
        diag.message.includes("bundle capability detected but not wired"),
    ),
  ).toBe(false);
}

function resolveLoadedPluginSource(
  registry: ReturnType<typeof loadOpenClawPlugins>,
  pluginId: string,
) {
  return fs.realpathSync(registry.plugins.find((entry) => entry.id === pluginId)?.source ?? "");
}

function expectCachePartitionByPluginSource(params: {
  pluginId: string;
  loadFirst: () => ReturnType<typeof loadOpenClawPlugins>;
  loadSecond: () => ReturnType<typeof loadOpenClawPlugins>;
  expectedFirstSource: string;
  expectedSecondSource: string;
}) {
  const first = params.loadFirst();
  const second = params.loadSecond();

  expect(second).not.toBe(first);
  expect(resolveLoadedPluginSource(first, params.pluginId)).toBe(
    fs.realpathSync(params.expectedFirstSource),
  );
  expect(resolveLoadedPluginSource(second, params.pluginId)).toBe(
    fs.realpathSync(params.expectedSecondSource),
  );
}

function expectCacheMissThenHit(params: {
  loadFirst: () => ReturnType<typeof loadOpenClawPlugins>;
  loadVariant: () => ReturnType<typeof loadOpenClawPlugins>;
}) {
  const first = params.loadFirst();
  const second = params.loadVariant();
  const third = params.loadVariant();

  expect(second).not.toBe(first);
  expect(third).toBe(second);
}

afterEach(() => {
  clearPluginLoaderCache();
  if (prevBundledDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = prevBundledDir;
  }
});

describe("bundle plugins", () => {
  it("reports Codex bundles as loaded bundle plugins without importing runtime code", () => {
    useNoBundledPlugins();
    const workspaceDir = makeTempDir();
    const stateDir = makeTempDir();
    const bundleRoot = path.join(workspaceDir, ".openclaw", "extensions", "sample-bundle");
    mkdirSafe(path.join(bundleRoot, ".codex-plugin"));
    mkdirSafe(path.join(bundleRoot, "skills"));
    fs.writeFileSync(
      path.join(bundleRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "Sample Bundle",
        description: "Codex bundle fixture",
        skills: "skills",
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(bundleRoot, "skills", "SKILL.md"),
      "---\ndescription: fixture\n---\n",
    );

    const registry = withEnv({ OPENCLAW_STATE_DIR: stateDir }, () =>
      loadOpenClawPlugins({
        workspaceDir,
        onlyPluginIds: ["sample-bundle"],
        config: {
          plugins: {
            entries: {
              "sample-bundle": {
                enabled: true,
              },
            },
          },
        },
        cache: false,
      }),
    );

    const plugin = registry.plugins.find((entry) => entry.id === "sample-bundle");
    expect(plugin?.status).toBe("loaded");
    expect(plugin?.format).toBe("bundle");
    expect(plugin?.bundleFormat).toBe("codex");
    expect(plugin?.bundleCapabilities).toContain("skills");
  });

  it.each([
    {
      name: "treats Claude command roots and settings as supported bundle surfaces",
      pluginId: "claude-skills",
      expectedFormat: "claude",
      expectedCapabilities: ["skills", "commands", "settings"],
      build: (bundleRoot: string) => {
        mkdirSafe(path.join(bundleRoot, "commands"));
        fs.writeFileSync(
          path.join(bundleRoot, "commands", "review.md"),
          "---\ndescription: fixture\n---\n",
        );
        fs.writeFileSync(
          path.join(bundleRoot, "settings.json"),
          '{"hideThinkingBlock":true}',
          "utf-8",
        );
      },
    },
    {
      name: "treats bundle MCP as a supported bundle surface",
      pluginId: "claude-mcp",
      expectedFormat: "claude",
      expectedCapabilities: ["mcpServers"],
      build: (bundleRoot: string) => {
        mkdirSafe(path.join(bundleRoot, ".claude-plugin"));
        fs.writeFileSync(
          path.join(bundleRoot, ".claude-plugin", "plugin.json"),
          JSON.stringify({
            name: "Claude MCP",
          }),
          "utf-8",
        );
        fs.writeFileSync(
          path.join(bundleRoot, ".mcp.json"),
          JSON.stringify({
            mcpServers: {
              probe: {
                command: "node",
                args: ["./probe.mjs"],
              },
            },
          }),
          "utf-8",
        );
      },
    },
    {
      name: "treats Cursor command roots as supported bundle skill surfaces",
      pluginId: "cursor-skills",
      expectedFormat: "cursor",
      expectedCapabilities: ["skills", "commands"],
      build: (bundleRoot: string) => {
        mkdirSafe(path.join(bundleRoot, ".cursor-plugin"));
        mkdirSafe(path.join(bundleRoot, ".cursor", "commands"));
        fs.writeFileSync(
          path.join(bundleRoot, ".cursor-plugin", "plugin.json"),
          JSON.stringify({
            name: "Cursor Skills",
          }),
          "utf-8",
        );
        fs.writeFileSync(
          path.join(bundleRoot, ".cursor", "commands", "review.md"),
          "---\ndescription: fixture\n---\n",
        );
      },
    },
  ])("$name", ({ pluginId, expectedFormat, expectedCapabilities, build }) => {
    const registry = loadBundleFixture({ pluginId, build });
    const plugin = registry.plugins.find((entry) => entry.id === pluginId);

    expect(plugin?.status).toBe("loaded");
    expect(plugin?.bundleFormat).toBe(expectedFormat);
    expect(plugin?.bundleCapabilities).toEqual(expect.arrayContaining(expectedCapabilities));
    expectNoUnwiredBundleDiagnostic(registry, pluginId);
  });

  it("warns when bundle MCP only declares unsupported non-stdio transports", () => {
    const stateDir = makeTempDir();
    const registry = loadBundleFixture({
      pluginId: "claude-mcp-url",
      env: {
        OPENCLAW_HOME: stateDir,
      },
      build: (bundleRoot) => {
        mkdirSafe(path.join(bundleRoot, ".claude-plugin"));
        fs.writeFileSync(
          path.join(bundleRoot, ".claude-plugin", "plugin.json"),
          JSON.stringify({
            name: "Claude MCP URL",
          }),
          "utf-8",
        );
        fs.writeFileSync(
          path.join(bundleRoot, ".mcp.json"),
          JSON.stringify({
            mcpServers: {
              remoteProbe: {
                url: "http://127.0.0.1:8787/mcp",
              },
            },
          }),
          "utf-8",
        );
      },
    });

    const plugin = registry.plugins.find((entry) => entry.id === "claude-mcp-url");
    expect(plugin?.status).toBe("loaded");
    expect(plugin?.bundleCapabilities).toEqual(expect.arrayContaining(["mcpServers"]));
    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.pluginId === "claude-mcp-url" &&
          diag.message.includes("stdio only today") &&
          diag.message.includes("remoteProbe"),
      ),
    ).toBe(true);
  });
});

afterAll(() => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  } finally {
    cachedBundledTelegramDir = "";
    cachedBundledMemoryDir = "";
  }
});

describe("loadOpenClawPlugins", () => {
  it("disables bundled plugins by default", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "bundled",
      body: `module.exports = { id: "bundled", register() {} };`,
      dir: bundledDir,
      filename: "bundled.cjs",
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["bundled"],
        },
      },
    });

    const bundled = registry.plugins.find((entry) => entry.id === "bundled");
    expect(bundled?.status).toBe("disabled");
  });

  it("loads bundled telegram plugin when enabled", () => {
    setupBundledTelegramPlugin();

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: cachedBundledTelegramDir,
      config: {
        plugins: {
          allow: ["telegram"],
          entries: {
            telegram: { enabled: true },
          },
        },
      },
    });

    expectTelegramLoaded(registry);
  });

  it("loads bundled channel plugins when channels.<id>.enabled=true", () => {
    setupBundledTelegramPlugin();

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: cachedBundledTelegramDir,
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          enabled: true,
        },
      },
    });

    expectTelegramLoaded(registry);
  });

  it("still respects explicit disable via plugins.entries for bundled channels", () => {
    setupBundledTelegramPlugin();

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: cachedBundledTelegramDir,
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          entries: {
            telegram: { enabled: false },
          },
        },
      },
    });

    const telegram = registry.plugins.find((entry) => entry.id === "telegram");
    expect(telegram?.status).toBe("disabled");
    expect(telegram?.error).toBe("disabled in config");
  });

  it("preserves package.json metadata for bundled memory plugins", () => {
    const registry = loadBundledMemoryPluginRegistry({
      packageMeta: {
        name: "@openclaw/memory-core",
        version: "1.2.3",
        description: "Memory plugin package",
      },
      pluginBody:
        'module.exports = { id: "memory-core", kind: "memory", name: "Memory (Core)", register() {} };',
    });

    const memory = registry.plugins.find((entry) => entry.id === "memory-core");
    expect(memory?.status).toBe("loaded");
    expect(memory?.origin).toBe("bundled");
    expect(memory?.name).toBe("Memory (Core)");
    expect(memory?.version).toBe("1.2.3");
  });
  it("loads plugins from config paths", () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "allowed",
      filename: "allowed.cjs",
      body: `module.exports = {
  id: "allowed",
  register(api) {
    api.registerGatewayMethod("allowed.ping", ({ respond }) => respond(true, { ok: true }));
  },
};`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["allowed"],
        },
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "allowed");
    expect(loaded?.status).toBe("loaded");
    expect(Object.keys(registry.gatewayHandlers)).toContain("allowed.ping");
  });

  it("limits imports to the requested plugin ids", () => {
    useNoBundledPlugins();
    const allowed = writePlugin({
      id: "allowed",
      filename: "allowed.cjs",
      body: `module.exports = { id: "allowed", register() {} };`,
    });
    const skippedMarker = path.join(makeTempDir(), "skipped-loaded.txt");
    const skipped = writePlugin({
      id: "skipped",
      filename: "skipped.cjs",
      body: `require("node:fs").writeFileSync(${JSON.stringify(skippedMarker)}, "loaded", "utf-8");
module.exports = { id: "skipped", register() { throw new Error("skipped plugin should not load"); } };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [allowed.file, skipped.file] },
          allow: ["allowed", "skipped"],
        },
      },
      onlyPluginIds: ["allowed"],
    });

    expect(registry.plugins.map((entry) => entry.id)).toEqual(["allowed"]);
    expect(fs.existsSync(skippedMarker)).toBe(false);
  });

  it("keeps scoped plugin loads in a separate cache entry", () => {
    useNoBundledPlugins();
    const allowed = writePlugin({
      id: "allowed",
      filename: "allowed.cjs",
      body: `module.exports = { id: "allowed", register() {} };`,
    });
    const extra = writePlugin({
      id: "extra",
      filename: "extra.cjs",
      body: `module.exports = { id: "extra", register() {} };`,
    });
    const options = {
      config: {
        plugins: {
          load: { paths: [allowed.file, extra.file] },
          allow: ["allowed", "extra"],
        },
      },
    };

    const full = loadOpenClawPlugins(options);
    const scoped = loadOpenClawPlugins({
      ...options,
      onlyPluginIds: ["allowed"],
    });
    const scopedAgain = loadOpenClawPlugins({
      ...options,
      onlyPluginIds: ["allowed"],
    });

    expect(full.plugins.map((entry) => entry.id).toSorted()).toEqual(["allowed", "extra"]);
    expect(scoped).not.toBe(full);
    expect(scoped.plugins.map((entry) => entry.id)).toEqual(["allowed"]);
    expect(scopedAgain).toBe(scoped);
  });

  it("can load a scoped registry without replacing the active global registry", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "allowed",
      filename: "allowed.cjs",
      body: `module.exports = { id: "allowed", register() {} };`,
    });
    const previousRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(previousRegistry, "existing-registry");
    resetGlobalHookRunner();

    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["allowed"],
        },
      },
      onlyPluginIds: ["allowed"],
    });

    expect(scoped.plugins.map((entry) => entry.id)).toEqual(["allowed"]);
    expect(getActivePluginRegistry()).toBe(previousRegistry);
    expect(getActivePluginRegistryKey()).toBe("existing-registry");
    expect(getGlobalHookRunner()).toBeNull();
  });

  it("only publishes plugin commands to the global registry during activating loads", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "command-plugin",
      filename: "command-plugin.cjs",
      body: `module.exports = {
        id: "command-plugin",
        register(api) {
          api.registerCommand({
            name: "pair",
            description: "Pair device",
            acceptsArgs: true,
            handler: async ({ args }) => ({ text: \`paired:\${args ?? ""}\` }),
          });
        },
      };`,
    });
    const { clearPluginCommands, getPluginCommandSpecs } = await import("./commands.js");

    clearPluginCommands();

    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["command-plugin"],
        },
      },
      onlyPluginIds: ["command-plugin"],
    });

    expect(scoped.plugins.find((entry) => entry.id === "command-plugin")?.status).toBe("loaded");
    expect(scoped.commands.map((entry) => entry.command.name)).toEqual(["pair"]);
    expect(getPluginCommandSpecs("telegram")).toEqual([]);

    const active = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["command-plugin"],
        },
      },
      onlyPluginIds: ["command-plugin"],
    });

    expect(active.plugins.find((entry) => entry.id === "command-plugin")?.status).toBe("loaded");
    expect(getPluginCommandSpecs("telegram")).toEqual([
      {
        name: "pair",
        description: "Pair device",
        acceptsArgs: true,
      },
    ]);

    clearPluginCommands();
  });

  it("throws when activate:false is used without cache:false", () => {
    expect(() => loadOpenClawPlugins({ activate: false })).toThrow(
      "activate:false requires cache:false",
    );
    expect(() => loadOpenClawPlugins({ activate: false, cache: true })).toThrow(
      "activate:false requires cache:false",
    );
  });

  it("re-initializes global hook runner when serving registry from cache", () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "cache-hook-runner",
      filename: "cache-hook-runner.cjs",
      body: `module.exports = { id: "cache-hook-runner", register() {} };`,
    });

    const options = {
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["cache-hook-runner"],
        },
      },
    };

    const first = loadOpenClawPlugins(options);
    expect(getGlobalHookRunner()).not.toBeNull();

    resetGlobalHookRunner();
    expect(getGlobalHookRunner()).toBeNull();

    const second = loadOpenClawPlugins(options);
    expect(second).toBe(first);
    expect(getGlobalHookRunner()).not.toBeNull();

    resetGlobalHookRunner();
  });

  it.each([
    {
      name: "does not reuse cached bundled plugin registries across env changes",
      pluginId: "cache-root",
      setup: () => {
        const bundledA = makeTempDir();
        const bundledB = makeTempDir();
        const pluginA = writePlugin({
          id: "cache-root",
          dir: path.join(bundledA, "cache-root"),
          filename: "index.cjs",
          body: `module.exports = { id: "cache-root", register() {} };`,
        });
        const pluginB = writePlugin({
          id: "cache-root",
          dir: path.join(bundledB, "cache-root"),
          filename: "index.cjs",
          body: `module.exports = { id: "cache-root", register() {} };`,
        });

        const options = {
          config: {
            plugins: {
              allow: ["cache-root"],
              entries: {
                "cache-root": { enabled: true },
              },
            },
          },
        };

        return {
          expectedFirstSource: pluginA.file,
          expectedSecondSource: pluginB.file,
          loadFirst: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledA,
              },
            }),
          loadSecond: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledB,
              },
            }),
        };
      },
    },
    {
      name: "does not reuse cached load-path plugin registries across env home changes",
      pluginId: "demo",
      setup: () => {
        const homeA = makeTempDir();
        const homeB = makeTempDir();
        const stateDir = makeTempDir();
        const bundledDir = makeTempDir();
        const pluginA = writePlugin({
          id: "demo",
          dir: path.join(homeA, "plugins", "demo"),
          filename: "index.cjs",
          body: `module.exports = { id: "demo", register() {} };`,
        });
        const pluginB = writePlugin({
          id: "demo",
          dir: path.join(homeB, "plugins", "demo"),
          filename: "index.cjs",
          body: `module.exports = { id: "demo", register() {} };`,
        });

        const options = {
          config: {
            plugins: {
              allow: ["demo"],
              entries: {
                demo: { enabled: true },
              },
              load: {
                paths: ["~/plugins/demo"],
              },
            },
          },
        };

        return {
          expectedFirstSource: pluginA.file,
          expectedSecondSource: pluginB.file,
          loadFirst: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                HOME: homeA,
                OPENCLAW_HOME: undefined,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
              },
            }),
          loadSecond: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                HOME: homeB,
                OPENCLAW_HOME: undefined,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
              },
            }),
        };
      },
    },
  ])("$name", ({ pluginId, setup }) => {
    const { expectedFirstSource, expectedSecondSource, loadFirst, loadSecond } = setup();
    expectCachePartitionByPluginSource({
      pluginId,
      loadFirst,
      loadSecond,
      expectedFirstSource,
      expectedSecondSource,
    });
  });

  it("does not reuse cached registries when env-resolved install paths change", () => {
    useNoBundledPlugins();
    const openclawHome = makeTempDir();
    const ignoredHome = makeTempDir();
    const stateDir = makeTempDir();
    const pluginDir = path.join(openclawHome, "plugins", "tracked-install-cache");
    mkdirSafe(pluginDir);
    const plugin = writePlugin({
      id: "tracked-install-cache",
      dir: pluginDir,
      filename: "index.cjs",
      body: `module.exports = { id: "tracked-install-cache", register() {} };`,
    });

    const options = {
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["tracked-install-cache"],
          installs: {
            "tracked-install-cache": {
              source: "path" as const,
              installPath: "~/plugins/tracked-install-cache",
              sourcePath: "~/plugins/tracked-install-cache",
            },
          },
        },
      },
    };

    const secondHome = makeTempDir();
    const secondOptions = {
      ...options,
      env: {
        ...process.env,
        OPENCLAW_HOME: secondHome,
        HOME: ignoredHome,
        OPENCLAW_STATE_DIR: stateDir,
        CLAWDBOT_STATE_DIR: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
      },
    };
    expectCacheMissThenHit({
      loadFirst: () =>
        loadOpenClawPlugins({
          ...options,
          env: {
            ...process.env,
            OPENCLAW_HOME: openclawHome,
            HOME: ignoredHome,
            OPENCLAW_STATE_DIR: stateDir,
            CLAWDBOT_STATE_DIR: undefined,
            OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
          },
        }),
      loadVariant: () => loadOpenClawPlugins(secondOptions),
    });
  });

  it("does not reuse cached registries across gateway subagent binding modes", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "cache-gateway-bindable",
      filename: "cache-gateway-bindable.cjs",
      body: `module.exports = { id: "cache-gateway-bindable", register() {} };`,
    });

    const options = {
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          allow: ["cache-gateway-bindable"],
          load: {
            paths: [plugin.file],
          },
        },
      },
    };

    expectCacheMissThenHit({
      loadFirst: () => loadOpenClawPlugins(options),
      loadVariant: () =>
        loadOpenClawPlugins({
          ...options,
          runtimeOptions: {
            allowGatewaySubagentBinding: true,
          },
        }),
    });
  });

  it("evicts least recently used registries when the loader cache exceeds its cap", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "cache-eviction",
      filename: "cache-eviction.cjs",
      body: `module.exports = { id: "cache-eviction", register() {} };`,
    });
    const stateDirs = Array.from({ length: __testing.maxPluginRegistryCacheEntries + 1 }, () =>
      makeTempDir(),
    );

    const loadWithStateDir = (stateDir: string) =>
      loadOpenClawPlugins({
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
        },
        config: {
          plugins: {
            allow: ["cache-eviction"],
            load: {
              paths: [plugin.file],
            },
          },
        },
      });

    const first = loadWithStateDir(stateDirs[0] ?? makeTempDir());
    const second = loadWithStateDir(stateDirs[1] ?? makeTempDir());

    expect(loadWithStateDir(stateDirs[0] ?? makeTempDir())).toBe(first);

    for (const stateDir of stateDirs.slice(2)) {
      loadWithStateDir(stateDir);
    }

    expect(loadWithStateDir(stateDirs[0] ?? makeTempDir())).toBe(first);
    expect(loadWithStateDir(stateDirs[1] ?? makeTempDir())).not.toBe(second);
  });

  it("normalizes bundled plugin env overrides against the provided env", () => {
    const bundledDir = makeTempDir();
    const homeDir = path.dirname(bundledDir);
    const override = `~/${path.basename(bundledDir)}`;
    const plugin = writePlugin({
      id: "tilde-bundled",
      dir: path.join(bundledDir, "tilde-bundled"),
      filename: "index.cjs",
      body: `module.exports = { id: "tilde-bundled", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      env: {
        ...process.env,
        HOME: homeDir,
        OPENCLAW_HOME: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: override,
      },
      config: {
        plugins: {
          allow: ["tilde-bundled"],
          entries: {
            "tilde-bundled": { enabled: true },
          },
        },
      },
    });

    expect(
      fs.realpathSync(registry.plugins.find((entry) => entry.id === "tilde-bundled")?.source ?? ""),
    ).toBe(fs.realpathSync(plugin.file));
  });

  it("prefers OPENCLAW_HOME over HOME for env-expanded load paths", () => {
    const ignoredHome = makeTempDir();
    const openclawHome = makeTempDir();
    const stateDir = makeTempDir();
    const bundledDir = makeTempDir();
    const plugin = writePlugin({
      id: "openclaw-home-demo",
      dir: path.join(openclawHome, "plugins", "openclaw-home-demo"),
      filename: "index.cjs",
      body: `module.exports = { id: "openclaw-home-demo", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      env: {
        ...process.env,
        HOME: ignoredHome,
        OPENCLAW_HOME: openclawHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      },
      config: {
        plugins: {
          allow: ["openclaw-home-demo"],
          entries: {
            "openclaw-home-demo": { enabled: true },
          },
          load: {
            paths: ["~/plugins/openclaw-home-demo"],
          },
        },
      },
    });

    expect(
      fs.realpathSync(
        registry.plugins.find((entry) => entry.id === "openclaw-home-demo")?.source ?? "",
      ),
    ).toBe(fs.realpathSync(plugin.file));
  });

  it("loads plugins when source and root differ only by realpath alias", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "alias-safe",
      filename: "alias-safe.cjs",
      body: `module.exports = { id: "alias-safe", register() {} };`,
    });
    const realRoot = fs.realpathSync(plugin.dir);
    if (realRoot === plugin.dir) {
      return;
    }

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["alias-safe"],
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "alias-safe");
    expect(loaded?.status).toBe("loaded");
  });

  it("denylist disables plugins even if allowed", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "blocked",
      body: `module.exports = { id: "blocked", register() {} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["blocked"],
        deny: ["blocked"],
      },
    });

    const blocked = registry.plugins.find((entry) => entry.id === "blocked");
    expect(blocked?.status).toBe("disabled");
  });

  it("fails fast on invalid plugin config", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "configurable",
      filename: "configurable.cjs",
      body: `module.exports = { id: "configurable", register() {} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        entries: {
          configurable: {
            config: "nope" as unknown as Record<string, unknown>,
          },
        },
      },
    });

    const configurable = registry.plugins.find((entry) => entry.id === "configurable");
    expect(configurable?.status).toBe("error");
    expect(registry.diagnostics.some((d) => d.level === "error")).toBe(true);
  });

  it("fails when plugin export id mismatches manifest id", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "manifest-id",
      filename: "manifest-id.cjs",
      body: `module.exports = { id: "export-id", register() {} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["manifest-id"],
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "manifest-id");
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).toBe(
      'plugin id mismatch (config uses "manifest-id", export uses "export-id")',
    );
    expect(
      registry.diagnostics.some(
        (entry) =>
          entry.level === "error" &&
          entry.pluginId === "manifest-id" &&
          entry.message ===
            'plugin id mismatch (config uses "manifest-id", export uses "export-id")',
      ),
    ).toBe(true);
  });

  it("registers channel plugins", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "channel-demo",
      filename: "channel-demo.cjs",
      body: `module.exports = { id: "channel-demo", register(api) {
  api.registerChannel({
    plugin: {
      id: "demo",
      meta: {
        id: "demo",
        label: "Demo",
        selectionLabel: "Demo",
        docsPath: "/channels/demo",
        blurb: "demo channel"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["channel-demo"],
      },
    });

    const channel = registry.channels.find((entry) => entry.plugin.id === "demo");
    expect(channel).toBeDefined();
  });

  it("rejects duplicate channel ids during plugin registration", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "channel-dup",
      filename: "channel-dup.cjs",
      body: `module.exports = { id: "channel-dup", register(api) {
  api.registerChannel({
    plugin: {
      id: "demo",
      meta: {
        id: "demo",
        label: "Demo Override",
        selectionLabel: "Demo Override",
        docsPath: "/channels/demo-override",
        blurb: "override"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
  api.registerChannel({
    plugin: {
      id: "demo",
      meta: {
        id: "demo",
        label: "Demo Duplicate",
        selectionLabel: "Demo Duplicate",
        docsPath: "/channels/demo-duplicate",
        blurb: "duplicate"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["channel-dup"],
      },
    });

    expect(registry.channels.filter((entry) => entry.plugin.id === "demo")).toHaveLength(1);
    expect(
      registry.diagnostics.some(
        (entry) =>
          entry.level === "error" &&
          entry.pluginId === "channel-dup" &&
          entry.message === "channel already registered: demo (channel-dup)",
      ),
    ).toBe(true);
  });

  it("registers http routes with auth and match options", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "http-demo",
      filename: "http-demo.cjs",
      body: `module.exports = { id: "http-demo", register(api) {
  api.registerHttpRoute({
    path: "/webhook",
    auth: "plugin",
    match: "prefix",
    handler: async () => false
  });
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["http-demo"],
      },
    });

    const route = registry.httpRoutes.find((entry) => entry.pluginId === "http-demo");
    expect(route).toBeDefined();
    expect(route?.path).toBe("/webhook");
    expect(route?.auth).toBe("plugin");
    expect(route?.match).toBe("prefix");
    const httpPlugin = registry.plugins.find((entry) => entry.id === "http-demo");
    expect(httpPlugin?.httpRoutes).toBe(1);
  });

  it("rejects duplicate plugin-visible hook names", () => {
    useNoBundledPlugins();
    const first = writePlugin({
      id: "hook-owner-a",
      filename: "hook-owner-a.cjs",
      body: `module.exports = { id: "hook-owner-a", register(api) {
  api.registerHook("gateway:startup", () => {}, { name: "shared-hook" });
} };`,
    });
    const second = writePlugin({
      id: "hook-owner-b",
      filename: "hook-owner-b.cjs",
      body: `module.exports = { id: "hook-owner-b", register(api) {
  api.registerHook("gateway:startup", () => {}, { name: "shared-hook" });
} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [first.file, second.file] },
          allow: ["hook-owner-a", "hook-owner-b"],
        },
      },
    });

    expect(registry.hooks.filter((entry) => entry.entry.hook.name === "shared-hook")).toHaveLength(
      1,
    );
    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.level === "error" &&
          diag.pluginId === "hook-owner-b" &&
          diag.message === "hook already registered: shared-hook (hook-owner-a)",
      ),
    ).toBe(true);
  });

  it("rejects duplicate plugin service ids", () => {
    useNoBundledPlugins();
    const first = writePlugin({
      id: "service-owner-a",
      filename: "service-owner-a.cjs",
      body: `module.exports = { id: "service-owner-a", register(api) {
  api.registerService({ id: "shared-service", start() {} });
} };`,
    });
    const second = writePlugin({
      id: "service-owner-b",
      filename: "service-owner-b.cjs",
      body: `module.exports = { id: "service-owner-b", register(api) {
  api.registerService({ id: "shared-service", start() {} });
} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [first.file, second.file] },
          allow: ["service-owner-a", "service-owner-b"],
        },
      },
    });

    expect(registry.services.filter((entry) => entry.service.id === "shared-service")).toHaveLength(
      1,
    );
    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.level === "error" &&
          diag.pluginId === "service-owner-b" &&
          diag.message === "service already registered: shared-service (service-owner-a)",
      ),
    ).toBe(true);
  });

  it("rejects plugin context engine ids reserved by core", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "context-engine-core-collision",
      filename: "context-engine-core-collision.cjs",
      body: `module.exports = { id: "context-engine-core-collision", register(api) {
  api.registerContextEngine("legacy", () => ({}));
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["context-engine-core-collision"],
      },
    });

    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.level === "error" &&
          diag.pluginId === "context-engine-core-collision" &&
          diag.message === "context engine id reserved by core: legacy",
      ),
    ).toBe(true);
  });

  it("rejects duplicate plugin context engine ids", () => {
    useNoBundledPlugins();
    const first = writePlugin({
      id: "context-engine-owner-a",
      filename: "context-engine-owner-a.cjs",
      body: `module.exports = { id: "context-engine-owner-a", register(api) {
  api.registerContextEngine("shared-context-engine-loader-test", () => ({}));
} };`,
    });
    const second = writePlugin({
      id: "context-engine-owner-b",
      filename: "context-engine-owner-b.cjs",
      body: `module.exports = { id: "context-engine-owner-b", register(api) {
  api.registerContextEngine("shared-context-engine-loader-test", () => ({}));
} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [first.file, second.file] },
          allow: ["context-engine-owner-a", "context-engine-owner-b"],
        },
      },
    });

    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.level === "error" &&
          diag.pluginId === "context-engine-owner-b" &&
          diag.message ===
            "context engine already registered: shared-context-engine-loader-test (plugin:context-engine-owner-a)",
      ),
    ).toBe(true);
  });

  it("requires plugin CLI registrars to declare explicit command roots", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "cli-missing-metadata",
      filename: "cli-missing-metadata.cjs",
      body: `module.exports = { id: "cli-missing-metadata", register(api) {
  api.registerCli(() => {});
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["cli-missing-metadata"],
      },
    });

    expect(registry.cliRegistrars).toHaveLength(0);
    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.level === "error" &&
          diag.pluginId === "cli-missing-metadata" &&
          diag.message === "cli registration missing explicit commands metadata",
      ),
    ).toBe(true);
  });

  it("rejects duplicate plugin CLI command roots", () => {
    useNoBundledPlugins();
    const first = writePlugin({
      id: "cli-owner-a",
      filename: "cli-owner-a.cjs",
      body: `module.exports = { id: "cli-owner-a", register(api) {
  api.registerCli(() => {}, { commands: ["shared-cli"] });
} };`,
    });
    const second = writePlugin({
      id: "cli-owner-b",
      filename: "cli-owner-b.cjs",
      body: `module.exports = { id: "cli-owner-b", register(api) {
  api.registerCli(() => {}, { commands: ["shared-cli"] });
} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [first.file, second.file] },
          allow: ["cli-owner-a", "cli-owner-b"],
        },
      },
    });

    expect(registry.cliRegistrars).toHaveLength(1);
    expect(registry.cliRegistrars[0]?.pluginId).toBe("cli-owner-a");
    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.level === "error" &&
          diag.pluginId === "cli-owner-b" &&
          diag.message === "cli command already registered: shared-cli (cli-owner-a)",
      ),
    ).toBe(true);
  });

  it("registers http routes", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "http-route-demo",
      filename: "http-route-demo.cjs",
      body: `module.exports = { id: "http-route-demo", register(api) {
  api.registerHttpRoute({ path: "/demo", auth: "gateway", handler: async (_req, res) => { res.statusCode = 200; res.end("ok"); } });
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["http-route-demo"],
      },
    });

    const route = registry.httpRoutes.find((entry) => entry.pluginId === "http-route-demo");
    expect(route).toBeDefined();
    expect(route?.path).toBe("/demo");
    expect(route?.auth).toBe("gateway");
    expect(route?.match).toBe("exact");
    const httpPlugin = registry.plugins.find((entry) => entry.id === "http-route-demo");
    expect(httpPlugin?.httpRoutes).toBe(1);
  });

  it("rewrites removed registerHttpHandler failures into migration diagnostics", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "http-handler-legacy",
      filename: "http-handler-legacy.cjs",
      body: `module.exports = { id: "http-handler-legacy", register(api) {
  api.registerHttpHandler({ path: "/legacy", handler: async () => true });
} };`,
    });

    const errors: string[] = [];
    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["http-handler-legacy"],
      },
      options: {
        logger: createErrorLogger(errors),
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "http-handler-legacy");
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).toContain("api.registerHttpHandler(...) was removed");
    expect(loaded?.error).toContain("api.registerHttpRoute(...)");
    expect(loaded?.error).toContain("registerPluginHttpRoute(...)");
    expect(
      registry.diagnostics.some((diag) =>
        String(diag.message).includes("api.registerHttpHandler(...) was removed"),
      ),
    ).toBe(true);
    expect(errors.some((entry) => entry.includes("api.registerHttpHandler(...) was removed"))).toBe(
      true,
    );
  });

  it("does not rewrite unrelated registerHttpHandler helper failures", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "http-handler-local-helper",
      filename: "http-handler-local-helper.cjs",
      body: `module.exports = { id: "http-handler-local-helper", register() {
  const registerHttpHandler = undefined;
  registerHttpHandler();
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["http-handler-local-helper"],
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "http-handler-local-helper");
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).not.toContain("api.registerHttpHandler(...) was removed");
  });

  it("rejects plugin http routes missing explicit auth", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "http-route-missing-auth",
      filename: "http-route-missing-auth.cjs",
      body: `module.exports = { id: "http-route-missing-auth", register(api) {
  api.registerHttpRoute({ path: "/demo", handler: async () => true });
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["http-route-missing-auth"],
      },
    });

    expect(registry.httpRoutes.find((entry) => entry.pluginId === "http-route-missing-auth")).toBe(
      undefined,
    );
    expect(
      registry.diagnostics.some((diag) =>
        String(diag.message).includes("http route registration missing or invalid auth"),
      ),
    ).toBe(true);
  });

  it("allows explicit replaceExisting for same-plugin http route overrides", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "http-route-replace-self",
      filename: "http-route-replace-self.cjs",
      body: `module.exports = { id: "http-route-replace-self", register(api) {
  api.registerHttpRoute({ path: "/demo", auth: "plugin", handler: async () => false });
  api.registerHttpRoute({ path: "/demo", auth: "plugin", replaceExisting: true, handler: async () => true });
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["http-route-replace-self"],
      },
    });

    const routes = registry.httpRoutes.filter(
      (entry) => entry.pluginId === "http-route-replace-self",
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe("/demo");
    expect(registry.diagnostics).toEqual([]);
  });

  it("rejects http route replacement when another plugin owns the route", () => {
    useNoBundledPlugins();
    const first = writePlugin({
      id: "http-route-owner-a",
      filename: "http-route-owner-a.cjs",
      body: `module.exports = { id: "http-route-owner-a", register(api) {
  api.registerHttpRoute({ path: "/demo", auth: "plugin", handler: async () => false });
} };`,
    });
    const second = writePlugin({
      id: "http-route-owner-b",
      filename: "http-route-owner-b.cjs",
      body: `module.exports = { id: "http-route-owner-b", register(api) {
  api.registerHttpRoute({ path: "/demo", auth: "plugin", replaceExisting: true, handler: async () => true });
} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [first.file, second.file] },
          allow: ["http-route-owner-a", "http-route-owner-b"],
        },
      },
    });

    const route = registry.httpRoutes.find((entry) => entry.path === "/demo");
    expect(route?.pluginId).toBe("http-route-owner-a");
    expect(
      registry.diagnostics.some((diag) =>
        String(diag.message).includes("http route replacement rejected"),
      ),
    ).toBe(true);
  });

  it("rejects mixed-auth overlapping http routes", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "http-route-overlap",
      filename: "http-route-overlap.cjs",
      body: `module.exports = { id: "http-route-overlap", register(api) {
  api.registerHttpRoute({ path: "/plugin/secure", auth: "gateway", match: "prefix", handler: async () => true });
  api.registerHttpRoute({ path: "/plugin/secure/report", auth: "plugin", match: "exact", handler: async () => true });
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["http-route-overlap"],
      },
    });

    const routes = registry.httpRoutes.filter((entry) => entry.pluginId === "http-route-overlap");
    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe("/plugin/secure");
    expect(
      registry.diagnostics.some((diag) =>
        String(diag.message).includes("http route overlap rejected"),
      ),
    ).toBe(true);
  });

  it("allows same-auth overlapping http routes", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "http-route-overlap-same-auth",
      filename: "http-route-overlap-same-auth.cjs",
      body: `module.exports = { id: "http-route-overlap-same-auth", register(api) {
  api.registerHttpRoute({ path: "/plugin/public", auth: "plugin", match: "prefix", handler: async () => true });
  api.registerHttpRoute({ path: "/plugin/public/report", auth: "plugin", match: "exact", handler: async () => true });
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["http-route-overlap-same-auth"],
      },
    });

    const routes = registry.httpRoutes.filter(
      (entry) => entry.pluginId === "http-route-overlap-same-auth",
    );
    expect(routes).toHaveLength(2);
    expect(registry.diagnostics).toEqual([]);
  });

  it("respects explicit disable in config", () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "config-disable",
      body: `module.exports = { id: "config-disable", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          entries: {
            "config-disable": { enabled: false },
          },
        },
      },
    });

    const disabled = registry.plugins.find((entry) => entry.id === "config-disable");
    expect(disabled?.status).toBe("disabled");
  });

  it("skips disabled channel imports unless setup-only loading is explicitly enabled", () => {
    useNoBundledPlugins();
    const marker = path.join(makeTempDir(), "lazy-channel-imported.txt");
    const plugin = writePlugin({
      id: "lazy-channel",
      filename: "lazy-channel.cjs",
      body: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded", "utf-8");
module.exports = {
  id: "lazy-channel",
  register(api) {
    api.registerChannel({
      plugin: {
        id: "lazy-channel",
        meta: {
          id: "lazy-channel",
          label: "Lazy Channel",
          selectionLabel: "Lazy Channel",
          docsPath: "/channels/lazy-channel",
          blurb: "lazy test channel",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
};`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "lazy-channel",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["lazy-channel"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const config = {
      plugins: {
        load: { paths: [plugin.file] },
        allow: ["lazy-channel"],
        entries: {
          "lazy-channel": { enabled: false },
        },
      },
    };

    const registry = loadOpenClawPlugins({
      cache: false,
      config,
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(registry.channelSetups).toHaveLength(0);
    expect(registry.plugins.find((entry) => entry.id === "lazy-channel")?.status).toBe("disabled");

    const setupRegistry = loadOpenClawPlugins({
      cache: false,
      config,
      includeSetupOnlyChannelPlugins: true,
    });

    expect(fs.existsSync(marker)).toBe(true);
    expect(setupRegistry.channelSetups).toHaveLength(1);
    expect(setupRegistry.channels).toHaveLength(0);
    expect(setupRegistry.plugins.find((entry) => entry.id === "lazy-channel")?.status).toBe(
      "disabled",
    );
  });

  it("uses package setupEntry for setup-only channel loads", () => {
    useNoBundledPlugins();
    const pluginDir = makeTempDir();
    const fullMarker = path.join(pluginDir, "full-loaded.txt");
    const setupMarker = path.join(pluginDir, "setup-loaded.txt");
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/setup-entry-test",
          openclaw: {
            extensions: ["./index.cjs"],
            setupEntry: "./setup-entry.cjs",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "setup-entry-test",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["setup-entry-test"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
module.exports = {
  id: "setup-entry-test",
  register(api) {
    api.registerChannel({
      plugin: {
        id: "setup-entry-test",
        meta: {
          id: "setup-entry-test",
          label: "Setup Entry Test",
          selectionLabel: "Setup Entry Test",
          docsPath: "/channels/setup-entry-test",
          blurb: "full entry should not run in setup-only mode",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
};`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "setup-entry.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded", "utf-8");
module.exports = {
  plugin: {
    id: "setup-entry-test",
    meta: {
      id: "setup-entry-test",
      label: "Setup Entry Test",
      selectionLabel: "Setup Entry Test",
      docsPath: "/channels/setup-entry-test",
      blurb: "setup entry",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({ accountId: "default" }),
    },
    outbound: { deliveryMode: "direct" },
  },
};`,
      "utf-8",
    );

    const setupRegistry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["setup-entry-test"],
          entries: {
            "setup-entry-test": { enabled: false },
          },
        },
      },
      includeSetupOnlyChannelPlugins: true,
    });

    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
    expect(setupRegistry.channelSetups).toHaveLength(1);
    expect(setupRegistry.channels).toHaveLength(0);
  });

  it("uses package setupEntry for enabled but unconfigured channel loads", () => {
    useNoBundledPlugins();
    const pluginDir = makeTempDir();
    const fullMarker = path.join(pluginDir, "full-loaded.txt");
    const setupMarker = path.join(pluginDir, "setup-loaded.txt");
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/setup-runtime-test",
          openclaw: {
            extensions: ["./index.cjs"],
            setupEntry: "./setup-entry.cjs",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "setup-runtime-test",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["setup-runtime-test"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
module.exports = {
  id: "setup-runtime-test",
  register(api) {
    api.registerChannel({
      plugin: {
        id: "setup-runtime-test",
        meta: {
          id: "setup-runtime-test",
          label: "Setup Runtime Test",
          selectionLabel: "Setup Runtime Test",
          docsPath: "/channels/setup-runtime-test",
          blurb: "full entry should not run while unconfigured",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
};`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "setup-entry.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded", "utf-8");
module.exports = {
  plugin: {
    id: "setup-runtime-test",
    meta: {
      id: "setup-runtime-test",
      label: "Setup Runtime Test",
      selectionLabel: "Setup Runtime Test",
      docsPath: "/channels/setup-runtime-test",
      blurb: "setup runtime",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({ accountId: "default" }),
    },
    outbound: { deliveryMode: "direct" },
  },
};`,
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["setup-runtime-test"],
        },
      },
    });

    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
    expect(registry.channelSetups).toHaveLength(1);
    expect(registry.channels).toHaveLength(1);
  });

  it("can prefer setupEntry for configured channel loads during startup", () => {
    useNoBundledPlugins();
    const pluginDir = makeTempDir();
    const fullMarker = path.join(pluginDir, "full-loaded.txt");
    const setupMarker = path.join(pluginDir, "setup-loaded.txt");
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/setup-runtime-preferred-test",
          openclaw: {
            extensions: ["./index.cjs"],
            setupEntry: "./setup-entry.cjs",
            startup: {
              deferConfiguredChannelFullLoadUntilAfterListen: true,
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "setup-runtime-preferred-test",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["setup-runtime-preferred-test"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
module.exports = {
  id: "setup-runtime-preferred-test",
  register(api) {
    api.registerChannel({
      plugin: {
        id: "setup-runtime-preferred-test",
        meta: {
          id: "setup-runtime-preferred-test",
          label: "Setup Runtime Preferred Test",
          selectionLabel: "Setup Runtime Preferred Test",
          docsPath: "/channels/setup-runtime-preferred-test",
          blurb: "full entry should be deferred while startup is still cold",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ accountId: "default", token: "configured" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
};`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "setup-entry.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded", "utf-8");
module.exports = {
  plugin: {
    id: "setup-runtime-preferred-test",
    meta: {
      id: "setup-runtime-preferred-test",
      label: "Setup Runtime Preferred Test",
      selectionLabel: "Setup Runtime Preferred Test",
      docsPath: "/channels/setup-runtime-preferred-test",
      blurb: "setup runtime preferred",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ accountId: "default", token: "configured" }),
    },
    outbound: { deliveryMode: "direct" },
  },
};`,
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      preferSetupRuntimeForChannelPlugins: true,
      config: {
        channels: {
          "setup-runtime-preferred-test": {
            enabled: true,
            token: "configured",
          },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["setup-runtime-preferred-test"],
        },
      },
    });

    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
    expect(registry.channelSetups).toHaveLength(1);
    expect(registry.channels).toHaveLength(1);
  });

  it("does not prefer setupEntry for configured channel loads without startup opt-in", () => {
    useNoBundledPlugins();
    const pluginDir = makeTempDir();
    const fullMarker = path.join(makeTempDir(), "full-loaded.txt");
    const setupMarker = path.join(makeTempDir(), "setup-loaded.txt");
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/setup-runtime-not-preferred-test",
          openclaw: {
            extensions: ["./index.cjs"],
            setupEntry: "./setup-entry.cjs",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "setup-runtime-not-preferred-test",
          configSchema: EMPTY_PLUGIN_SCHEMA,
          channels: ["setup-runtime-not-preferred-test"],
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
module.exports = {
  id: "setup-runtime-not-preferred-test",
  register(api) {
    api.registerChannel({
      plugin: {
        id: "setup-runtime-not-preferred-test",
        meta: {
          id: "setup-runtime-not-preferred-test",
          label: "Setup Runtime Not Preferred Test",
          selectionLabel: "Setup Runtime Not Preferred Test",
          docsPath: "/channels/setup-runtime-not-preferred-test",
          blurb: "full entry should still load without explicit startup opt-in",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ accountId: "default", token: "configured" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
};`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "setup-entry.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded", "utf-8");
module.exports = {
  plugin: {
    id: "setup-runtime-not-preferred-test",
    meta: {
      id: "setup-runtime-not-preferred-test",
      label: "Setup Runtime Not Preferred Test",
      selectionLabel: "Setup Runtime Not Preferred Test",
      docsPath: "/channels/setup-runtime-not-preferred-test",
      blurb: "setup runtime not preferred",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ accountId: "default", token: "configured" }),
    },
    outbound: { deliveryMode: "direct" },
  },
};`,
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      preferSetupRuntimeForChannelPlugins: true,
      config: {
        channels: {
          "setup-runtime-not-preferred-test": {
            enabled: true,
            token: "configured",
          },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["setup-runtime-not-preferred-test"],
        },
      },
    });

    expect(fs.existsSync(fullMarker)).toBe(true);
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(registry.channelSetups).toHaveLength(1);
    expect(registry.channels).toHaveLength(1);
  });

  it("blocks before_prompt_build but preserves legacy model overrides when prompt injection is disabled", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "hook-policy",
      filename: "hook-policy.cjs",
      body: `module.exports = { id: "hook-policy", register(api) {
  api.on("before_prompt_build", () => ({ prependContext: "prepend" }));
  api.on("before_agent_start", () => ({
    prependContext: "legacy",
    modelOverride: "gpt-4o",
    providerOverride: "anthropic",
  }));
  api.on("before_model_resolve", () => ({ providerOverride: "openai" }));
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-policy"],
        entries: {
          "hook-policy": {
            hooks: {
              allowPromptInjection: false,
            },
          },
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "hook-policy")?.status).toBe("loaded");
    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual([
      "before_agent_start",
      "before_model_resolve",
    ]);
    const runner = createHookRunner(registry);
    const legacyResult = await runner.runBeforeAgentStart({ prompt: "hello", messages: [] }, {});
    expect(legacyResult).toEqual({
      modelOverride: "gpt-4o",
      providerOverride: "anthropic",
    });
    const blockedDiagnostics = registry.diagnostics.filter((diag) =>
      String(diag.message).includes(
        "blocked by plugins.entries.hook-policy.hooks.allowPromptInjection=false",
      ),
    );
    expect(blockedDiagnostics).toHaveLength(1);
    const constrainedDiagnostics = registry.diagnostics.filter((diag) =>
      String(diag.message).includes(
        "prompt fields constrained by plugins.entries.hook-policy.hooks.allowPromptInjection=false",
      ),
    );
    expect(constrainedDiagnostics).toHaveLength(1);
  });

  it("keeps prompt-injection typed hooks enabled by default", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "hook-policy-default",
      filename: "hook-policy-default.cjs",
      body: `module.exports = { id: "hook-policy-default", register(api) {
  api.on("before_prompt_build", () => ({ prependContext: "prepend" }));
  api.on("before_agent_start", () => ({ prependContext: "legacy" }));
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-policy-default"],
      },
    });

    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual([
      "before_prompt_build",
      "before_agent_start",
    ]);
  });

  it("ignores unknown typed hooks from plugins and keeps loading", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "hook-unknown",
      filename: "hook-unknown.cjs",
      body: `module.exports = { id: "hook-unknown", register(api) {
  api.on("totally_unknown_hook_name", () => ({ foo: "bar" }));
  api.on(123, () => ({ foo: "baz" }));
  api.on("before_model_resolve", () => ({ providerOverride: "openai" }));
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-unknown"],
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "hook-unknown")?.status).toBe("loaded");
    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual(["before_model_resolve"]);
    const unknownHookDiagnostics = registry.diagnostics.filter((diag) =>
      String(diag.message).includes('unknown typed hook "'),
    );
    expect(unknownHookDiagnostics).toHaveLength(2);
    expect(
      unknownHookDiagnostics.some((diag) =>
        String(diag.message).includes('unknown typed hook "totally_unknown_hook_name" ignored'),
      ),
    ).toBe(true);
    expect(
      unknownHookDiagnostics.some((diag) =>
        String(diag.message).includes('unknown typed hook "123" ignored'),
      ),
    ).toBe(true);
  });

  it("enforces memory slot selection", () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const memoryA = writePlugin({
      id: "memory-a",
      body: `module.exports = { id: "memory-a", kind: "memory", register() {} };`,
    });
    const memoryB = writePlugin({
      id: "memory-b",
      body: `module.exports = { id: "memory-b", kind: "memory", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [memoryA.file, memoryB.file] },
          slots: { memory: "memory-b" },
        },
      },
    });

    const a = registry.plugins.find((entry) => entry.id === "memory-a");
    const b = registry.plugins.find((entry) => entry.id === "memory-b");
    expect(b?.status).toBe("loaded");
    expect(a?.status).toBe("disabled");
  });

  it("skips importing bundled memory plugins that are disabled by memory slot", () => {
    const bundledDir = makeTempDir();
    const memoryADir = path.join(bundledDir, "memory-a");
    const memoryBDir = path.join(bundledDir, "memory-b");
    mkdirSafe(memoryADir);
    mkdirSafe(memoryBDir);
    writePlugin({
      id: "memory-a",
      dir: memoryADir,
      filename: "index.cjs",
      body: `throw new Error("memory-a should not be imported when slot selects memory-b");`,
    });
    writePlugin({
      id: "memory-b",
      dir: memoryBDir,
      filename: "index.cjs",
      body: `module.exports = { id: "memory-b", kind: "memory", register() {} };`,
    });
    fs.writeFileSync(
      path.join(memoryADir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "memory-a",
          kind: "memory",
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(memoryBDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "memory-b",
          kind: "memory",
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
        null,
        2,
      ),
      "utf-8",
    );
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["memory-a", "memory-b"],
          slots: { memory: "memory-b" },
          entries: {
            "memory-a": { enabled: true },
            "memory-b": { enabled: true },
          },
        },
      },
    });

    const a = registry.plugins.find((entry) => entry.id === "memory-a");
    const b = registry.plugins.find((entry) => entry.id === "memory-b");
    expect(a?.status).toBe("disabled");
    expect(String(a?.error ?? "")).toContain('memory slot set to "memory-b"');
    expect(b?.status).toBe("loaded");
  });

  it("disables memory plugins when slot is none", () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const memory = writePlugin({
      id: "memory-off",
      body: `module.exports = { id: "memory-off", kind: "memory", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [memory.file] },
          slots: { memory: "none" },
        },
      },
    });

    const entry = registry.plugins.find((item) => item.id === "memory-off");
    expect(entry?.status).toBe("disabled");
  });

  it("prefers higher-precedence plugins with the same id", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "shadow",
      body: `module.exports = { id: "shadow", register() {} };`,
      dir: bundledDir,
      filename: "shadow.cjs",
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const override = writePlugin({
      id: "shadow",
      body: `module.exports = { id: "shadow", register() {} };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [override.file] },
          entries: {
            shadow: { enabled: true },
          },
        },
      },
    });

    const entries = registry.plugins.filter((entry) => entry.id === "shadow");
    const loaded = entries.find((entry) => entry.status === "loaded");
    const overridden = entries.find((entry) => entry.status === "disabled");
    expect(loaded?.origin).toBe("config");
    expect(overridden?.origin).toBe("bundled");
  });

  it("prefers bundled plugin over auto-discovered global duplicate ids", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "feishu",
      body: `module.exports = { id: "feishu", register() {} };`,
      dir: bundledDir,
      filename: "index.cjs",
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const stateDir = makeTempDir();
    withEnv({ OPENCLAW_STATE_DIR: stateDir, CLAWDBOT_STATE_DIR: undefined }, () => {
      const globalDir = path.join(stateDir, "extensions", "feishu");
      mkdirSafe(globalDir);
      writePlugin({
        id: "feishu",
        body: `module.exports = { id: "feishu", register() {} };`,
        dir: globalDir,
        filename: "index.cjs",
      });

      const registry = loadOpenClawPlugins({
        cache: false,
        config: {
          plugins: {
            allow: ["feishu"],
            entries: {
              feishu: { enabled: true },
            },
          },
        },
      });

      const entries = registry.plugins.filter((entry) => entry.id === "feishu");
      const loaded = entries.find((entry) => entry.status === "loaded");
      const overridden = entries.find((entry) => entry.status === "disabled");
      expect(loaded?.origin).toBe("bundled");
      expect(overridden?.origin).toBe("global");
      expect(overridden?.error).toContain("overridden by bundled plugin");
    });
  });

  it("prefers an explicitly installed global plugin over a bundled duplicate", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "zalouser",
      body: `module.exports = { id: "zalouser", register() {} };`,
      dir: bundledDir,
      filename: "index.cjs",
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const stateDir = makeTempDir();
    withEnv({ OPENCLAW_STATE_DIR: stateDir, CLAWDBOT_STATE_DIR: undefined }, () => {
      const globalDir = path.join(stateDir, "extensions", "zalouser");
      mkdirSafe(globalDir);
      writePlugin({
        id: "zalouser",
        body: `module.exports = { id: "zalouser", register() {} };`,
        dir: globalDir,
        filename: "index.cjs",
      });

      const registry = loadOpenClawPlugins({
        cache: false,
        config: {
          plugins: {
            allow: ["zalouser"],
            installs: {
              zalouser: {
                source: "npm",
                installPath: globalDir,
              },
            },
            entries: {
              zalouser: { enabled: true },
            },
          },
        },
      });

      const entries = registry.plugins.filter((entry) => entry.id === "zalouser");
      const loaded = entries.find((entry) => entry.status === "loaded");
      const overridden = entries.find((entry) => entry.status === "disabled");
      expect(loaded?.origin).toBe("global");
      expect(overridden?.origin).toBe("bundled");
      expect(overridden?.error).toContain("overridden by global plugin");
    });
  });

  it("warns when plugins.allow is empty and non-bundled plugins are discoverable", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "warn-open-allow",
      body: `module.exports = { id: "warn-open-allow", register() {} };`,
    });
    const warnings: string[] = [];
    loadOpenClawPlugins({
      cache: false,
      logger: createWarningLogger(warnings),
      config: {
        plugins: {
          load: { paths: [plugin.file] },
        },
      },
    });
    expect(
      warnings.some((msg) => msg.includes("plugins.allow is empty") && msg.includes(plugin.id)),
    ).toBe(true);
  });

  it("dedupes the open allowlist warning for repeated loads of the same plugin set", () => {
    useNoBundledPlugins();
    clearPluginLoaderCache();
    const plugin = writePlugin({
      id: "warn-open-allow-once",
      body: `module.exports = { id: "warn-open-allow-once", register() {} };`,
    });
    const warnings: string[] = [];
    const options = {
      cache: false,
      logger: createWarningLogger(warnings),
      config: {
        plugins: {
          load: { paths: [plugin.file] },
        },
      },
    };

    loadOpenClawPlugins(options);
    loadOpenClawPlugins(options);

    expect(warnings.filter((msg) => msg.includes("plugins.allow is empty"))).toHaveLength(1);
  });

  it("does not auto-load workspace-discovered plugins unless explicitly trusted", () => {
    useNoBundledPlugins();
    const workspaceDir = makeTempDir();
    const workspaceExtDir = path.join(workspaceDir, ".openclaw", "extensions", "workspace-helper");
    mkdirSafe(workspaceExtDir);
    writePlugin({
      id: "workspace-helper",
      body: `module.exports = { id: "workspace-helper", register() {} };`,
      dir: workspaceExtDir,
      filename: "index.cjs",
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir,
      config: {
        plugins: {
          enabled: true,
        },
      },
    });

    const workspacePlugin = registry.plugins.find((entry) => entry.id === "workspace-helper");
    expect(workspacePlugin?.origin).toBe("workspace");
    expect(workspacePlugin?.status).toBe("disabled");
    expect(workspacePlugin?.error).toContain("workspace plugin (disabled by default)");
  });

  it("loads workspace-discovered plugins when plugins.allow explicitly trusts them", () => {
    useNoBundledPlugins();
    const workspaceDir = makeTempDir();
    const workspaceExtDir = path.join(workspaceDir, ".openclaw", "extensions", "workspace-helper");
    mkdirSafe(workspaceExtDir);
    writePlugin({
      id: "workspace-helper",
      body: `module.exports = { id: "workspace-helper", register() {} };`,
      dir: workspaceExtDir,
      filename: "index.cjs",
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir,
      config: {
        plugins: {
          enabled: true,
          allow: ["workspace-helper"],
        },
      },
    });

    const workspacePlugin = registry.plugins.find((entry) => entry.id === "workspace-helper");
    expect(workspacePlugin?.origin).toBe("workspace");
    expect(workspacePlugin?.status).toBe("loaded");
  });

  it("keeps scoped and unscoped plugin ids distinct", () => {
    useNoBundledPlugins();
    const scoped = writePlugin({
      id: "@team/shadowed",
      body: `module.exports = { id: "@team/shadowed", register() {} };`,
      filename: "scoped.cjs",
    });
    const unscoped = writePlugin({
      id: "shadowed",
      body: `module.exports = { id: "shadowed", register() {} };`,
      filename: "unscoped.cjs",
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [scoped.file, unscoped.file] },
          allow: ["@team/shadowed", "shadowed"],
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "@team/shadowed")?.status).toBe("loaded");
    expect(registry.plugins.find((entry) => entry.id === "shadowed")?.status).toBe("loaded");
    expect(
      registry.diagnostics.some((diag) => String(diag.message).includes("duplicate plugin id")),
    ).toBe(false);
  });

  it("keeps bundled plugins ahead of trusted workspace duplicates with the same id", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "shadowed",
      body: `module.exports = { id: "shadowed", register() {} };`,
      dir: bundledDir,
      filename: "index.cjs",
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const workspaceDir = makeTempDir();
    const workspaceExtDir = path.join(workspaceDir, ".openclaw", "extensions", "shadowed");
    mkdirSafe(workspaceExtDir);
    writePlugin({
      id: "shadowed",
      body: `module.exports = { id: "shadowed", register() {} };`,
      dir: workspaceExtDir,
      filename: "index.cjs",
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir,
      config: {
        plugins: {
          enabled: true,
          allow: ["shadowed"],
          entries: {
            shadowed: { enabled: true },
          },
        },
      },
    });

    const entries = registry.plugins.filter((entry) => entry.id === "shadowed");
    const loaded = entries.find((entry) => entry.status === "loaded");
    const overridden = entries.find((entry) => entry.status === "disabled");
    expect(loaded?.origin).toBe("bundled");
    expect(overridden?.origin).toBe("workspace");
    expect(overridden?.error).toContain("overridden by bundled plugin");
  });

  it("warns when loaded non-bundled plugin has no install/load-path provenance", () => {
    useNoBundledPlugins();
    const stateDir = makeTempDir();
    withEnv({ OPENCLAW_STATE_DIR: stateDir, CLAWDBOT_STATE_DIR: undefined }, () => {
      const globalDir = path.join(stateDir, "extensions", "rogue");
      mkdirSafe(globalDir);
      writePlugin({
        id: "rogue",
        body: `module.exports = { id: "rogue", register() {} };`,
        dir: globalDir,
        filename: "index.cjs",
      });

      const warnings: string[] = [];
      const registry = loadOpenClawPlugins({
        cache: false,
        logger: createWarningLogger(warnings),
        config: {
          plugins: {
            allow: ["rogue"],
          },
        },
      });

      const rogue = registry.plugins.find((entry) => entry.id === "rogue");
      expect(rogue?.status).toBe("loaded");
      expect(
        warnings.some(
          (msg) =>
            msg.includes("rogue") && msg.includes("loaded without install/load-path provenance"),
        ),
      ).toBe(true);
    });
  });

  it("does not warn about missing provenance for env-resolved load paths", () => {
    useNoBundledPlugins();
    const openclawHome = makeTempDir();
    const ignoredHome = makeTempDir();
    const stateDir = makeTempDir();
    const pluginDir = path.join(openclawHome, "plugins", "tracked-load-path");
    mkdirSafe(pluginDir);
    const plugin = writePlugin({
      id: "tracked-load-path",
      dir: pluginDir,
      filename: "index.cjs",
      body: `module.exports = { id: "tracked-load-path", register() {} };`,
    });

    const warnings: string[] = [];
    const registry = loadOpenClawPlugins({
      cache: false,
      logger: createWarningLogger(warnings),
      env: {
        ...process.env,
        OPENCLAW_HOME: openclawHome,
        HOME: ignoredHome,
        OPENCLAW_STATE_DIR: stateDir,
        CLAWDBOT_STATE_DIR: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
      },
      config: {
        plugins: {
          load: { paths: ["~/plugins/tracked-load-path"] },
          allow: ["tracked-load-path"],
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "tracked-load-path")?.source).toBe(
      plugin.file,
    );
    expect(
      warnings.some((msg) => msg.includes("loaded without install/load-path provenance")),
    ).toBe(false);
  });

  it("does not warn about missing provenance for env-resolved install paths", () => {
    useNoBundledPlugins();
    const openclawHome = makeTempDir();
    const ignoredHome = makeTempDir();
    const stateDir = makeTempDir();
    const pluginDir = path.join(openclawHome, "plugins", "tracked-install-path");
    mkdirSafe(pluginDir);
    const plugin = writePlugin({
      id: "tracked-install-path",
      dir: pluginDir,
      filename: "index.cjs",
      body: `module.exports = { id: "tracked-install-path", register() {} };`,
    });

    const warnings: string[] = [];
    const registry = loadOpenClawPlugins({
      cache: false,
      logger: createWarningLogger(warnings),
      env: {
        ...process.env,
        OPENCLAW_HOME: openclawHome,
        HOME: ignoredHome,
        OPENCLAW_STATE_DIR: stateDir,
        CLAWDBOT_STATE_DIR: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
      },
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["tracked-install-path"],
          installs: {
            "tracked-install-path": {
              source: "path",
              installPath: "~/plugins/tracked-install-path",
              sourcePath: "~/plugins/tracked-install-path",
            },
          },
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "tracked-install-path")?.source).toBe(
      plugin.file,
    );
    expect(
      warnings.some((msg) => msg.includes("loaded without install/load-path provenance")),
    ).toBe(false);
  });

  it("rejects plugin entry files that escape plugin root via symlink", () => {
    useNoBundledPlugins();
    const { outsideEntry, linkedEntry } = createEscapingEntryFixture({
      id: "symlinked",
      sourceBody:
        'module.exports = { id: "symlinked", register() { throw new Error("should not run"); } };',
    });
    try {
      fs.symlinkSync(outsideEntry, linkedEntry);
    } catch {
      return;
    }

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [linkedEntry] },
          allow: ["symlinked"],
        },
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "symlinked");
    expect(record?.status).not.toBe("loaded");
    expect(registry.diagnostics.some((entry) => entry.message.includes("escapes"))).toBe(true);
  });

  it("rejects plugin entry files that escape plugin root via hardlink", () => {
    if (process.platform === "win32") {
      return;
    }
    useNoBundledPlugins();
    const { outsideEntry, linkedEntry } = createEscapingEntryFixture({
      id: "hardlinked",
      sourceBody:
        'module.exports = { id: "hardlinked", register() { throw new Error("should not run"); } };',
    });
    try {
      fs.linkSync(outsideEntry, linkedEntry);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          load: { paths: [linkedEntry] },
          allow: ["hardlinked"],
        },
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "hardlinked");
    expect(record?.status).not.toBe("loaded");
    expect(registry.diagnostics.some((entry) => entry.message.includes("escapes"))).toBe(true);
  });

  it("allows bundled plugin entry files that are hardlinked aliases", () => {
    if (process.platform === "win32") {
      return;
    }
    const bundledDir = makeTempDir();
    const pluginDir = path.join(bundledDir, "hardlinked-bundled");
    mkdirSafe(pluginDir);

    const outsideDir = makeTempDir();
    const outsideEntry = path.join(outsideDir, "outside.cjs");
    fs.writeFileSync(
      outsideEntry,
      'module.exports = { id: "hardlinked-bundled", register() {} };',
      "utf-8",
    );
    const plugin = writePlugin({
      id: "hardlinked-bundled",
      body: 'module.exports = { id: "hardlinked-bundled", register() {} };',
      dir: pluginDir,
      filename: "index.cjs",
    });
    fs.rmSync(plugin.file);
    try {
      fs.linkSync(outsideEntry, plugin.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: bundledDir,
      config: {
        plugins: {
          entries: {
            "hardlinked-bundled": { enabled: true },
          },
          allow: ["hardlinked-bundled"],
        },
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "hardlinked-bundled");
    expect(record?.status).toBe("loaded");
    expect(registry.diagnostics.some((entry) => entry.message.includes("unsafe plugin path"))).toBe(
      false,
    );
  });

  it("preserves runtime reflection semantics when runtime is lazily initialized", () => {
    useNoBundledPlugins();
    const stateDir = makeTempDir();
    const plugin = writePlugin({
      id: "runtime-introspection",
      filename: "runtime-introspection.cjs",
      body: `module.exports = { id: "runtime-introspection", register(api) {
  const runtime = api.runtime ?? {};
  const keys = Object.keys(runtime);
  if (!keys.includes("channel")) {
    throw new Error("runtime channel key missing");
  }
  if (!("channel" in runtime)) {
    throw new Error("runtime channel missing from has check");
  }
  if (!Object.getOwnPropertyDescriptor(runtime, "channel")) {
    throw new Error("runtime channel descriptor missing");
  }
} };`,
    });

    const registry = withEnv({ OPENCLAW_STATE_DIR: stateDir }, () =>
      loadRegistryFromSinglePlugin({
        plugin,
        pluginConfig: {
          allow: ["runtime-introspection"],
        },
        options: {
          onlyPluginIds: ["runtime-introspection"],
        },
      }),
    );

    const record = registry.plugins.find((entry) => entry.id === "runtime-introspection");
    expect(record?.status).toBe("loaded");
  });

  it("supports legacy plugins importing monolithic plugin-sdk root", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "legacy-root-import",
      filename: "legacy-root-import.cjs",
      body: `module.exports = {
  id: "legacy-root-import",
  configSchema: (require("openclaw/plugin-sdk").emptyPluginConfigSchema)(),
  register() {},
};`,
    });

    const loaderModuleUrl = pathToFileURL(
      path.join(process.cwd(), "src", "plugins", "loader.ts"),
    ).href;
    const script = `
      import { loadOpenClawPlugins } from ${JSON.stringify(loaderModuleUrl)};
      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: ${JSON.stringify(plugin.dir)},
        config: {
          plugins: {
            load: { paths: [${JSON.stringify(plugin.file)}] },
            allow: ["legacy-root-import"],
          },
        },
      });
      const record = registry.plugins.find((entry) => entry.id === "legacy-root-import");
      if (!record || record.status !== "loaded") {
        console.error(record?.error ?? "legacy-root-import missing");
        process.exit(1);
      }
    `;

    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_HOME: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
      },
      encoding: "utf-8",
      stdio: "pipe",
    });
  });

  it("prefers dist plugin-sdk alias when loader runs from dist", () => {
    const { root, distFile } = createPluginSdkAliasFixture();

    const resolved = __testing.resolvePluginSdkAliasFile({
      srcFile: "index.ts",
      distFile: "index.js",
      modulePath: path.join(root, "dist", "plugins", "loader.js"),
    });
    expect(resolved).toBe(distFile);
  });

  it("prefers dist candidates first for production src runtime", () => {
    const { root, srcFile, distFile } = createPluginSdkAliasFixture();

    const candidates = withEnv({ NODE_ENV: "production", VITEST: undefined }, () =>
      __testing.listPluginSdkAliasCandidates({
        srcFile: "index.ts",
        distFile: "index.js",
        modulePath: path.join(root, "src", "plugins", "loader.ts"),
      }),
    );

    expect(candidates.indexOf(distFile)).toBeLessThan(candidates.indexOf(srcFile));
  });

  it("prefers src plugin-sdk alias when loader runs from src in non-production", () => {
    const { root, srcFile } = createPluginSdkAliasFixture();

    const resolved = withEnv({ NODE_ENV: undefined }, () =>
      __testing.resolvePluginSdkAliasFile({
        srcFile: "index.ts",
        distFile: "index.js",
        modulePath: path.join(root, "src", "plugins", "loader.ts"),
      }),
    );
    expect(resolved).toBe(srcFile);
  });

  it("prefers src candidates first for non-production src runtime", () => {
    const { root, srcFile, distFile } = createPluginSdkAliasFixture();

    const candidates = withEnv({ NODE_ENV: undefined }, () =>
      __testing.listPluginSdkAliasCandidates({
        srcFile: "index.ts",
        distFile: "index.js",
        modulePath: path.join(root, "src", "plugins", "loader.ts"),
      }),
    );

    expect(candidates.indexOf(srcFile)).toBeLessThan(candidates.indexOf(distFile));
  });

  it("derives plugin-sdk subpaths from package exports", () => {
    const subpaths = __testing.listPluginSdkExportedSubpaths();
    expect(subpaths).toContain("compat");
    expect(subpaths).toContain("telegram");
    expect(subpaths).not.toContain("root-alias");
  });

  it("falls back to src plugin-sdk alias when dist is missing in production", () => {
    const { root, srcFile, distFile } = createPluginSdkAliasFixture();
    fs.rmSync(distFile);

    const resolved = withEnv({ NODE_ENV: "production", VITEST: undefined }, () =>
      __testing.resolvePluginSdkAliasFile({
        srcFile: "index.ts",
        distFile: "index.js",
        modulePath: path.join(root, "src", "plugins", "loader.ts"),
      }),
    );
    expect(resolved).toBe(srcFile);
  });

  it("prefers dist root-alias shim when loader runs from dist", () => {
    const { root, distFile } = createPluginSdkAliasFixture({
      srcFile: "root-alias.cjs",
      distFile: "root-alias.cjs",
      srcBody: "module.exports = {};\n",
      distBody: "module.exports = {};\n",
    });

    const resolved = __testing.resolvePluginSdkAliasFile({
      srcFile: "root-alias.cjs",
      distFile: "root-alias.cjs",
      modulePath: path.join(root, "dist", "plugins", "loader.js"),
    });
    expect(resolved).toBe(distFile);
  });

  it("configures the plugin loader jiti boundary to prefer native dist modules", () => {
    const options = __testing.buildPluginLoaderJitiOptions({});

    expect(options.tryNative).toBe(true);
    expect(options.interopDefault).toBe(true);
    expect(options.extensions).toContain(".js");
    expect(options.extensions).toContain(".ts");
    expect("alias" in options).toBe(false);
  });

  it("prefers src root-alias shim when loader runs from src in non-production", () => {
    const { root, srcFile } = createPluginSdkAliasFixture({
      srcFile: "root-alias.cjs",
      distFile: "root-alias.cjs",
      srcBody: "module.exports = {};\n",
      distBody: "module.exports = {};\n",
    });

    const resolved = withEnv({ NODE_ENV: undefined }, () =>
      __testing.resolvePluginSdkAliasFile({
        srcFile: "root-alias.cjs",
        distFile: "root-alias.cjs",
        modulePath: path.join(root, "src", "plugins", "loader.ts"),
      }),
    );
    expect(resolved).toBe(srcFile);
  });

  it("resolves plugin-sdk alias from package root when loader runs from transpiler cache path", () => {
    const { root, srcFile } = createPluginSdkAliasFixture();

    const resolved = withEnv({ NODE_ENV: undefined }, () =>
      __testing.resolvePluginSdkAliasFile({
        srcFile: "index.ts",
        distFile: "index.js",
        modulePath: "/tmp/tsx-cache/openclaw-loader.js",
        argv1: path.join(root, "openclaw.mjs"),
      }),
    );
    expect(resolved).toBe(srcFile);
  });

  it("prefers dist plugin runtime module when loader runs from dist", () => {
    const { root, distFile } = createPluginRuntimeAliasFixture();

    const resolved = __testing.resolvePluginRuntimeModulePath({
      modulePath: path.join(root, "dist", "plugins", "loader.js"),
    });
    expect(resolved).toBe(distFile);
  });

  it("resolves plugin runtime module from package root when loader runs from transpiler cache path", () => {
    const { root, srcFile } = createPluginRuntimeAliasFixture();

    const resolved = withEnv({ NODE_ENV: undefined }, () =>
      __testing.resolvePluginRuntimeModulePath({
        modulePath: "/tmp/tsx-cache/openclaw-loader.js",
        argv1: path.join(root, "openclaw.mjs"),
      }),
    );
    expect(resolved).toBe(srcFile);
  });
});
