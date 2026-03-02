import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { getGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { __testing, loadOpenClawPlugins } from "./loader.js";

type TempPlugin = { dir: string; file: string; id: string };

const fixtureRoot = path.join(os.tmpdir(), `openclaw-plugin-${randomUUID()}`);
let tempDirIndex = 0;
const prevBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };
const BUNDLED_TELEGRAM_PLUGIN_BODY = `export default { id: "telegram", register(api) {
  api.registerChannel({
    plugin: {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "telegram channel"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
} };`;

function makeTempDir() {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writePlugin(params: {
  id: string;
  body: string;
  dir?: string;
  filename?: string;
}): TempPlugin {
  const dir = params.dir ?? makeTempDir();
  const filename = params.filename ?? `${params.id}.js`;
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
  const bundledDir = makeTempDir();
  let pluginDir = bundledDir;
  let pluginFilename = options?.pluginFilename ?? "memory-core.js";

  if (options?.packageMeta) {
    pluginDir = path.join(bundledDir, "memory-core");
    pluginFilename = "index.js";
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: options.packageMeta.name,
          version: options.packageMeta.version,
          description: options.packageMeta.description,
          openclaw: { extensions: ["./index.js"] },
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
      options?.pluginBody ?? `export default { id: "memory-core", kind: "memory", register() {} };`,
    dir: pluginDir,
    filename: pluginFilename,
  });
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

  return loadOpenClawPlugins({
    cache: false,
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
  const bundledDir = makeTempDir();
  writePlugin({
    id: "telegram",
    body: BUNDLED_TELEGRAM_PLUGIN_BODY,
    dir: bundledDir,
    filename: "telegram.js",
  });
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
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

function createEscapingEntryFixture(params: { id: string; sourceBody: string }) {
  const pluginDir = makeTempDir();
  const outsideDir = makeTempDir();
  const outsideEntry = path.join(outsideDir, "outside.js");
  const linkedEntry = path.join(pluginDir, "entry.js");
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

function createPluginSdkAliasFixture() {
  const root = makeTempDir();
  const srcFile = path.join(root, "src", "plugin-sdk", "index.ts");
  const distFile = path.join(root, "dist", "plugin-sdk", "index.js");
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.mkdirSync(path.dirname(distFile), { recursive: true });
  fs.writeFileSync(srcFile, "export {};\n", "utf-8");
  fs.writeFileSync(distFile, "export {};\n", "utf-8");
  return { root, srcFile, distFile };
}

afterEach(() => {
  if (prevBundledDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = prevBundledDir;
  }
});

afterAll(() => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

describe("loadOpenClawPlugins", () => {
  it("disables bundled plugins by default", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "bundled",
      body: `export default { id: "bundled", register() {} };`,
      dir: bundledDir,
      filename: "bundled.js",
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

    const enabledRegistry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["bundled"],
          entries: {
            bundled: { enabled: true },
          },
        },
      },
    });

    const enabled = enabledRegistry.plugins.find((entry) => entry.id === "bundled");
    expect(enabled?.status).toBe("loaded");
  });

  it("loads bundled telegram plugin when enabled", () => {
    setupBundledTelegramPlugin();

    const registry = loadOpenClawPlugins({
      cache: false,
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

  it("enables bundled memory plugin when selected by slot", () => {
    const registry = loadBundledMemoryPluginRegistry();

    const memory = registry.plugins.find((entry) => entry.id === "memory-core");
    expect(memory?.status).toBe("loaded");
  });

  it("preserves package.json metadata for bundled memory plugins", () => {
    const registry = loadBundledMemoryPluginRegistry({
      packageMeta: {
        name: "@openclaw/memory-core",
        version: "1.2.3",
        description: "Memory plugin package",
      },
      pluginBody:
        'export default { id: "memory-core", kind: "memory", name: "Memory (Core)", register() {} };',
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
      body: `export default { id: "allowed", register(api) { api.registerGatewayMethod("allowed.ping", ({ respond }) => respond(true, { ok: true })); } };`,
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

  it("re-initializes global hook runner when serving registry from cache", () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "cache-hook-runner",
      body: `export default { id: "cache-hook-runner", register() {} };`,
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

  it("loads plugins when source and root differ only by realpath alias", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "alias-safe",
      body: `export default { id: "alias-safe", register() {} };`,
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
      body: `export default { id: "blocked", register() {} };`,
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
      body: `export default { id: "configurable", register() {} };`,
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

  it("registers channel plugins", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "channel-demo",
      body: `export default { id: "channel-demo", register(api) {
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

  it("registers http handlers", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "http-demo",
      body: `export default { id: "http-demo", register(api) {
  api.registerHttpHandler(async () => false);
} };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["http-demo"],
      },
    });

    const handler = registry.httpHandlers.find((entry) => entry.pluginId === "http-demo");
    expect(handler).toBeDefined();
    const httpPlugin = registry.plugins.find((entry) => entry.id === "http-demo");
    expect(httpPlugin?.httpHandlers).toBe(1);
  });

  it("registers http routes", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "http-route-demo",
      body: `export default { id: "http-route-demo", register(api) {
  api.registerHttpRoute({ path: "/demo", handler: async (_req, res) => { res.statusCode = 200; res.end("ok"); } });
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
    const httpPlugin = registry.plugins.find((entry) => entry.id === "http-route-demo");
    expect(httpPlugin?.httpHandlers).toBe(1);
  });

  it("respects explicit disable in config", () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      id: "config-disable",
      body: `export default { id: "config-disable", register() {} };`,
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

  it("enforces memory slot selection", () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const memoryA = writePlugin({
      id: "memory-a",
      body: `export default { id: "memory-a", kind: "memory", register() {} };`,
    });
    const memoryB = writePlugin({
      id: "memory-b",
      body: `export default { id: "memory-b", kind: "memory", register() {} };`,
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

  it("disables memory plugins when slot is none", () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const memory = writePlugin({
      id: "memory-off",
      body: `export default { id: "memory-off", kind: "memory", register() {} };`,
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
      body: `export default { id: "shadow", register() {} };`,
      dir: bundledDir,
      filename: "shadow.js",
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const override = writePlugin({
      id: "shadow",
      body: `export default { id: "shadow", register() {} };`,
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
      body: `export default { id: "feishu", register() {} };`,
      dir: bundledDir,
      filename: "index.js",
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const stateDir = makeTempDir();
    withEnv({ OPENCLAW_STATE_DIR: stateDir, CLAWDBOT_STATE_DIR: undefined }, () => {
      const globalDir = path.join(stateDir, "extensions", "feishu");
      fs.mkdirSync(globalDir, { recursive: true });
      writePlugin({
        id: "feishu",
        body: `export default { id: "feishu", register() {} };`,
        dir: globalDir,
        filename: "index.js",
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

  it("warns when plugins.allow is empty and non-bundled plugins are discoverable", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "warn-open-allow",
      body: `export default { id: "warn-open-allow", register() {} };`,
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

  it("warns when loaded non-bundled plugin has no install/load-path provenance", () => {
    useNoBundledPlugins();
    const stateDir = makeTempDir();
    withEnv({ OPENCLAW_STATE_DIR: stateDir, CLAWDBOT_STATE_DIR: undefined }, () => {
      const globalDir = path.join(stateDir, "extensions", "rogue");
      fs.mkdirSync(globalDir, { recursive: true });
      writePlugin({
        id: "rogue",
        body: `export default { id: "rogue", register() {} };`,
        dir: globalDir,
        filename: "index.js",
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

  it("rejects plugin entry files that escape plugin root via symlink", () => {
    useNoBundledPlugins();
    const { outsideEntry, linkedEntry } = createEscapingEntryFixture({
      id: "symlinked",
      sourceBody:
        'export default { id: "symlinked", register() { throw new Error("should not run"); } };',
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
        'export default { id: "hardlinked", register() { throw new Error("should not run"); } };',
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

  it("prefers dist plugin-sdk alias when loader runs from dist", () => {
    const { root, distFile } = createPluginSdkAliasFixture();

    const resolved = __testing.resolvePluginSdkAliasFile({
      srcFile: "index.ts",
      distFile: "index.js",
      modulePath: path.join(root, "dist", "plugins", "loader.js"),
    });
    expect(resolved).toBe(distFile);
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
});
