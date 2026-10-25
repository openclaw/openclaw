import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginModuleLoaderFactory } from "../plugins/plugin-module-loader-cache.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import {
  defineBundledChannelEntry,
  defineBundledChannelSetupEntry,
  loadBundledEntryExportSync,
} from "./channel-entry-contract.js";
import type { BundledEntryModuleLoadOptions } from "./channel-entry-contract.types.js";
import {
  createChannelEntryApi as createApi,
  expectLazyChannelSchema,
  registerChannelEntryTestTool,
} from "./channel-entry.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function writeJson(targetPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeFile(root: string, name: string, contents: string) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

function createSidecarRoot(artifactRoot = "dist", pluginId = "fixture", importer = "index.js") {
  const tempRoot = tempDirs.make("openclaw-channel-entry-contract-");
  const pluginRoot = path.join(tempRoot, artifactRoot, "extensions", pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  const importerPath = path.join(pluginRoot, importer);
  fs.writeFileSync(importerPath, "export default {};\n", "utf8");
  return {
    tempRoot,
    pluginRoot,
    importerPath,
    url: pathToFileURL(importerPath).href,
    write: (name: string, contents: string) => writeFile(pluginRoot, name, contents),
  };
}

function createBundledFixture() {
  const fixture = createSidecarRoot();
  const { tempRoot, write } = fixture;
  const runtimeMarker = path.join(tempRoot, "runtime-loaded");
  const pluginId = "fixture";
  write(
    "plugin.cjs",
    `module.exports = {
  channelPlugin: {
    id: ${JSON.stringify(pluginId)},
  },
};
`,
  );
  write(
    "runtime.cjs",
    `module.exports = {
  setRuntime: () => {
    require("node:fs").writeFileSync(${JSON.stringify(runtimeMarker)}, "loaded", "utf8");
  },
};
`,
  );
  return { ...fixture, pluginId, runtimeMarker };
}

function sidecarLoader(url: string) {
  return (specifier: string, exportName = "sentinel", options?: BundledEntryModuleLoadOptions) =>
    loadBundledEntryExportSync<number>(url, { specifier, exportName }, options);
}

function createBundledChannelEntry() {
  const fixture = createBundledFixture();
  const hooks = {
    registerCliMetadata: vi.fn<(api: OpenClawPluginApi) => void>(),
    registerFull: vi.fn<(api: OpenClawPluginApi) => void>(),
    registerCapabilities: vi.fn<(api: OpenClawPluginApi) => void>(),
  };
  const entry = defineBundledChannelEntry({
    id: fixture.pluginId,
    name: fixture.pluginId,
    description: "bundled channel entry test",
    importMetaUrl: fixture.url,
    plugin: { specifier: "./plugin.cjs", exportName: "channelPlugin" },
    runtime: { specifier: "./runtime.cjs", exportName: "setRuntime" },
    ...hooks,
  });
  return { entry, ...fixture, ...hooks };
}

describe("defineBundledChannelEntry", () => {
  it("defers and memoizes config schema factories", () => {
    expectLazyChannelSchema((configSchema) =>
      defineBundledChannelEntry({
        id: "lazy-config-schema",
        name: "Lazy Config Schema",
        description: "lazy config schema test",
        importMetaUrl: import.meta.url,
        plugin: { specifier: "./unused.js" },
        configSchema,
      }),
    );
  });

  it.each([
    ["cli-metadata", 0, 1, 0, 0],
    ["tool-discovery", 0, 0, 1, 1],
    ["discovery", 1, 1, 0, 1],
    ["setup-only", 1, 0, 0, 0],
    ["setup-runtime", 1, 0, 0, 0],
    ["full", 1, 1, 1, 1],
  ] as const)(
    "hydrates sidecars and registers only %s hooks",
    (mode, runtime, cli, full, capabilities) => {
      const { entry, runtimeMarker, registerCliMetadata, registerCapabilities, registerFull } =
        createBundledChannelEntry();
      registerFull.mockImplementation(registerChannelEntryTestTool);

      const api = createApi(mode);
      entry.register(api);
      expect(api.registerChannel).toHaveBeenCalledTimes(runtime);
      expect(registerCliMetadata.mock.calls).toEqual(cli ? [[api]] : []);
      expect(registerFull.mock.calls).toEqual(full ? [[api]] : []);
      expect(registerCapabilities.mock.calls).toEqual(capabilities ? [[api]] : []);
      expect(api.registerTool).toHaveBeenCalledTimes(full);
      expect(fs.existsSync(runtimeMarker)).toBe(Boolean(runtime));
    },
  );
});

it("defineBundledChannelSetupEntry exposes setup-runtime without the full channel entry", () => {
  const setupRuntimeRegister = vi.fn<(api: OpenClawPluginApi) => void>();
  const { url, pluginId, runtimeMarker } = createBundledFixture();
  const entry = defineBundledChannelSetupEntry({
    importMetaUrl: url,
    plugin: { specifier: "./plugin.cjs", exportName: "channelPlugin" },
    runtime: { specifier: "./runtime.cjs", exportName: "setRuntime" },
    registerSetupRuntime: setupRuntimeRegister,
  });

  const api = createApi("setup-runtime");
  expect(entry.loadSetupPlugin().id).toBe(pluginId);
  entry.setChannelRuntime?.(api.runtime);
  entry.registerSetupRuntime?.(api);

  expect(fs.existsSync(runtimeMarker)).toBe(true);
  expect(setupRuntimeRegister).toHaveBeenCalledWith(api);
});

function runCompiledEsmSidecarFastPathProbe(): SpawnSyncReturns<string> {
  const { tempRoot, write, url } = createSidecarRoot("dist", "slack");
  const probePath = path.join(tempRoot, "probe.mjs");
  const channelEntryContractModuleUrl = pathToFileURL(
    path.join(process.cwd(), "src", "plugin-sdk", "channel-entry-contract.ts"),
  ).href;

  writeJson(path.join(tempRoot, "package.json"), {
    name: "openclaw",
    type: "module",
    bin: { openclaw: "./openclaw.mjs" },
    exports: {
      "./plugin-sdk/channel-outbound": "./dist/plugin-sdk/channel-outbound.js",
    },
  });
  writeFile(tempRoot, "openclaw.mjs", "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(tempRoot, "src"));
  fs.mkdirSync(path.join(tempRoot, "extensions"));
  writeFile(
    tempRoot,
    "dist/plugin-sdk/channel-outbound.js",
    'export const defineChannelMessageAdapter = () => "adapter";\n',
  );

  write(
    "sidecar.js",
    'import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";\nexport const sentinel = defineChannelMessageAdapter();\n',
  );

  writeFile(
    tempRoot,
    "probe.mjs",
    [
      `import { loadBundledEntryExportSync } from ${JSON.stringify(channelEntryContractModuleUrl)};`,
      `const value = loadBundledEntryExportSync(${JSON.stringify(url)}, {`,
      '  specifier: "./sidecar.js",',
      '  exportName: "sentinel",',
      "});",
      "console.log(value);",
      "",
    ].join("\n"),
  );

  return spawnSync(process.execPath, ["--import", "tsx", probePath], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_DIAGNOSTICS: "plugin.load-profile",
      OPENCLAW_DEV_SOURCE_ROOT: tempRoot,
    },
  });
}

describe("loadBundledEntryExportSync", () => {
  it("includes importer and resolved path context when a bundled sidecar is missing", () => {
    const { pluginRoot, importerPath, url } = createSidecarRoot();

    let thrown: unknown;
    try {
      loadBundledEntryExportSync(url, {
        specifier: "./src/secret-contract.js",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('bundled plugin entry "./src/secret-contract.js" failed to open');
    expect(message).toContain(`from "${importerPath}"`);
    expect(message).toContain(`resolved "${path.join(pluginRoot, "src", "secret-contract.js")}"`);
    expect(message).toContain(`plugin root "${pluginRoot}"`);
    expect(message).toContain('reason "path"');
    expect(message).toContain("ENOENT");
  });

  it("does not replay a failed native sidecar through the plugin transformer", () => {
    const { tempRoot, url, write } = createSidecarRoot("dist", "fixture", "setup-entry.cjs");
    const evaluations = path.join(tempRoot, "evaluations.txt");
    write("setup-entry.cjs", "module.exports = {};\n");
    write(
      "sidecar.cjs",
      `require("node:fs").appendFileSync(${JSON.stringify(evaluations)}, "evaluation\\n");
       throw new Error("sidecar initialization failed");`,
    );

    expect(() =>
      loadBundledEntryExportSync(url, {
        specifier: "./sidecar.cjs",
      }),
    ).toThrow("sidecar initialization failed");
    expect(fs.readFileSync(evaluations, "utf8")).toBe("evaluation\n");
  });

  it("reuses resolved bundled sidecars after their file disappears", () => {
    const { pluginRoot, url, write } = createSidecarRoot();
    const helperPath = path.join(pluginRoot, "helper.cjs");
    write("helper.cjs", "module.exports = { sentinel: 42 };\n");

    const load = sidecarLoader(url);
    expect(load("./helper.cjs")).toBe(42);
    fs.unlinkSync(helperPath);
    expect(load("./helper.cjs")).toBe(42);
  });

  it("keeps dist-runtime built sidecar loads on the nodeRequire fast-path", () => {
    const { write, url } = createSidecarRoot("dist-runtime");
    write("fast-path-sidecar.cjs", "module.exports = { sentinel: 7 };\n");
    const createLoaderForTest: PluginModuleLoaderFactory = () => {
      throw new Error("Built sidecars must not need the source loader");
    };
    expect(sidecarLoader(url)("./fast-path-sidecar.cjs", "sentinel", { createLoaderForTest })).toBe(
      7,
    );
  });

  it("keeps compiled ESM sidecars with SDK imports on the nodeRequire fast-path", async () => {
    const result = runCompiledEsmSidecarFastPathProbe();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("adapter");
    expect(result.stderr).toMatch(/sourceLoaderCreateMs=0(?:\.0+)?(?:\s|$)/u);
    expect(result.stderr).toMatch(/sourceLoaderCallMs=0(?:\.0+)?(?:\s|$)/u);
  });

  it("preserves presence-based source fallback disable semantics and cache modes", () => {
    const { tempRoot, pluginRoot, url } = createSidecarRoot();
    writeJson(path.join(tempRoot, "package.json"), { name: "openclaw" });
    const sourceRoot = path.join(tempRoot, "extensions", "fixture", "src");
    writeFile(sourceRoot, "secret-contract.ts", "export const sentinel = 42;\n");

    const load = sidecarLoader(url);
    const loadSecretContract = () => load("./src/secret-contract.js");

    expect(loadSecretContract()).toBe(42);

    for (const value of ["", "enabled"]) {
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK", value);
      expect(loadSecretContract).toThrow(
        `resolved "${path.join(pluginRoot, "src", "secret-contract.js")}"`,
      );
    }

    for (const value of [" 0 ", " FALSE "]) {
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK", value);
      expect(loadSecretContract()).toBe(42);
    }
  });
});
