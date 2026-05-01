import fs from "node:fs";
import path from "node:path";
import { bundledDistPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { stageBundledPluginRuntime } from "../../scripts/stage-bundled-plugin-runtime.mjs";
import {
  clearBundledRuntimeDependencyJitiAliases,
  registerBundledRuntimeDependencyJitiAliases,
} from "./bundled-runtime-deps-jiti-aliases.js";
import type { PluginJitiLoaderCache } from "./jiti-loader-cache.js";
import { loadPluginBoundaryModuleWithJiti } from "./runtime/runtime-plugin-boundary.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

type LightModule = {
  getActiveWebListener: (accountId?: string | null) => unknown;
};

type HeavyModule = {
  registerControllerForTest: (
    accountId: string | null | undefined,
    listener: { sendMessage: () => Promise<{ messageId: string }> } | null,
  ) => void;
};

const tempDirs: string[] = [];

function writeRuntimeFixtureText(rootDir: string, relativePath: string, value: string) {
  fs.mkdirSync(path.dirname(path.join(rootDir, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(rootDir, relativePath), value, "utf8");
}

function createBundledWhatsAppRuntimeFixture() {
  const rootDir = makeTrackedTempDir("openclaw-whatsapp-boundary", tempDirs);
  for (const [relativePath, value] of Object.entries({
    "package.json": JSON.stringify(
      {
        name: "openclaw",
        type: "module",
        bin: {
          openclaw: "openclaw.mjs",
        },
        exports: {
          "./plugin-sdk": {
            default: "./dist/plugin-sdk/index.js",
          },
        },
      },
      null,
      2,
    ),
    "openclaw.mjs": "export {};\n",
    [bundledDistPluginFile("whatsapp", "index.js")]: "export default {};\n",
    [bundledDistPluginFile("whatsapp", "light-runtime-api.js")]:
      'export { getActiveWebListener } from "../../active-listener.js";\n',
    [bundledDistPluginFile("whatsapp", "runtime-api.js")]:
      'export { registerControllerForTest } from "../../connection-controller-registry.js";\n',
    "dist/connection-controller-registry.js": [
      'const key = Symbol.for("openclaw.whatsapp.connectionControllerRegistry");',
      "const g = globalThis;",
      "if (!g[key]) {",
      "  g[key] = { controllers: new Map() };",
      "}",
      "const state = g[key];",
      "export function getRegisteredWhatsAppConnectionController(accountId) {",
      "  return state.controllers.get(accountId) ?? null;",
      "}",
      "export function registerControllerForTest(accountId, listener) {",
      '  const id = accountId ?? "default";',
      "  if (!listener) {",
      "    state.controllers.delete(id);",
      "    return;",
      "  }",
      "  state.controllers.set(id, {",
      "    getActiveListener() {",
      "      return listener;",
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
    "dist/active-listener.js": [
      'import { getRegisteredWhatsAppConnectionController } from "./connection-controller-registry.js";',
      "export function getActiveWebListener(accountId) {",
      '  return getRegisteredWhatsAppConnectionController(accountId ?? "default")?.getActiveListener() ?? null;',
      "}",
      "",
    ].join("\n"),
  })) {
    writeRuntimeFixtureText(rootDir, relativePath, value);
  }
  stageBundledPluginRuntime({ repoRoot: rootDir });

  return path.join(rootDir, "dist-runtime", "extensions", "whatsapp");
}

function loadWhatsAppBoundaryModules(runtimePluginDir: string) {
  const loaders: PluginJitiLoaderCache = new Map();
  return {
    light: loadPluginBoundaryModuleWithJiti<LightModule>(
      path.join(runtimePluginDir, "light-runtime-api.js"),
      loaders,
    ),
    heavy: loadPluginBoundaryModuleWithJiti<HeavyModule>(
      path.join(runtimePluginDir, "runtime-api.js"),
      loaders,
    ),
  };
}

function createListener(messageId = "msg-1") {
  return {
    sendMessage: async () => ({ messageId }),
  };
}

function expectSharedWhatsAppListenerState(runtimePluginDir: string, accountId: string) {
  const { light, heavy } = loadWhatsAppBoundaryModules(runtimePluginDir);
  const listener = createListener();

  heavy.registerControllerForTest(accountId, listener);
  expect(light.getActiveWebListener(accountId)).toBe(listener);
  heavy.registerControllerForTest(accountId, null);
}

afterEach(() => {
  clearBundledRuntimeDependencyJitiAliases();
  cleanupTrackedTempDirs(tempDirs);
});

describe("runtime plugin boundary whatsapp seam", () => {
  it("shares listener state between staged light and heavy runtime modules", () => {
    expectSharedWhatsAppListenerState(createBundledWhatsAppRuntimeFixture(), "work");
  });

  it("resolves staged root runtime dependency aliases while loading boundary modules", () => {
    const packageRoot = makeTrackedTempDir("openclaw-runtime-boundary-alias", tempDirs);
    const stageRoot = makeTrackedTempDir("openclaw-runtime-boundary-deps", tempDirs);
    writeRuntimeFixtureText(
      packageRoot,
      "package.json",
      JSON.stringify(
        {
          name: "openclaw",
          type: "module",
          bin: {
            openclaw: "openclaw.mjs",
          },
          exports: {
            "./plugin-sdk": {
              default: "./dist/plugin-sdk/index.js",
            },
          },
        },
        null,
        2,
      ),
    );
    writeRuntimeFixtureText(packageRoot, "openclaw.mjs", "export {};\n");
    writeRuntimeFixtureText(
      packageRoot,
      bundledDistPluginFile("acpx", "runtime-api.js"),
      'export { marker } from "../../root-runtime-chunk.js";\n',
    );
    writeRuntimeFixtureText(
      packageRoot,
      "dist/root-runtime-chunk.js",
      'import { marker as depMarker } from "package-only-runtime-dep";\nexport const marker = depMarker;\n',
    );
    stageBundledPluginRuntime({ repoRoot: packageRoot });

    writeRuntimeFixtureText(
      stageRoot,
      "package.json",
      JSON.stringify({
        dependencies: {
          "package-only-runtime-dep": "1.0.0",
        },
      }),
    );
    writeRuntimeFixtureText(
      stageRoot,
      "node_modules/package-only-runtime-dep/package.json",
      JSON.stringify({
        name: "package-only-runtime-dep",
        version: "1.0.0",
        exports: {
          ".": "./index.js",
        },
        type: "module",
      }),
    );
    writeRuntimeFixtureText(
      stageRoot,
      "node_modules/package-only-runtime-dep/index.js",
      'export const marker = "staged-runtime-dep";\n',
    );
    registerBundledRuntimeDependencyJitiAliases(stageRoot);

    const loaders: PluginJitiLoaderCache = new Map();
    const loaded = loadPluginBoundaryModuleWithJiti<{ marker: string }>(
      path.join(packageRoot, "dist-runtime", "extensions", "acpx", "runtime-api.js"),
      loaders,
    );

    expect(loaded.marker).toBe("staged-runtime-dep");
  });
});
