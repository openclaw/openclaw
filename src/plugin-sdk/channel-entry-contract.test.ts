import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeJsonFile as writeJson } from "../../test/helpers/temp-repo.js";
import type { PluginModuleLoaderFactory } from "../plugins/plugin-module-loader-cache.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import {
  defineBundledChannelEntry,
  defineBundledChannelSetupEntry,
  loadBundledEntryExportSync,
} from "./channel-entry-contract.js";
import {
  createChannelEntryApi as createApi,
  expectLazyChannelSchema,
  registerChannelEntryTestTool,
} from "./channel-entry.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const pluginModuleLoaderJitiFactoryOverrideKey = Symbol.for(
  "openclaw.pluginModuleLoaderJitiFactoryOverride",
);
const loaderGlobals = globalThis as typeof globalThis & {
  [pluginModuleLoaderJitiFactoryOverrideKey]?: PluginModuleLoaderFactory;
};

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("jiti");
  vi.doUnmock("../plugins/native-module-require.js");
  vi.unstubAllEnvs();
  delete loaderGlobals[pluginModuleLoaderJitiFactoryOverrideKey];
});

function stubPluginModuleLoaderJitiFactory(createJiti: PluginModuleLoaderFactory): void {
  loaderGlobals[pluginModuleLoaderJitiFactoryOverrideKey] = createJiti;
}

function writeFile(root: string, name: string, contents: string) {
  fs.writeFileSync(path.join(root, name), contents, "utf8");
}

const freshContract = (scope: string) =>
  importFreshModule<typeof import("./channel-entry-contract.js")>(
    import.meta.url,
    `./channel-entry-contract.js?scope=${scope}`,
  );

function createSidecarRoot(artifactRoot = "dist", pluginId = "fixture", importer = "index.js") {
  const tempRoot = tempDirs.make("openclaw-channel-entry-contract-");
  const pluginRoot = path.join(tempRoot, artifactRoot, "extensions", pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  const importerPath = path.join(pluginRoot, importer);
  fs.writeFileSync(importerPath, "export default {};\n", "utf8");
  return { tempRoot, pluginRoot, importerPath };
}

function createBundledFixture() {
  const { tempRoot, pluginRoot, importerPath } = createSidecarRoot();
  const runtimeMarker = path.join(tempRoot, "runtime-loaded");
  const pluginId = "fixture";
  fs.writeFileSync(
    path.join(pluginRoot, "plugin.cjs"),
    `module.exports = {
  channelPlugin: {
    id: ${JSON.stringify(pluginId)},
  },
};
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "runtime.cjs"),
    `module.exports = {
  setRuntime: () => {
    require("node:fs").writeFileSync(${JSON.stringify(runtimeMarker)}, "loaded", "utf8");
  },
};
`,
    "utf8",
  );
  return { importerPath, pluginId, runtimeMarker };
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
    importMetaUrl: pathToFileURL(fixture.importerPath).href,
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
  const { importerPath, pluginId, runtimeMarker } = createBundledFixture();
  const entry = defineBundledChannelSetupEntry({
    importMetaUrl: pathToFileURL(importerPath).href,
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

async function expectBuiltArtifactNodeRequireFastPath(
  scope: string,
  artifactRoot = "dist",
): Promise<void> {
  vi.stubEnv("OPENCLAW_DIAGNOSTICS", "plugin.load-profile");
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

  try {
    const channelEntryContract = await freshContract(scope);

    const { pluginRoot, importerPath } = createSidecarRoot(artifactRoot);
    const sidecarPath = path.join(pluginRoot, "fast-path-sidecar.cjs");
    // CommonJS so `nodeRequire` succeeds without falling back to the source loader, even
    // inside built plugin artifacts with a `type: "module"` package boundary.
    fs.writeFileSync(sidecarPath, "module.exports = { sentinel: 7 };\n", "utf8");

    expect(
      channelEntryContract.loadBundledEntryExportSync<number>(pathToFileURL(importerPath).href, {
        specifier: "./fast-path-sidecar.cjs",
        exportName: "sentinel",
      }),
    ).toBe(7);

    const profileLine = errorSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .find((line) => line.startsWith("[plugin-load-profile] phase=bundled-entry-module-load"));
    if (profileLine === undefined) {
      throw new Error("expected a bundled-entry-module-load profile line");
    }
    expect(profileLine).toMatch(/sourceLoaderCreateMs=\d/u);
    expect(profileLine).toMatch(/sourceLoaderCallMs=\d/u);
    expect(profileLine).not.toMatch(/sourceLoaderCreateMs=-/);
    expect(profileLine).not.toMatch(/sourceLoaderCallMs=-/);
  } finally {
    errorSpy.mockRestore();
  }
}

function runCompiledEsmSidecarFastPathProbe(): SpawnSyncReturns<string> {
  const tempRoot = tempDirs.make("openclaw-channel-entry-contract-");
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
  fs.mkdirSync(path.join(tempRoot, "dist", "plugin-sdk"), { recursive: true });
  writeFile(
    tempRoot,
    "dist/plugin-sdk/channel-outbound.js",
    'export const defineChannelMessageAdapter = () => "adapter";\n',
  );

  const pluginRoot = path.join(tempRoot, "dist", "extensions", "slack");
  fs.mkdirSync(pluginRoot, { recursive: true });
  const importerPath = path.join(pluginRoot, "index.js");
  fs.writeFileSync(importerPath, "export default {};\n", "utf8");
  writeFile(
    pluginRoot,
    "sidecar.js",
    'import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";\nexport const sentinel = defineChannelMessageAdapter();\n',
  );

  writeFile(
    tempRoot,
    "probe.mjs",
    [
      `import { loadBundledEntryExportSync } from ${JSON.stringify(channelEntryContractModuleUrl)};`,
      `const value = loadBundledEntryExportSync(${JSON.stringify(pathToFileURL(importerPath).href)}, {`,
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
    const { pluginRoot, importerPath } = createSidecarRoot();

    let thrown: unknown;
    try {
      loadBundledEntryExportSync(pathToFileURL(importerPath).href, {
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

  it("normalizes Windows absolute sidecar paths before module loads them", async () => {
    const tempRoot = tempDirs.make("openclaw-channel-entry-contract-");
    const openedFdPath = path.join(tempRoot, "opened");
    fs.writeFileSync(openedFdPath, "opened\n", "utf8");
    const importerUrl = "file:///C:/Users/alice/openclaw/dist/extensions/feishu/index.js";
    const sidecarPath = path.resolve(path.dirname(fileURLToPath(importerUrl)), "helper.ts");
    const jitiLoad = vi.fn(() => ({ load: 42 }));
    const createJiti = vi.fn(() => jitiLoad);
    vi.doMock("../infra/boundary-file-read.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../infra/boundary-file-read.js")>();
      return {
        ...actual,
        openRootFileSync: (params: Parameters<typeof actual.openRootFileSync>[0]) => {
          if (params.absolutePath !== sidecarPath) {
            return actual.openRootFileSync(params);
          }
          const opened = actual.openRootFileSync({
            ...params,
            absolutePath: openedFdPath,
            rootPath: tempRoot,
          });
          return opened.ok
            ? {
                ...opened,
                path: "C:\\Users\\alice\\openclaw\\dist\\extensions\\feishu\\helper.ts",
              }
            : opened;
        },
      };
    });

    await withMockedWindowsPlatform(async () => {
      try {
        const channelEntryContract = await freshContract("windows-safe-jiti-path");

        expect(
          channelEntryContract.loadBundledEntryExportSync<number>(
            importerUrl,
            {
              specifier: "./helper.ts",
              exportName: "load",
            },
            { createLoaderForTest: createJiti as never },
          ),
        ).toBe(42);
        expect(jitiLoad).toHaveBeenCalledWith(
          "file:///C:/Users/alice/openclaw/dist/extensions/feishu/helper.ts",
        );
      } finally {
        vi.doUnmock("../infra/boundary-file-read.js");
        vi.doUnmock("jiti");
      }
    });
  });

  it("keeps the host SDK native when a built sidecar needs plugin transformation", async () => {
    const sourceLoad = vi.fn(() => ({ sentinel: 42 }));
    const createJiti = vi.fn((_filename: string, _options?: Record<string, unknown>) => sourceLoad);
    const { pluginRoot, importerPath } = createSidecarRoot();
    const sidecarPath = path.join(pluginRoot, "setup-plugin-api.js");
    fs.writeFileSync(sidecarPath, "export const sentinel = 42;\n", "utf8");
    vi.doMock("../plugins/native-module-require.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../plugins/native-module-require.js")>();
      return {
        ...actual,
        tryNativeRequireJavaScriptModule: (
          ...args: Parameters<typeof actual.tryNativeRequireJavaScriptModule>
        ) =>
          args[0] === sidecarPath
            ? { ok: false }
            : actual.tryNativeRequireJavaScriptModule(...args),
      };
    });
    const channelEntryContract = await freshContract("native-esm-race-fallback");

    expect(
      channelEntryContract.loadBundledEntryExportSync<number>(
        pathToFileURL(importerPath).href,
        {
          specifier: "./setup-plugin-api.js",
          exportName: "sentinel",
        },
        { createLoaderForTest: createJiti as never },
      ),
    ).toBe(42);
    expect(createJiti.mock.calls[0]?.[1]).toMatchObject({
      tryNative: false,
      nativeModules: ["openclaw"],
    });
    expect(sourceLoad).toHaveBeenCalledWith(sidecarPath);
  });

  it("does not replay a failed native sidecar through the plugin transformer", () => {
    const root = tempDirs.make("openclaw-channel-entry-failure-");
    const pluginRoot = path.join(root, "dist", "extensions", "fixture");
    fs.mkdirSync(pluginRoot, { recursive: true });
    const importerPath = path.join(pluginRoot, "setup-entry.cjs");
    const evaluations = path.join(root, "evaluations.txt");
    fs.writeFileSync(importerPath, "module.exports = {};\n");
    fs.writeFileSync(
      path.join(pluginRoot, "sidecar.cjs"),
      `require("node:fs").appendFileSync(${JSON.stringify(evaluations)}, "evaluation\\n");
       throw new Error("sidecar initialization failed");`,
    );

    expect(() =>
      loadBundledEntryExportSync(pathToFileURL(importerPath).href, {
        specifier: "./sidecar.cjs",
      }),
    ).toThrow("sidecar initialization failed");
    expect(fs.readFileSync(evaluations, "utf8")).toBe("evaluation\n");
  });

  it("reuses resolved bundled sidecar paths before cached module exports", async () => {
    const { pluginRoot, importerPath } = createSidecarRoot();
    const helperPath = path.join(pluginRoot, "helper.cjs");
    fs.writeFileSync(helperPath, "module.exports = { sentinel: 42 };\n", "utf8");

    const openRootFileSync =
      vi.fn<typeof import("../infra/boundary-file-read.js").openRootFileSync>();
    vi.doMock("../infra/boundary-file-read.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../infra/boundary-file-read.js")>();
      openRootFileSync.mockImplementation(actual.openRootFileSync);
      return { ...actual, openRootFileSync };
    });

    try {
      const channelEntryContract = await freshContract("resolved-sidecar-cache");

      const loadHelper = () =>
        channelEntryContract.loadBundledEntryExportSync<number>(pathToFileURL(importerPath).href, {
          specifier: "./helper.cjs",
          exportName: "sentinel",
        });
      expect(loadHelper()).toBe(42);
      expect(
        openRootFileSync.mock.calls.filter(([params]) => params.absolutePath === helperPath),
      ).toHaveLength(1);
      openRootFileSync.mockClear();
      expect(loadHelper()).toBe(42);
      expect(openRootFileSync).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../infra/boundary-file-read.js");
    }
  });

  it("keeps dist-runtime built sidecar loads on the nodeRequire fast-path", async () => {
    await expectBuiltArtifactNodeRequireFastPath("dist-runtime-profile-fast-path", "dist-runtime");
  });

  it("keeps compiled ESM sidecars with SDK imports on the nodeRequire fast-path", async () => {
    const result = runCompiledEsmSidecarFastPathProbe();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("adapter");
    expect(result.stderr).toMatch(/sourceLoaderCreateMs=0(?:\.0+)?(?:\s|$)/u);
    expect(result.stderr).toMatch(/sourceLoaderCallMs=0(?:\.0+)?(?:\s|$)/u);
  });

  it("preserves presence-based source fallback disable semantics and cache modes", () => {
    stubPluginModuleLoaderJitiFactory(
      vi.fn(() => vi.fn(() => ({ sentinel: 42 }))) as unknown as PluginModuleLoaderFactory,
    );
    const { tempRoot, pluginRoot, importerPath } = createSidecarRoot();
    writeJson(path.join(tempRoot, "package.json"), { name: "openclaw" });
    const sourceRoot = path.join(tempRoot, "extensions", "fixture", "src");
    fs.mkdirSync(sourceRoot, { recursive: true });
    writeFile(sourceRoot, "secret-contract.ts", "export const sentinel = 42;\n");

    const loadSecretContract = () =>
      loadBundledEntryExportSync<number>(pathToFileURL(importerPath).href, {
        specifier: "./src/secret-contract.js",
        exportName: "sentinel",
      });

    expect(loadSecretContract()).toBe(42);

    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK", "enabled");
    expect(loadSecretContract).toThrow(
      `resolved "${path.join(pluginRoot, "src", "secret-contract.js")}"`,
    );

    for (const value of ["", "   ", "off", "no", " ON ", "arbitrary"]) {
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK", value);
      expect(loadSecretContract).toThrow(
        `resolved "${path.join(pluginRoot, "src", "secret-contract.js")}"`,
      );
    }

    for (const value of ["0", " 0 ", "false", " FALSE "]) {
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK", value);
      expect(loadSecretContract()).toBe(42);
    }
  });
});
