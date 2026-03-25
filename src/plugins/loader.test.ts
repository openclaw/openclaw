import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { buildMemoryPromptSection, registerMemoryPromptSection } from "../memory/prompt-section.js";
import { withEnv } from "../test-utils/env.js";
import { clearPluginCommands, getPluginCommandSpecs } from "./command-registry-state.js";
import { clearPluginDiscoveryCache } from "./discovery.js";
import { getGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { createHookRunner } from "./hooks.js";
import { __testing, clearPluginLoaderCache, loadOpenClawPlugins } from "./loader.js";
import { clearPluginManifestRegistryCache } from "./manifest-registry.js";
import { createEmptyPluginRegistry } from "./registry.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  setActivePluginRegistry,
} from "./runtime.js";

type TempPlugin = { dir: string; file: string; id: string };
type PluginLoadConfig = NonNullable<Parameters<typeof loadOpenClawPlugins>[0]>["config"];

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

function loadRegistryFromAllowedPlugins(
  plugins: TempPlugin[],
  options?: Omit<Parameters<typeof loadOpenClawPlugins>[0], "cache" | "config">,
) {
  return loadOpenClawPlugins({
    cache: false,
    ...options,
    config: {
      plugins: {
        load: { paths: plugins.map((plugin) => plugin.file) },
        allow: plugins.map((plugin) => plugin.id),
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

function createSetupEntryChannelPluginFixture(params: {
  id: string;
  label: string;
  packageName: string;
  fullBlurb: string;
  setupBlurb: string;
  configured: boolean;
  startupDeferConfiguredChannelFullLoadUntilAfterListen?: boolean;
}) {
  useNoBundledPlugins();
  const pluginDir = makeTempDir();
  const fullMarker = path.join(pluginDir, "full-loaded.txt");
  const setupMarker = path.join(pluginDir, "setup-loaded.txt");
  const listAccountIds = params.configured ? '["default"]' : "[]";
  const resolveAccount = params.configured
    ? '({ accountId: "default", token: "configured" })'
    : '({ accountId: "default" })';

  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify(
      {
        name: params.packageName,
        openclaw: {
          extensions: ["./index.cjs"],
          setupEntry: "./setup-entry.cjs",
          ...(params.startupDeferConfiguredChannelFullLoadUntilAfterListen
            ? {
                startup: {
                  deferConfiguredChannelFullLoadUntilAfterListen: true,
                },
              }
            : {}),
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
        id: params.id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
        channels: [params.id],
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
  id: ${JSON.stringify(params.id)},
  register(api) {
    api.registerChannel({
      plugin: {
        id: ${JSON.stringify(params.id)},
        meta: {
          id: ${JSON.stringify(params.id)},
          label: ${JSON.stringify(params.label)},
          selectionLabel: ${JSON.stringify(params.label)},
          docsPath: ${JSON.stringify(`/channels/${params.id}`)},
          blurb: ${JSON.stringify(params.fullBlurb)},
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ${listAccountIds},
          resolveAccount: () => ${resolveAccount},
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
    id: ${JSON.stringify(params.id)},
    meta: {
      id: ${JSON.stringify(params.id)},
      label: ${JSON.stringify(params.label)},
      selectionLabel: ${JSON.stringify(params.label)},
      docsPath: ${JSON.stringify(`/channels/${params.id}`)},
      blurb: ${JSON.stringify(params.setupBlurb)},
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ${listAccountIds},
      resolveAccount: () => ${resolveAccount},
    },
    outbound: { deliveryMode: "direct" },
  },
};`,
    "utf-8",
  );

  return { pluginDir, fullMarker, setupMarker };
}

function createEnvResolvedPluginFixture(pluginId: string) {
  useNoBundledPlugins();
  const openclawHome = makeTempDir();
  const ignoredHome = makeTempDir();
  const stateDir = makeTempDir();
  const pluginDir = path.join(openclawHome, "plugins", pluginId);
  mkdirSafe(pluginDir);
  const plugin = writePlugin({
    id: pluginId,
    dir: pluginDir,
    filename: "index.cjs",
    body: `module.exports = { id: ${JSON.stringify(pluginId)}, register() {} };`,
  });
  const env = {
    ...process.env,
    OPENCLAW_HOME: openclawHome,
    HOME: ignoredHome,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
  };
  return { plugin, env };
}

function expectEscapingEntryRejected(params: {
  id: string;
  linkKind: "symlink" | "hardlink";
  sourceBody: string;
}) {
  useNoBundledPlugins();
  const { outsideEntry, linkedEntry } = createEscapingEntryFixture({
    id: params.id,
    sourceBody: params.sourceBody,
  });
  try {
    if (params.linkKind === "symlink") {
      fs.symlinkSync(outsideEntry, linkedEntry);
    } else {
      fs.linkSync(outsideEntry, linkedEntry);
    }
  } catch (err) {
    if (params.linkKind === "hardlink" && (err as NodeJS.ErrnoException).code === "EXDEV") {
      return undefined;
    }
    if (params.linkKind === "symlink") {
      return undefined;
    }
    throw err;
  }

  const registry = loadOpenClawPlugins({
    cache: false,
    config: {
      plugins: {
        load: { paths: [linkedEntry] },
        allow: [params.id],
      },
    },
  });

  const record = registry.plugins.find((entry) => entry.id === params.id);
  expect(record?.status).not.toBe("loaded");
  expect(registry.diagnostics.some((entry) => entry.message.includes("escapes"))).toBe(true);
  return registry;
}

afterEach(() => {
  clearPluginLoaderCache();
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  resetDiagnosticEventsForTest();
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

  it("handles bundled telegram plugin enablement and override rules", () => {
    setupBundledTelegramPlugin();
    const cases = [
      {
        name: "loads bundled telegram plugin when enabled",
        config: {
          plugins: {
            allow: ["telegram"],
            entries: {
              telegram: { enabled: true },
            },
          },
        } satisfies PluginLoadConfig,
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expectTelegramLoaded(registry);
        },
      },
      {
        name: "loads bundled channel plugins when channels.<id>.enabled=true",
        config: {
          channels: {
            telegram: {
              enabled: true,
            },
          },
          plugins: {
            enabled: true,
          },
        } satisfies PluginLoadConfig,
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expectTelegramLoaded(registry);
        },
      },
      {
        name: "still respects explicit disable via plugins.entries for bundled channels",
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
        } satisfies PluginLoadConfig,
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const telegram = registry.plugins.find((entry) => entry.id === "telegram");
          expect(telegram?.status).toBe("disabled");
          expect(telegram?.error).toBe("disabled in config");
        },
      },
    ] as const;

    for (const testCase of cases) {
      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: cachedBundledTelegramDir,
        config: testCase.config,
      });
      testCase.assert(registry);
    }
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
  it("handles config-path and scoped plugin loads", () => {
    const scenarios = [
      {
        label: "loads plugins from config paths",
        run: () => {
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
          const plugin = writePlugin({
            id: "allowed-config-path",
            filename: "allowed-config-path.cjs",
            body: `module.exports = {
  id: "allowed-config-path",
  register(api) {
    api.registerGatewayMethod("allowed-config-path.ping", ({ respond }) => respond(true, { ok: true }));
  },
};`,
          });

          const registry = loadOpenClawPlugins({
            cache: false,
            workspaceDir: plugin.dir,
            config: {
              plugins: {
                load: { paths: [plugin.file] },
                allow: ["allowed-config-path"],
              },
            },
          });

          const loaded = registry.plugins.find((entry) => entry.id === "allowed-config-path");
          expect(loaded?.status).toBe("loaded");
          expect(Object.keys(registry.gatewayHandlers)).toContain("allowed-config-path.ping");
        },
      },
      {
        label: "limits imports to the requested plugin ids",
        run: () => {
          useNoBundledPlugins();
          const allowed = writePlugin({
            id: "allowed-scoped-only",
            filename: "allowed-scoped-only.cjs",
            body: `module.exports = { id: "allowed-scoped-only", register() {} };`,
          });
          const skippedMarker = path.join(makeTempDir(), "skipped-loaded.txt");
          const skipped = writePlugin({
            id: "skipped-scoped-only",
            filename: "skipped-scoped-only.cjs",
            body: `require("node:fs").writeFileSync(${JSON.stringify(skippedMarker)}, "loaded", "utf-8");
module.exports = { id: "skipped-scoped-only", register() { throw new Error("skipped plugin should not load"); } };`,
          });

          const registry = loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                load: { paths: [allowed.file, skipped.file] },
                allow: ["allowed-scoped-only", "skipped-scoped-only"],
              },
            },
            onlyPluginIds: ["allowed-scoped-only"],
          });

          expect(registry.plugins.map((entry) => entry.id)).toEqual(["allowed-scoped-only"]);
          expect(fs.existsSync(skippedMarker)).toBe(false);
        },
      },
      {
        label: "keeps scoped plugin loads in a separate cache entry",
        run: () => {
          useNoBundledPlugins();
          const allowed = writePlugin({
            id: "allowed-cache-scope",
            filename: "allowed-cache-scope.cjs",
            body: `module.exports = { id: "allowed-cache-scope", register() {} };`,
          });
          const extra = writePlugin({
            id: "extra-cache-scope",
            filename: "extra-cache-scope.cjs",
            body: `module.exports = { id: "extra-cache-scope", register() {} };`,
          });
          const options = {
            config: {
              plugins: {
                load: { paths: [allowed.file, extra.file] },
                allow: ["allowed-cache-scope", "extra-cache-scope"],
              },
            },
          };

          const full = loadOpenClawPlugins(options);
          const scoped = loadOpenClawPlugins({
            ...options,
            onlyPluginIds: ["allowed-cache-scope"],
          });
          const scopedAgain = loadOpenClawPlugins({
            ...options,
            onlyPluginIds: ["allowed-cache-scope"],
          });

          expect(full.plugins.map((entry) => entry.id).toSorted()).toEqual([
            "allowed-cache-scope",
            "extra-cache-scope",
          ]);
          expect(scoped).not.toBe(full);
          expect(scoped.plugins.map((entry) => entry.id)).toEqual(["allowed-cache-scope"]);
          expect(scopedAgain).toBe(scoped);
        },
      },
      {
        label: "can load a scoped registry without replacing the active global registry",
        run: () => {
          useNoBundledPlugins();
          const plugin = writePlugin({
            id: "allowed-nonactivating-scope",
            filename: "allowed-nonactivating-scope.cjs",
            body: `module.exports = { id: "allowed-nonactivating-scope", register() {} };`,
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
                allow: ["allowed-nonactivating-scope"],
              },
            },
            onlyPluginIds: ["allowed-nonactivating-scope"],
          });

          expect(scoped.plugins.map((entry) => entry.id)).toEqual(["allowed-nonactivating-scope"]);
          expect(getActivePluginRegistry()).toBe(previousRegistry);
          expect(getActivePluginRegistryKey()).toBe("existing-registry");
          expect(getGlobalHookRunner()).toBeNull();
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      scenario.run();
    }
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

  it("can scope bundled provider loads to deepseek without hanging", () => {
    if (prevBundledDir === undefined) {
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = prevBundledDir;
    }

    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      config: {
        plugins: {
          enabled: true,
          allow: ["deepseek"],
        },
      },
      onlyPluginIds: ["deepseek"],
    });

    expect(scoped.plugins.map((entry) => entry.id)).toEqual(["deepseek"]);
    expect(scoped.plugins[0]?.status).toBe("loaded");
    expect(scoped.providers.map((entry) => entry.provider.id)).toEqual(["deepseek"]);
  });

  it("does not replace the active memory prompt section during non-activating loads", () => {
    useNoBundledPlugins();
    registerMemoryPromptSection(() => ["active memory section"]);
    const plugin = writePlugin({
      id: "snapshot-memory",
      filename: "snapshot-memory.cjs",
      body: `module.exports = {
        id: "snapshot-memory",
        kind: "memory",
        register(api) {
          api.registerMemoryPromptSection(() => ["snapshot memory section"]);
        },
      };`,
    });

    const scoped = loadOpenClawPlugins({
      cache: false,
      activate: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["snapshot-memory"],
          slots: { memory: "snapshot-memory" },
        },
      },
      onlyPluginIds: ["snapshot-memory"],
    });

    expect(scoped.plugins.find((entry) => entry.id === "snapshot-memory")?.status).toBe("loaded");
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "active memory section",
    ]);
  });

  it("clears a newly-registered memory prompt section when plugin register fails", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "failing-memory",
      filename: "failing-memory.cjs",
      body: `module.exports = {
        id: "failing-memory",
        kind: "memory",
        register(api) {
          api.registerMemoryPromptSection(() => ["stale failure section"]);
          throw new Error("memory register failed");
        },
      };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["failing-memory"],
          slots: { memory: "failing-memory" },
        },
      },
      onlyPluginIds: ["failing-memory"],
    });

    expect(registry.plugins.find((entry) => entry.id === "failing-memory")?.status).toBe("error");
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([]);
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

  it.each([
    {
      name: "does not reuse cached registries when env-resolved install paths change",
      setup: () => {
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
        return {
          loadFirst: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                OPENCLAW_HOME: openclawHome,
                HOME: ignoredHome,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
              },
            }),
          loadVariant: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                OPENCLAW_HOME: secondHome,
                HOME: ignoredHome,
                OPENCLAW_STATE_DIR: stateDir,
                OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
              },
            }),
        };
      },
    },
    {
      name: "does not reuse cached registries across gateway subagent binding modes",
      setup: () => {
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

        return {
          loadFirst: () => loadOpenClawPlugins(options),
          loadVariant: () =>
            loadOpenClawPlugins({
              ...options,
              runtimeOptions: {
                allowGatewaySubagentBinding: true,
              },
            }),
        };
      },
    },
  ])("$name", ({ setup }) => {
    expectCacheMissThenHit(setup());
  });

  it("evicts least recently used registries when the loader cache exceeds its cap", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "cache-eviction",
      filename: "cache-eviction.cjs",
      body: `module.exports = { id: "cache-eviction", register() {} };`,
    });
    const previousCacheCap = __testing.maxPluginRegistryCacheEntries;
    __testing.setMaxPluginRegistryCacheEntriesForTest(4);
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

    try {
      const first = loadWithStateDir(stateDirs[0] ?? makeTempDir());
      const second = loadWithStateDir(stateDirs[1] ?? makeTempDir());

      expect(loadWithStateDir(stateDirs[0] ?? makeTempDir())).toBe(first);

      for (const stateDir of stateDirs.slice(2)) {
        loadWithStateDir(stateDir);
      }

      expect(loadWithStateDir(stateDirs[0] ?? makeTempDir())).toBe(first);
      expect(loadWithStateDir(stateDirs[1] ?? makeTempDir())).not.toBe(second);
    } finally {
      __testing.setMaxPluginRegistryCacheEntriesForTest(previousCacheCap);
    }
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

  it("throws when strict plugin loading sees plugin errors", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "configurable",
      filename: "configurable.cjs",
      body: `module.exports = { id: "configurable", register() {} };`,
    });

    expect(() =>
      loadOpenClawPlugins({
        cache: false,
        throwOnLoadError: true,
        config: {
          plugins: {
            enabled: true,
            load: { paths: [plugin.file] },
            allow: ["configurable"],
            entries: {
              configurable: {
                enabled: true,
                config: "nope" as unknown as Record<string, unknown>,
              },
            },
          },
        },
      }),
    ).toThrow("plugin load failed: configurable: invalid config: <root>: must be object");
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

  it("handles single-plugin channel, context engine, and cli validation", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "registers channel plugins",
        pluginId: "channel-demo",
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
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const channel = registry.channels.find((entry) => entry.plugin.id === "demo");
          expect(channel).toBeDefined();
        },
      },
      {
        label: "rejects duplicate channel ids during plugin registration",
        pluginId: "channel-dup",
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
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(registry.channels.filter((entry) => entry.plugin.id === "demo")).toHaveLength(1);
          expect(
            registry.diagnostics.some(
              (entry) =>
                entry.level === "error" &&
                entry.pluginId === "channel-dup" &&
                entry.message === "channel already registered: demo (channel-dup)",
            ),
          ).toBe(true);
        },
      },
      {
        label: "rejects plugin context engine ids reserved by core",
        pluginId: "context-engine-core-collision",
        body: `module.exports = { id: "context-engine-core-collision", register(api) {
  api.registerContextEngine("legacy", () => ({}));
} };`,
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(
            registry.diagnostics.some(
              (diag) =>
                diag.level === "error" &&
                diag.pluginId === "context-engine-core-collision" &&
                diag.message === "context engine id reserved by core: legacy",
            ),
          ).toBe(true);
        },
      },
      {
        label: "requires plugin CLI registrars to declare explicit command roots",
        pluginId: "cli-missing-metadata",
        body: `module.exports = { id: "cli-missing-metadata", register(api) {
  api.registerCli(() => {});
} };`,
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(registry.cliRegistrars).toHaveLength(0);
          expect(
            registry.diagnostics.some(
              (diag) =>
                diag.level === "error" &&
                diag.pluginId === "cli-missing-metadata" &&
                diag.message === "cli registration missing explicit commands metadata",
            ),
          ).toBe(true);
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const plugin = writePlugin({
        id: scenario.pluginId,
        filename: `${scenario.pluginId}.cjs`,
        body: scenario.body,
      });

      const registry = loadRegistryFromSinglePlugin({
        plugin,
        pluginConfig: {
          allow: [scenario.pluginId],
        },
      });

      scenario.assert(registry);
    }
  });

  it("registers plugin http routes", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "defaults exact match",
        pluginId: "http-route-demo",
        routeOptions:
          '{ path: "/demo", auth: "gateway", handler: async (_req, res) => { res.statusCode = 200; res.end("ok"); } }',
        expectedPath: "/demo",
        expectedAuth: "gateway",
        expectedMatch: "exact",
      },
      {
        label: "keeps explicit auth and match options",
        pluginId: "http-demo",
        routeOptions:
          '{ path: "/webhook", auth: "plugin", match: "prefix", handler: async () => false }',
        expectedPath: "/webhook",
        expectedAuth: "plugin",
        expectedMatch: "prefix",
      },
    ] as const;

    for (const scenario of scenarios) {
      const plugin = writePlugin({
        id: scenario.pluginId,
        filename: `${scenario.pluginId}.cjs`,
        body: `module.exports = { id: "${scenario.pluginId}", register(api) {
  api.registerHttpRoute(${scenario.routeOptions});
} };`,
      });

      const registry = loadRegistryFromSinglePlugin({
        plugin,
        pluginConfig: {
          allow: [scenario.pluginId],
        },
      });

      const route = registry.httpRoutes.find((entry) => entry.pluginId === scenario.pluginId);
      expect(route, scenario.label).toBeDefined();
      expect(route?.path, scenario.label).toBe(scenario.expectedPath);
      expect(route?.auth, scenario.label).toBe(scenario.expectedAuth);
      expect(route?.match, scenario.label).toBe(scenario.expectedMatch);
      const httpPlugin = registry.plugins.find((entry) => entry.id === scenario.pluginId);
      expect(httpPlugin?.httpRoutes, scenario.label).toBe(1);
    }
  });

  it("rejects duplicate plugin registrations", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "plugin-visible hook names",
        ownerA: "hook-owner-a",
        ownerB: "hook-owner-b",
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
  api.registerHook("gateway:startup", () => {}, { name: "shared-hook" });
} };`,
        selectCount: (registry: ReturnType<typeof loadOpenClawPlugins>) =>
          registry.hooks.filter((entry) => entry.entry.hook.name === "shared-hook").length,
        duplicateMessage: "hook already registered: shared-hook (hook-owner-a)",
      },
      {
        label: "plugin service ids",
        ownerA: "service-owner-a",
        ownerB: "service-owner-b",
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
  api.registerService({ id: "shared-service", start() {} });
} };`,
        selectCount: (registry: ReturnType<typeof loadOpenClawPlugins>) =>
          registry.services.filter((entry) => entry.service.id === "shared-service").length,
        duplicateMessage: "service already registered: shared-service (service-owner-a)",
      },
      {
        label: "plugin context engine ids",
        ownerA: "context-engine-owner-a",
        ownerB: "context-engine-owner-b",
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
  api.registerContextEngine("shared-context-engine-loader-test", () => ({}));
} };`,
        selectCount: () => 1,
        duplicateMessage:
          "context engine already registered: shared-context-engine-loader-test (plugin:context-engine-owner-a)",
      },
      {
        label: "plugin CLI command roots",
        ownerA: "cli-owner-a",
        ownerB: "cli-owner-b",
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
  api.registerCli(() => {}, { commands: ["shared-cli"] });
} };`,
        selectCount: (registry: ReturnType<typeof loadOpenClawPlugins>) =>
          registry.cliRegistrars.length,
        duplicateMessage: "cli command already registered: shared-cli (cli-owner-a)",
        assertPrimaryOwner: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(registry.cliRegistrars[0]?.pluginId).toBe("cli-owner-a");
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const first = writePlugin({
        id: scenario.ownerA,
        filename: `${scenario.ownerA}.cjs`,
        body: scenario.buildBody(scenario.ownerA),
      });
      const second = writePlugin({
        id: scenario.ownerB,
        filename: `${scenario.ownerB}.cjs`,
        body: scenario.buildBody(scenario.ownerB),
      });

      const registry = loadRegistryFromAllowedPlugins([first, second]);

      expect(scenario.selectCount(registry), scenario.label).toBe(1);
      if ("assertPrimaryOwner" in scenario) {
        scenario.assertPrimaryOwner?.(registry);
      }
      expect(
        registry.diagnostics.some(
          (diag) =>
            diag.level === "error" &&
            diag.pluginId === scenario.ownerB &&
            diag.message === scenario.duplicateMessage,
        ),
        scenario.label,
      ).toBe(true);
    }
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

  it("enforces plugin http route validation and conflict rules", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "missing auth is rejected",
        buildPlugins: () => [
          writePlugin({
            id: "http-route-missing-auth",
            filename: "http-route-missing-auth.cjs",
            body: `module.exports = { id: "http-route-missing-auth", register(api) {
  api.registerHttpRoute({ path: "/demo", handler: async () => true });
} };`,
          }),
        ],
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(
            registry.httpRoutes.find((entry) => entry.pluginId === "http-route-missing-auth"),
          ).toBeUndefined();
          expect(
            registry.diagnostics.some((diag) =>
              String(diag.message).includes("http route registration missing or invalid auth"),
            ),
          ).toBe(true);
        },
      },
      {
        label: "same plugin can replace its own route",
        buildPlugins: () => [
          writePlugin({
            id: "http-route-replace-self",
            filename: "http-route-replace-self.cjs",
            body: `module.exports = { id: "http-route-replace-self", register(api) {
  api.registerHttpRoute({ path: "/demo", auth: "plugin", handler: async () => false });
  api.registerHttpRoute({ path: "/demo", auth: "plugin", replaceExisting: true, handler: async () => true });
} };`,
          }),
        ],
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const routes = registry.httpRoutes.filter(
            (entry) => entry.pluginId === "http-route-replace-self",
          );
          expect(routes).toHaveLength(1);
          expect(routes[0]?.path).toBe("/demo");
          expect(registry.diagnostics).toEqual([]);
        },
      },
      {
        label: "cross-plugin replaceExisting is rejected",
        buildPlugins: () => [
          writePlugin({
            id: "http-route-owner-a",
            filename: "http-route-owner-a.cjs",
            body: `module.exports = { id: "http-route-owner-a", register(api) {
  api.registerHttpRoute({ path: "/demo", auth: "plugin", handler: async () => false });
} };`,
          }),
          writePlugin({
            id: "http-route-owner-b",
            filename: "http-route-owner-b.cjs",
            body: `module.exports = { id: "http-route-owner-b", register(api) {
  api.registerHttpRoute({ path: "/demo", auth: "plugin", replaceExisting: true, handler: async () => true });
} };`,
          }),
        ],
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const route = registry.httpRoutes.find((entry) => entry.path === "/demo");
          expect(route?.pluginId).toBe("http-route-owner-a");
          expect(
            registry.diagnostics.some((diag) =>
              String(diag.message).includes("http route replacement rejected"),
            ),
          ).toBe(true);
        },
      },
      {
        label: "mixed-auth overlaps are rejected",
        buildPlugins: () => [
          writePlugin({
            id: "http-route-overlap",
            filename: "http-route-overlap.cjs",
            body: `module.exports = { id: "http-route-overlap", register(api) {
  api.registerHttpRoute({ path: "/plugin/secure", auth: "gateway", match: "prefix", handler: async () => true });
  api.registerHttpRoute({ path: "/plugin/secure/report", auth: "plugin", match: "exact", handler: async () => true });
} };`,
          }),
        ],
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const routes = registry.httpRoutes.filter(
            (entry) => entry.pluginId === "http-route-overlap",
          );
          expect(routes).toHaveLength(1);
          expect(routes[0]?.path).toBe("/plugin/secure");
          expect(
            registry.diagnostics.some((diag) =>
              String(diag.message).includes("http route overlap rejected"),
            ),
          ).toBe(true);
        },
      },
      {
        label: "same-auth overlaps are allowed",
        buildPlugins: () => [
          writePlugin({
            id: "http-route-overlap-same-auth",
            filename: "http-route-overlap-same-auth.cjs",
            body: `module.exports = { id: "http-route-overlap-same-auth", register(api) {
  api.registerHttpRoute({ path: "/plugin/public", auth: "plugin", match: "prefix", handler: async () => true });
  api.registerHttpRoute({ path: "/plugin/public/report", auth: "plugin", match: "exact", handler: async () => true });
} };`,
          }),
        ],
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const routes = registry.httpRoutes.filter(
            (entry) => entry.pluginId === "http-route-overlap-same-auth",
          );
          expect(routes).toHaveLength(2);
          expect(registry.diagnostics).toEqual([]);
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const plugins = scenario.buildPlugins();
      const registry =
        plugins.length === 1
          ? loadRegistryFromSinglePlugin({
              plugin: plugins[0],
              pluginConfig: {
                allow: [plugins[0].id],
              },
            })
          : loadRegistryFromAllowedPlugins(plugins);
      scenario.assert(registry);
    }
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

  it.each([
    {
      name: "uses package setupEntry for setup-only channel loads",
      fixture: {
        id: "setup-entry-test",
        label: "Setup Entry Test",
        packageName: "@openclaw/setup-entry-test",
        fullBlurb: "full entry should not run in setup-only mode",
        setupBlurb: "setup entry",
        configured: false,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
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
        }),
      expectFullLoaded: false,
      expectSetupLoaded: true,
      expectedChannels: 0,
    },
    {
      name: "uses package setupEntry for enabled but unconfigured channel loads",
      fixture: {
        id: "setup-runtime-test",
        label: "Setup Runtime Test",
        packageName: "@openclaw/setup-runtime-test",
        fullBlurb: "full entry should not run while unconfigured",
        setupBlurb: "setup runtime",
        configured: false,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              load: { paths: [pluginDir] },
              allow: ["setup-runtime-test"],
            },
          },
        }),
      expectFullLoaded: false,
      expectSetupLoaded: true,
      expectedChannels: 1,
    },
    {
      name: "can prefer setupEntry for configured channel loads during startup",
      fixture: {
        id: "setup-runtime-preferred-test",
        label: "Setup Runtime Preferred Test",
        packageName: "@openclaw/setup-runtime-preferred-test",
        fullBlurb: "full entry should be deferred while startup is still cold",
        setupBlurb: "setup runtime preferred",
        configured: true,
        startupDeferConfiguredChannelFullLoadUntilAfterListen: true,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
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
        }),
      expectFullLoaded: false,
      expectSetupLoaded: true,
      expectedChannels: 1,
    },
    {
      name: "does not prefer setupEntry for configured channel loads without startup opt-in",
      fixture: {
        id: "setup-runtime-not-preferred-test",
        label: "Setup Runtime Not Preferred Test",
        packageName: "@openclaw/setup-runtime-not-preferred-test",
        fullBlurb: "full entry should still load without explicit startup opt-in",
        setupBlurb: "setup runtime not preferred",
        configured: true,
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
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
        }),
      expectFullLoaded: true,
      expectSetupLoaded: false,
      expectedChannels: 1,
    },
  ])("$name", ({ fixture, load, expectFullLoaded, expectSetupLoaded, expectedChannels }) => {
    const built = createSetupEntryChannelPluginFixture(fixture);
    const registry = load({ pluginDir: built.pluginDir });

    expect(fs.existsSync(built.fullMarker)).toBe(expectFullLoaded);
    expect(fs.existsSync(built.setupMarker)).toBe(expectSetupLoaded);
    expect(registry.channelSetups).toHaveLength(1);
    expect(registry.channels).toHaveLength(expectedChannels);
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
    modelOverride: "gpt-5.4",
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
      modelOverride: "gpt-5.4",
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

  it("enforces memory slot loading rules", () => {
    const scenarios = [
      {
        label: "enforces memory slot selection",
        loadRegistry: () => {
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
          const memoryA = writePlugin({
            id: "memory-a",
            body: `module.exports = { id: "memory-a", kind: "memory", register() {} };`,
          });
          const memoryB = writePlugin({
            id: "memory-b",
            body: `module.exports = { id: "memory-b", kind: "memory", register() {} };`,
          });

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                load: { paths: [memoryA.file, memoryB.file] },
                slots: { memory: "memory-b" },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const a = registry.plugins.find((entry) => entry.id === "memory-a");
          const b = registry.plugins.find((entry) => entry.id === "memory-b");
          expect(b?.status).toBe("loaded");
          expect(a?.status).toBe("disabled");
        },
      },
      {
        label: "skips importing bundled memory plugins that are disabled by memory slot",
        loadRegistry: () => {
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

          return loadOpenClawPlugins({
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
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const a = registry.plugins.find((entry) => entry.id === "memory-a");
          const b = registry.plugins.find((entry) => entry.id === "memory-b");
          expect(a?.status).toBe("disabled");
          expect(String(a?.error ?? "")).toContain('memory slot set to "memory-b"');
          expect(b?.status).toBe("loaded");
        },
      },
      {
        label: "disables memory plugins when slot is none",
        loadRegistry: () => {
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
          const memory = writePlugin({
            id: "memory-off",
            body: `module.exports = { id: "memory-off", kind: "memory", register() {} };`,
          });

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                load: { paths: [memory.file] },
                slots: { memory: "none" },
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const entry = registry.plugins.find((item) => item.id === "memory-off");
          expect(entry?.status).toBe("disabled");
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const registry = scenario.loadRegistry();
      scenario.assert(registry);
    }
  });

  it("resolves duplicate plugin ids by source precedence", () => {
    const scenarios = [
      {
        label: "config load overrides bundled",
        pluginId: "shadow",
        bundledFilename: "shadow.cjs",
        loadRegistry: () => {
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

          return loadOpenClawPlugins({
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
        },
        expectedLoadedOrigin: "config",
        expectedDisabledOrigin: "bundled",
      },
      {
        label: "bundled beats auto-discovered global duplicate",
        pluginId: "feishu",
        bundledFilename: "index.cjs",
        loadRegistry: () => {
          const bundledDir = makeTempDir();
          writePlugin({
            id: "feishu",
            body: `module.exports = { id: "feishu", register() {} };`,
            dir: bundledDir,
            filename: "index.cjs",
          });
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

          const stateDir = makeTempDir();
          return withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
            const globalDir = path.join(stateDir, "extensions", "feishu");
            mkdirSafe(globalDir);
            writePlugin({
              id: "feishu",
              body: `module.exports = { id: "feishu", register() {} };`,
              dir: globalDir,
              filename: "index.cjs",
            });

            return loadOpenClawPlugins({
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
          });
        },
        expectedLoadedOrigin: "bundled",
        expectedDisabledOrigin: "global",
        expectedDisabledError: "overridden by bundled plugin",
      },
      {
        label: "installed global beats bundled duplicate",
        pluginId: "zalouser",
        bundledFilename: "index.cjs",
        loadRegistry: () => {
          const bundledDir = makeTempDir();
          writePlugin({
            id: "zalouser",
            body: `module.exports = { id: "zalouser", register() {} };`,
            dir: bundledDir,
            filename: "index.cjs",
          });
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

          const stateDir = makeTempDir();
          return withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
            const globalDir = path.join(stateDir, "extensions", "zalouser");
            mkdirSafe(globalDir);
            writePlugin({
              id: "zalouser",
              body: `module.exports = { id: "zalouser", register() {} };`,
              dir: globalDir,
              filename: "index.cjs",
            });

            return loadOpenClawPlugins({
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
          });
        },
        expectedLoadedOrigin: "global",
        expectedDisabledOrigin: "bundled",
        expectedDisabledError: "overridden by global plugin",
      },
    ] as const;

    for (const scenario of scenarios) {
      const registry = scenario.loadRegistry();
      const entries = registry.plugins.filter((entry) => entry.id === scenario.pluginId);
      const loaded = entries.find((entry) => entry.status === "loaded");
      const overridden = entries.find((entry) => entry.status === "disabled");
      expect(loaded?.origin, scenario.label).toBe(scenario.expectedLoadedOrigin);
      expect(overridden?.origin, scenario.label).toBe(scenario.expectedDisabledOrigin);
      if ("expectedDisabledError" in scenario) {
        expect(overridden?.error, scenario.label).toContain(scenario.expectedDisabledError);
      }
    }
  });

  it("warns about open allowlists for discoverable plugins once per plugin set", () => {
    useNoBundledPlugins();
    clearPluginLoaderCache();
    const scenarios = [
      {
        label: "single load warns",
        pluginId: "warn-open-allow",
        loads: 1,
        expectedWarnings: 1,
      },
      {
        label: "repeated identical loads dedupe warning",
        pluginId: "warn-open-allow-once",
        loads: 2,
        expectedWarnings: 1,
      },
    ] as const;

    for (const scenario of scenarios) {
      const plugin = writePlugin({
        id: scenario.pluginId,
        body: `module.exports = { id: "${scenario.pluginId}", register() {} };`,
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

      for (let index = 0; index < scenario.loads; index += 1) {
        loadOpenClawPlugins(options);
      }

      const openAllowWarnings = warnings.filter((msg) => msg.includes("plugins.allow is empty"));
      expect(openAllowWarnings, scenario.label).toHaveLength(scenario.expectedWarnings);
      expect(
        openAllowWarnings.some((msg) => msg.includes(scenario.pluginId)),
        scenario.label,
      ).toBe(true);
    }
  });

  it("handles workspace-discovered plugins according to trust and precedence", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "untrusted workspace plugins stay disabled",
        pluginId: "workspace-helper",
        loadRegistry: () => {
          const workspaceDir = makeTempDir();
          const workspaceExtDir = path.join(
            workspaceDir,
            ".openclaw",
            "extensions",
            "workspace-helper",
          );
          mkdirSafe(workspaceExtDir);
          writePlugin({
            id: "workspace-helper",
            body: `module.exports = { id: "workspace-helper", register() {} };`,
            dir: workspaceExtDir,
            filename: "index.cjs",
          });

          return loadOpenClawPlugins({
            cache: false,
            workspaceDir,
            config: {
              plugins: {
                enabled: true,
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const workspacePlugin = registry.plugins.find((entry) => entry.id === "workspace-helper");
          expect(workspacePlugin?.origin).toBe("workspace");
          expect(workspacePlugin?.status).toBe("disabled");
          expect(workspacePlugin?.error).toContain("workspace plugin (disabled by default)");
        },
      },
      {
        label: "trusted workspace plugins load",
        pluginId: "workspace-helper",
        loadRegistry: () => {
          const workspaceDir = makeTempDir();
          const workspaceExtDir = path.join(
            workspaceDir,
            ".openclaw",
            "extensions",
            "workspace-helper",
          );
          mkdirSafe(workspaceExtDir);
          writePlugin({
            id: "workspace-helper",
            body: `module.exports = { id: "workspace-helper", register() {} };`,
            dir: workspaceExtDir,
            filename: "index.cjs",
          });

          return loadOpenClawPlugins({
            cache: false,
            workspaceDir,
            config: {
              plugins: {
                enabled: true,
                allow: ["workspace-helper"],
              },
            },
          });
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const workspacePlugin = registry.plugins.find((entry) => entry.id === "workspace-helper");
          expect(workspacePlugin?.origin).toBe("workspace");
          expect(workspacePlugin?.status).toBe("loaded");
        },
      },
      {
        label: "bundled plugins stay ahead of trusted workspace duplicates",
        pluginId: "shadowed",
        loadRegistry: () => {
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

          return loadOpenClawPlugins({
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
        },
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const entries = registry.plugins.filter((entry) => entry.id === "shadowed");
          const loaded = entries.find((entry) => entry.status === "loaded");
          const overridden = entries.find((entry) => entry.status === "disabled");
          expect(loaded?.origin).toBe("bundled");
          expect(overridden?.origin).toBe("workspace");
          expect(overridden?.error).toContain("overridden by bundled plugin");
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const registry = scenario.loadRegistry();
      scenario.assert(registry);
    }
  });

  it("loads bundled plugins when manifest metadata opts into default enablement", () => {
    const bundledDir = makeTempDir();
    const plugin = writePlugin({
      id: "profile-aware",
      body: `module.exports = { id: "profile-aware", register() {} };`,
      dir: bundledDir,
      filename: "index.cjs",
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "profile-aware",
          enabledByDefault: true,
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
      workspaceDir: bundledDir,
      config: {
        plugins: {
          enabled: true,
        },
      },
    });

    const bundledPlugin = registry.plugins.find((entry) => entry.id === "profile-aware");
    expect(bundledPlugin?.origin).toBe("bundled");
    expect(bundledPlugin?.status).toBe("loaded");
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

  it("evaluates load-path provenance warnings", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "warns when loaded non-bundled plugin has no install/load-path provenance",
        loadRegistry: () => {
          const stateDir = makeTempDir();
          return withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
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

            return { registry, warnings, pluginId: "rogue", expectWarning: true };
          });
        },
      },
      {
        label: "does not warn about missing provenance for env-resolved load paths",
        loadRegistry: () => {
          const { plugin, env } = createEnvResolvedPluginFixture("tracked-load-path");
          const warnings: string[] = [];
          const registry = loadOpenClawPlugins({
            cache: false,
            logger: createWarningLogger(warnings),
            env,
            config: {
              plugins: {
                load: { paths: ["~/plugins/tracked-load-path"] },
                allow: [plugin.id],
              },
            },
          });

          return {
            registry,
            warnings,
            pluginId: plugin.id,
            expectWarning: false,
            expectedSource: plugin.file,
          };
        },
      },
      {
        label: "does not warn about missing provenance for env-resolved install paths",
        loadRegistry: () => {
          const { plugin, env } = createEnvResolvedPluginFixture("tracked-install-path");
          const warnings: string[] = [];
          const registry = loadOpenClawPlugins({
            cache: false,
            logger: createWarningLogger(warnings),
            env,
            config: {
              plugins: {
                load: { paths: [plugin.file] },
                allow: [plugin.id],
                installs: {
                  [plugin.id]: {
                    source: "path",
                    installPath: `~/plugins/${plugin.id}`,
                    sourcePath: `~/plugins/${plugin.id}`,
                  },
                },
              },
            },
          });

          return {
            registry,
            warnings,
            pluginId: plugin.id,
            expectWarning: false,
            expectedSource: plugin.file,
          };
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const loadedScenario = scenario.loadRegistry();
      const { registry, warnings, pluginId, expectWarning } = loadedScenario;
      const expectedSource =
        "expectedSource" in loadedScenario ? loadedScenario.expectedSource : undefined;
      const plugin = registry.plugins.find((entry) => entry.id === pluginId);
      expect(plugin?.status, scenario.label).toBe("loaded");
      if (expectedSource) {
        expect(plugin?.source, scenario.label).toBe(expectedSource);
      }
      expect(
        warnings.some(
          (msg) =>
            msg.includes(pluginId) && msg.includes("loaded without install/load-path provenance"),
        ),
        scenario.label,
      ).toBe(expectWarning);
    }
  });

  it.each([
    {
      name: "rejects plugin entry files that escape plugin root via symlink",
      id: "symlinked",
      linkKind: "symlink" as const,
    },
    {
      name: "rejects plugin entry files that escape plugin root via hardlink",
      id: "hardlinked",
      linkKind: "hardlink" as const,
      skip: process.platform === "win32",
    },
  ])("$name", ({ id, linkKind, skip }) => {
    if (skip) {
      return;
    }
    expectEscapingEntryRejected({
      id,
      linkKind,
      sourceBody: `module.exports = { id: "${id}", register() { throw new Error("should not run"); } };`,
    });
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

    const registry = withEnv({ OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins" }, () =>
      loadOpenClawPlugins({
        cache: false,
        workspaceDir: plugin.dir,
        config: {
          plugins: {
            load: { paths: [plugin.file] },
            allow: ["legacy-root-import"],
          },
        },
      }),
    );
    const record = registry.plugins.find((entry) => entry.id === "legacy-root-import");
    expect(record?.status).toBe("loaded");
  });

  it("supports legacy plugins subscribing to diagnostic events from the root sdk", async () => {
    useNoBundledPlugins();
    const seenKey = "__openclawLegacyRootDiagnosticSeen";
    delete (globalThis as Record<string, unknown>)[seenKey];

    const plugin = writePlugin({
      id: "legacy-root-diagnostic-listener",
      filename: "legacy-root-diagnostic-listener.cjs",
      body: `module.exports = {
  id: "legacy-root-diagnostic-listener",
  configSchema: (require("openclaw/plugin-sdk").emptyPluginConfigSchema)(),
  register() {
    const { onDiagnosticEvent } = require("openclaw/plugin-sdk");
    if (typeof onDiagnosticEvent !== "function") {
      throw new Error("missing onDiagnosticEvent root export");
    }
    globalThis.${seenKey} = [];
    onDiagnosticEvent((event) => {
      globalThis.${seenKey}.push({
        type: event.type,
        sessionKey: event.sessionKey,
      });
    });
  },
};`,
    });

    try {
      const registry = withEnv(
        { OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins" },
        () =>
          loadOpenClawPlugins({
            cache: false,
            workspaceDir: plugin.dir,
            config: {
              plugins: {
                load: { paths: [plugin.file] },
                allow: ["legacy-root-diagnostic-listener"],
              },
            },
          }),
      );
      const record = registry.plugins.find(
        (entry) => entry.id === "legacy-root-diagnostic-listener",
      );
      expect(record?.status).toBe("loaded");

      emitDiagnosticEvent({
        type: "model.usage",
        sessionKey: "agent:main:test:dm:peer",
        usage: { total: 1 },
      });

      expect((globalThis as Record<string, unknown>)[seenKey]).toEqual([
        {
          type: "model.usage",
          sessionKey: "agent:main:test:dm:peer",
        },
      ]);
    } finally {
      delete (globalThis as Record<string, unknown>)[seenKey];
    }
  });

  it("loads source TypeScript plugins that route through local runtime shims", () => {
    const plugin = writePlugin({
      id: "source-runtime-shim",
      filename: "source-runtime-shim.ts",
      body: `import "./runtime-shim.ts";

export default {
  id: "source-runtime-shim",
  register() {},
};`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "runtime-shim.ts"),
      `import { helperValue } from "./helper.js";

export const runtimeValue = helperValue;`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(plugin.dir, "helper.ts"),
      `export const helperValue = "ok";`,
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["source-runtime-shim"],
        },
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "source-runtime-shim");
    expect(record?.status).toBe("loaded");
  });
});

describe("clearPluginLoaderCache", () => {
  it("resets the registered memory prompt section builder", () => {
    registerMemoryPromptSection(() => ["stale memory section"]);
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "stale memory section",
    ]);

    clearPluginLoaderCache();

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([]);
  });
});
