import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalTrustBundledPluginsDirForTest =
  process.env.OPENCLAW_TRUST_BUNDLED_PLUGINS_DIR_FOR_TEST;

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-loader-"));
  tempDirs.push(dir);
  return dir;
}

function writeBundledPluginFixture(id: string) {
  const pluginRoot = makeTempDir();
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id,
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "index.cjs"),
    `module.exports = { id: ${JSON.stringify(id)}, register() {} };`,
    "utf-8",
  );
  return pluginRoot;
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./jiti-loader-cache.js");
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalTrustBundledPluginsDirForTest === undefined) {
    delete process.env.OPENCLAW_TRUST_BUNDLED_PLUGINS_DIR_FOR_TEST;
  } else {
    process.env.OPENCLAW_TRUST_BUNDLED_PLUGINS_DIR_FOR_TEST = originalTrustBundledPluginsDirForTest;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createPluginJitiLoader", () => {
  it("uses the bundled plugin module path as the jiti filename", async () => {
    const jitiLoaderCalls: Array<{ modulePath: string; jitiFilename?: string }> = [];
    vi.doMock("./jiti-loader-cache.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./jiti-loader-cache.js")>();
      return {
        ...actual,
        getCachedPluginJitiLoader: vi.fn((params) => {
          jitiLoaderCalls.push({
            modulePath: params.modulePath,
            jitiFilename: params.jitiFilename,
          });
          return vi.fn(() => ({
            default: {
              id: "demo",
              register() {},
            },
          }));
        }),
      };
    });

    const { loadOpenClawPlugins } = await importFreshModule<typeof import("./loader.js")>(
      import.meta.url,
      "./loader.js?scope=jiti-filename",
    );

    const pluginRoot = writeBundledPluginFixture("demo");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = pluginRoot;
    process.env.OPENCLAW_TRUST_BUNDLED_PLUGINS_DIR_FOR_TEST = "1";

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: pluginRoot,
      onlyPluginIds: ["demo"],
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: true,
            },
          },
        },
      },
    });

    const bundledPluginLoad = jitiLoaderCalls.find((call) => call.modulePath.endsWith("index.cjs"));
    expect(bundledPluginLoad).toBeDefined();
    expect(bundledPluginLoad?.jitiFilename).toBe(bundledPluginLoad?.modulePath);
  });
});
