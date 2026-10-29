import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../plugins/bundled-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/bundled-dir.js")>();
  return {
    ...actual,
    resolveBundledPluginsDir: (env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? actual.resolveBundledPluginsDir(env),
  };
});

const tempDirs: string[] = [];

function makeBundledRoot(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  const pluginsDir = path.join(root, "dist", "extensions");
  fs.mkdirSync(pluginsDir, { recursive: true });
  return pluginsDir;
}

function plugin(id: string, label: string) {
  return { id, meta: { id, label }, capabilities: {}, config: {} };
}

function loadBootstrap(scope: string) {
  return importFreshModule<typeof import("./bootstrap-registry.js")>(
    import.meta.url,
    `./bootstrap-registry.js?scope=${scope}`,
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock("../../plugins/channel-catalog-registry.js");
  vi.doUnmock("./bundled.js");
});

it("reads bundled channel ids from the active bundled root without re-importing", async () => {
  const rootA = makeBundledRoot("openclaw-bundled-ids-a-");
  const rootB = makeBundledRoot("openclaw-bundled-ids-b-");

  // mock-isolation: Synthetic catalog rows isolate root-cache invalidation from plugin discovery.
  vi.doMock("../../plugins/channel-catalog-registry.js", () => ({
    listChannelCatalogEntries: (params?: { env?: NodeJS.ProcessEnv }) => {
      const activeRoot = params?.env?.OPENCLAW_BUNDLED_PLUGINS_DIR;
      if (activeRoot === rootA) {
        return [{ pluginId: "alpha", channel: { id: "alpha-chat" } }];
      }
      if (activeRoot === rootB) {
        return [{ pluginId: "beta", channel: { id: "beta-chat" } }];
      }
      return [];
    },
  }));

  const bundledIds = await importFreshModule<typeof import("./bundled-ids.js")>(
    import.meta.url,
    "./bundled-ids.js?scope=root-aware-id-cache",
  );

  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", rootA);
  expect(bundledIds.listBundledChannelIds()).toEqual(["alpha-chat"]);

  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", rootB);
  expect(bundledIds.listBundledChannelIds()).toEqual(["beta-chat"]);
});

it("reads bootstrap plugins from the active bundled root without re-importing", async () => {
  const rootA = makeBundledRoot("openclaw-bootstrap-a-");
  const rootB = makeBundledRoot("openclaw-bootstrap-b-");
  const suffix = () => {
    const activeRoot = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    return activeRoot === rootA ? "A" : activeRoot === rootB ? "B" : "unknown";
  };

  // mock-isolation: Synthetic bundled plugins isolate cache invalidation from runtime loading.
  vi.doMock("./bundled.js", () => ({
    getBundledChannelPlugin: (id: string) => plugin(id, `runtime-${id}`),
    getBundledChannelSetupPlugin: (id: string) => plugin(id, `setup-${suffix()}`),
    getBundledChannelSecrets: (id: string) => ({
      secretTargetRegistryEntries: [{ id: `runtime-${id}`, targetType: "channel" }],
    }),
    getBundledChannelSetupSecrets: (id: string) => ({
      secretTargetRegistryEntries: [{ id: `setup-${id}-${suffix()}`, targetType: "channel" }],
    }),
  }));

  const bootstrapRegistry = await loadBootstrap("root-aware-bootstrap-cache");

  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", rootA);
  expect(bootstrapRegistry.getBootstrapChannelPlugin("alpha")?.meta.label).toBe("setup-A");
  expect(
    bootstrapRegistry.getBootstrapChannelSecrets("alpha")?.secretTargetRegistryEntries?.[0]?.id,
  ).toBe("setup-alpha-A");

  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", rootB);
  expect(bootstrapRegistry.getBootstrapChannelPlugin("beta")?.meta.label).toBe("setup-B");
  expect(
    bootstrapRegistry.getBootstrapChannelSecrets("beta")?.secretTargetRegistryEntries?.[0]?.id,
  ).toBe("setup-beta-B");
});

it.each(["plugin", "secrets"] as const)(
  "retries %s errors without poisoning the other lookup",
  async (failing) => {
    const getPlugin = vi.fn(() => {
      if (failing === "plugin") {
        throw new Error("Cannot find module 'nostr-tools'");
      }
      return plugin("alpha", "Alpha");
    });
    const getSecrets = vi.fn(() => {
      throw new Error(
        failing === "plugin"
          ? "secrets should not load after plugin is marked missing"
          : "Cannot find module '@larksuiteoapi/node-sdk'",
      );
    });
    // mock-isolation: Synthetic bundled plugins isolate cache invalidation from runtime loading.
    vi.doMock("./bundled.js", () => ({
      getBundledChannelPlugin: getPlugin,
      getBundledChannelSetupPlugin: vi.fn(() => undefined),
      getBundledChannelSecrets: getSecrets,
      getBundledChannelSetupSecrets: vi.fn(() => undefined),
    }));
    const registry = await loadBootstrap(`bootstrap-${failing}-load-guard`);
    const failingLookup =
      failing === "plugin"
        ? registry.getBootstrapChannelPlugin
        : registry.getBootstrapChannelSecrets;
    expect(failingLookup("alpha")).toBeUndefined();
    expect(failingLookup("alpha")).toBeUndefined();
    if (failing === "plugin") {
      expect(registry.getBootstrapChannelSecrets("alpha")).toBeUndefined();
    } else {
      expect(registry.getBootstrapChannelPlugin("alpha")).toEqual({
        id: "alpha",
        meta: { id: "alpha", label: "Alpha" },
        capabilities: {},
        config: {},
      });
    }
    expect(getPlugin).toHaveBeenCalledTimes(failing === "plugin" ? 2 : 1);
    expect(getSecrets).toHaveBeenCalledTimes(failing === "plugin" ? 1 : 2);
  },
);
