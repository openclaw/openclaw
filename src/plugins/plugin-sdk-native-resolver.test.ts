import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  installOpenClawInternalCorePackageNativeResolver,
  installOpenClawPluginSdkNativeResolver,
} from "./plugin-sdk-native-resolver.js";

function writeFile(targetPath: string, content = "export default {};\n") {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
  return targetPath;
}

function writeFakeOpenClawPackage(root: string, extraSdkExports: string[] = []) {
  writeJsonFile(path.join(root, "package.json"), {
    name: "openclaw",
    type: "module",
    bin: { openclaw: "./openclaw.mjs" },
    exports: {
      "./cli-entry": "./dist/cli-entry.js",
      "./plugin-sdk/agent-runtime": "./dist/plugin-sdk/agent-runtime.js",
      "./plugin-sdk/channel-inbound": "./dist/plugin-sdk/channel-inbound.js",
      "./plugin-sdk/channel-outbound": "./dist/plugin-sdk/channel-outbound.js",
      "./plugin-sdk/source-only": "./dist/plugin-sdk/source-only.js",
      ...Object.fromEntries(
        extraSdkExports.map((entry) => [`./plugin-sdk/${entry}`, `./dist/plugin-sdk/${entry}.js`]),
      ),
    },
  });
  writeFile(path.join(root, "openclaw.mjs"), "#!/usr/bin/env node\n");
  const distRoot = path.join(root, "dist");
  const pluginSdkDir = path.join(distRoot, "plugin-sdk");
  for (const [file, content] of Object.entries({
    "agent-runtime": "export const agentRuntimeSource = import.meta.url;\n",
    "channel-inbound": 'export * from "./channel-outbound.js";\n',
    "channel-outbound": 'export const defineChannelMessageAdapter = () => "adapter";\n',
  })) {
    writeFile(path.join(pluginSdkDir, `${file}.js`), content);
  }
  const loaderModulePath = writeFile(path.join(distRoot, "plugins", "loader.js"));
  return { distRoot, loaderModulePath };
}

function writeExternalPluginEntry(root: string): string {
  writeJsonFile(path.join(root, "package.json"), {
    name: "external-plugin",
    type: "module",
  });
  return writeFile(path.join(root, "dist", "runtime-api.js"));
}

function writeInternalCorePackageExports(
  root: string,
  packageDir: string,
  subpaths: readonly string[],
): void {
  writeJsonFile(path.join(root, "packages", packageDir, "package.json"), {
    name: `@openclaw/${packageDir}`,
    type: "module",
    exports: Object.fromEntries(
      subpaths.map((subpath) => {
        const exportKey = subpath ? `./${subpath}` : ".";
        const distFile = `./dist/${subpath || "index"}.mjs`;
        return [exportKey, { import: distFile, default: distFile }];
      }),
    ),
  });
}

function addFakePluginSdkDistExport(root: string, subpath: string): string {
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    exports: Record<string, string>;
  };
  const distPath = path.join(root, "dist", "plugin-sdk", `${subpath}.js`);
  packageJson.exports[`./plugin-sdk/${subpath}`] = `./dist/plugin-sdk/${subpath}.js`;
  writeJsonFile(packageJsonPath, packageJson);
  fs.writeFileSync(distPath, `export const ${subpath.replaceAll("-", "_")} = true;\n`, "utf8");
  return distPath;
}

function createInternalCoreAliasFixture(prefix: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const { loaderModulePath } = writeFakeOpenClawPackage(root);
  const sourcePath = writeFile(
    path.join(root, "packages/markdown-core/src/code-spans.ts"),
    "export {};\n",
  );
  const coreSourceParent = writeFile(path.join(root, "src", "host-probe.js"));
  return {
    coreSourceParent,
    loaderModulePath,
    moduleUrl: pathToFileURL(loaderModulePath).href,
    root,
    sourcePath,
  };
}

function sdkFixture(
  prefix = "openclaw-sdk-native-",
  root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
) {
  const host = writeFakeOpenClawPackage(root);
  const externalPluginEntry = writeExternalPluginEntry(path.join(root, "external-plugin"));
  const moduleUrl = pathToFileURL(host.loaderModulePath).href;
  return {
    ...host,
    root,
    externalPluginEntry,
    requireFromPlugin: createRequire(externalPluginEntry),
    options: { moduleUrl, pluginModulePath: externalPluginEntry },
  };
}

function devFixture() {
  const stable = sdkFixture("openclaw-sdk-native-stable-");
  const devRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-dev-source-"));
  writeFakeOpenClawPackage(devRoot);
  fs.mkdirSync(path.join(devRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(devRoot, "extensions"), { recursive: true });
  return { ...stable, devRoot };
}

function expectResolved(parent: string, specifier: string, target: string) {
  expect(fs.realpathSync(createRequire(parent).resolve(specifier))).toBe(fs.realpathSync(target));
}

function expectSdk(parent: string, root: string, subpath = "agent-runtime", extension = "") {
  expectResolved(
    parent,
    `openclaw/plugin-sdk/${subpath}${extension}`,
    path.join(root, "dist/plugin-sdk", `${subpath}.js`),
  );
}

describe("installOpenClawInternalCorePackageNativeResolver", () => {
  afterEach(() => vi.restoreAllMocks());
  it("isolates host aliases and rescans them only after metadata lifecycle invalidation", () => {
    const first = createInternalCoreAliasFixture("openclaw-sdk-native-core-host-a-");
    const second = createInternalCoreAliasFixture("openclaw-sdk-native-core-host-b-");
    const existsSync = vi.spyOn(fs, "existsSync");

    installOpenClawInternalCorePackageNativeResolver({ moduleUrl: first.moduleUrl });
    existsSync.mockClear();
    installOpenClawInternalCorePackageNativeResolver({ moduleUrl: second.moduleUrl });
    expect(existsSync).toHaveBeenCalledWith(second.sourcePath);
    for (const host of [first, second]) {
      expectResolved(host.coreSourceParent, "@openclaw/markdown-core/code-spans", host.sourcePath);
    }
    existsSync.mockClear();
    installOpenClawInternalCorePackageNativeResolver({ moduleUrl: first.moduleUrl });
    expect(existsSync).not.toHaveBeenCalled();
    clearPluginMetadataLifecycleCaches();
    existsSync.mockClear();
    installOpenClawInternalCorePackageNativeResolver({ moduleUrl: first.moduleUrl });
    expect(existsSync).toHaveBeenCalledWith(first.sourcePath);
  });
});

describe("installOpenClawPluginSdkNativeResolver", () => {
  it("resolves installed plugin SDK imports to the dev source root", () => {
    const { options, externalPluginEntry, devRoot } = devFixture();
    vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", devRoot);
    try {
      installOpenClawPluginSdkNativeResolver(options);
      expectSdk(externalPluginEntry, devRoot);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("replaces native SDK aliases and removes stale subpaths when a plugin switches dev roots", () => {
    const { root, options, externalPluginEntry, requireFromPlugin, devRoot } = devFixture();
    const stableExtraPath = addFakePluginSdkDistExport(root, "stable-extra");
    installOpenClawPluginSdkNativeResolver(options);
    expectSdk(externalPluginEntry, root);
    expectResolved(externalPluginEntry, "openclaw/plugin-sdk/stable-extra", stableExtraPath);
    installOpenClawPluginSdkNativeResolver({ ...options, devSourceRoot: devRoot });
    expectSdk(externalPluginEntry, devRoot);
    expect(() => requireFromPlugin.resolve("openclaw/plugin-sdk/stable-extra")).toThrow();
  });

  it("keeps overlapping parent precedence across first demand and reinstallation", () => {
    const broad = sdkFixture("openclaw-sdk-broad-host-");
    const narrow = sdkFixture("openclaw-sdk-narrow-host-");
    const broadEntry = broad.externalPluginEntry;
    const narrowEntry = writeExternalPluginEntry(path.join(path.dirname(broadEntry), "nested"));
    const narrowOptions = {
      ...narrow.options,
      pluginModulePath: narrowEntry,
      devSourceRoot: narrow.root,
    };
    const broadOptions = {
      ...broad.options,
      devSourceRoot: broad.root,
    };
    installOpenClawPluginSdkNativeResolver(narrowOptions);
    installOpenClawPluginSdkNativeResolver(broadOptions);
    // A demand outside the nested root gives the broad host precedence even
    // though it was installed second; the later path was not demanded yet.
    expectSdk(broadEntry, broad.root);
    expectSdk(narrowEntry, broad.root, "channel-outbound", ".js");

    installOpenClawPluginSdkNativeResolver(broadOptions);
    expectSdk(narrowEntry, narrow.root, "channel-inbound");
    expectSdk(broadEntry, broad.root, "channel-inbound");
  });

  it("lets built external plugins resolve OpenClaw SDK subpaths with createRequire", () => {
    const { root, distRoot, options, externalPluginEntry, requireFromPlugin } = sdkFixture();

    const distMode = fs.statSync(distRoot).mode;
    if (process.platform !== "win32") {
      fs.chmodSync(distRoot, 0o555);
    }

    try {
      installOpenClawPluginSdkNativeResolver({ ...options, pluginSdkResolution: "dist" });

      expect(fs.existsSync(path.join(distRoot, "extensions"))).toBe(false);
      expectSdk(externalPluginEntry, root, "channel-outbound");
      const sdk = requireFromPlugin("openclaw/plugin-sdk/channel-outbound") as {
        defineChannelMessageAdapter?: () => string;
      };

      expect(sdk.defineChannelMessageAdapter?.()).toBe("adapter");
      expect(() => requireFromPlugin.resolve("openclaw/not-plugin-sdk/channel-outbound")).toThrow();
    } finally {
      if (process.platform !== "win32") {
        fs.chmodSync(distRoot, distMode);
      }
    }
  });

  it("keeps SDK and internal schema aliases available for native ESM lazy imports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-esm-resolver-"));
    const { loaderModulePath } = writeFakeOpenClawPackage(root, ["late-entry", "process-runtime"]);
    writeFile(
      path.join(root, "dist/plugin-sdk/late-entry.js"),
      'export const late = "late-adapter";\n',
    );
    // Internal alias scans are host snapshots; keep the alias-free host separate.
    const aliasFreeRoot = path.join(root, "alias-free-host");
    writeJsonFile(path.join(aliasFreeRoot, "package.json"), { name: "openclaw", type: "module" });
    const aliasFreeLoaderPath = writeFile(path.join(aliasFreeRoot, "loader.js"));
    const aiToolSchemaPath = writeFile(
      path.join(root, "packages/ai/src/internal/tool-schema.ts"),
      "export const schemaSource = import.meta.url;\n",
    );
    const coreEntryPath = writeFile(
      path.join(root, "src/schema-probe.mjs"),
      'export { schemaSource } from "@openclaw/ai/internal/tool-schema";\n',
    );
    writeInternalCorePackageExports(root, "worker-runtime", ["", "worker", "lifecycle"]);
    for (const entry of ["index", "worker", "lifecycle"]) {
      writeFile(
        path.join(root, "packages/worker-runtime/src", `${entry}.ts`),
        "export const source = import.meta.url;\n",
      );
    }
    writeFile(
      path.join(root, "src/plugin-sdk/process-runtime.ts"),
      'export { source as poolSource } from "@openclaw/worker-runtime"; export { source as workerSource } from "@openclaw/worker-runtime/worker"; export { source as lifecycleSource } from "@openclaw/worker-runtime/lifecycle";\n',
    );
    const entryPath = writeExternalPluginEntry(path.join(root, "external-plugin"));
    writeFile(
      entryPath,
      'import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound"; export * as workerRuntime from "openclaw/plugin-sdk/process-runtime"; export const eager = defineChannelMessageAdapter(); export const loadLazy = () => import("./lazy.js");\n',
    );
    writeFile(
      path.join(path.dirname(entryPath), "lazy.js"),
      'export { late as lazy } from "openclaw/plugin-sdk/late-entry.js";\n',
    );
    const resolverModuleUrl = pathToFileURL(
      path.join(process.cwd(), "src", "plugins", "plugin-sdk-native-resolver.ts"),
    ).href;
    const probePath = writeFile(
      path.join(root, "probe.mjs"),
      `import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installOpenClawInternalCorePackageNativeResolver, installOpenClawPluginSdkNativeResolver } from ${JSON.stringify(resolverModuleUrl)};
import { getPluginCache } from ${JSON.stringify(new URL("./plugin-cache.ts", resolverModuleUrl).href)};
const { root, loaderModulePath, aliasFreeLoaderPath, aiToolSchemaPath, coreEntryPath, entryPath } = ${JSON.stringify({ root, loaderModulePath, aliasFreeLoaderPath, aiToolSchemaPath, coreEntryPath, entryPath })};
const originalResolver = Module._resolveFilename;
installOpenClawInternalCorePackageNativeResolver({ moduleUrl: pathToFileURL(aliasFreeLoaderPath).href });
installOpenClawPluginSdkNativeResolver({ moduleUrl: pathToFileURL(aliasFreeLoaderPath).href });
const aliasFreeUnchanged = Module._resolveFilename === originalResolver;
installOpenClawPluginSdkNativeResolver({
  moduleUrl: pathToFileURL(loaderModulePath).href,
  pluginModulePath: entryPath,
  pluginSdkResolution: "dist",
});
const contexts = getPluginCache().sdk.contexts;
const contextValues = contexts.values.bind(contexts);
let contextScans = 0;
contexts.values = () => { contextScans += 1; return contextValues(); };
const module = await import(pathToFileURL(entryPath).href);
const lazy = await module.loadLazy();
const core = await import(pathToFileURL(coreEntryPath).href);
for (const [key, entry] of [["poolSource", "index"], ["workerSource", "worker"], ["lifecycleSource", "lifecycle"]]) {
  assert.equal(module.workerRuntime[key], pathToFileURL(fs.realpathSync(path.join(root, "packages", "worker-runtime", "src", entry + ".ts"))).href);
}
assert.equal(core.schemaSource, pathToFileURL(fs.realpathSync(aiToolSchemaPath)).href);
assert.equal(contextScans, 0, "native imports must not scan prepared SDK contexts");
console.log(JSON.stringify({ aliasFreeUnchanged, eager: module.eager, lazy: lazy.lazy }));
`,
    );

    try {
      for (const runtime of new Set([process.execPath, resolveTestNodeExecPath()])) {
        // Exercise Node hooks even when the test runner uses Bun's separate resolver.
        const probeArgs =
          process.versions.bun && runtime === process.execPath
            ? [probePath]
            : ["--import", pathToFileURL(path.resolve("scripts/tsx.mjs")).href, probePath];
        const result = spawnSync(runtime, probeArgs, {
          cwd: process.cwd(),
          encoding: "utf8",
        });
        expect(result).toMatchObject({ stderr: "", status: 0 });
        expect(JSON.parse(result.stdout)).toMatchObject({
          aliasFreeUnchanged: true,
          eager: "adapter",
          lazy: "late-adapter",
        });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves internal core packages only for OpenClaw-owned source parents", () => {
    const { root, options, requireFromPlugin } = sdkFixture();
    const packages = {
      "normalization-core": ["string-coerce", "boolean-coercion", "result", "agent-id"],
      "media-core": ["mime", "attachment-classify"],
      "markdown-core": ["code-spans"],
      ai: [
        "transports",
        "internal/tool-schema",
        "internal/runtime",
        "internal/openai-responses-payload-policy",
        "internal/google",
        "internal/google-model-family",
        "internal/retry-after",
      ],
      "acp-core": ["runtime/types"],
      "llm-core": ["", "model-contracts/anthropic"],
    };
    const sources = Object.entries(packages).flatMap(([packageDir, subpaths]) => {
      if (["normalization-core", "media-core", "acp-core"].includes(packageDir)) {
        writeInternalCorePackageExports(root, packageDir, subpaths.toSorted());
      }
      return subpaths.map((subpath) => ({
        specifier: `@openclaw/${packageDir}${subpath ? `/${subpath}` : ""}`,
        sourcePath: writeFile(
          path.join(root, "packages", packageDir, "src", `${subpath || "index"}.ts`),
          "export {};\n",
        ),
      }));
    });
    const coreSourceParent = writeFile(path.join(root, "src/config/plugin-web-search-config.ts"));
    installOpenClawPluginSdkNativeResolver({ ...options, pluginSdkResolution: "dist" });
    for (const { specifier, sourcePath } of sources) {
      expectResolved(coreSourceParent, specifier, sourcePath);
      expect(() => requireFromPlugin.resolve(specifier)).toThrow();
    }
  });

  it("scopes private SSRF SDK aliases to bundled local IPC native parents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-ssrf-"));
    const { loaderModulePath } = writeFakeOpenClawPackage(root);
    const internalPath = path.join(root, "dist", "plugin-sdk", "ssrf-runtime-internal.js");
    fs.writeFileSync(internalPath, "export const ssrfInternal = true;\n", "utf8");
    const owners = (
      [
        ["dist", "ollama"],
        ["dist-runtime", "ollama"],
        ["dist", "browser"],
        ["dist-runtime", "browser"],
        ["dist", "demo"],
      ] as const
    ).map(([dist, plugin]) => {
      const entry = writeFile(path.join(root, dist, "extensions", plugin, "index.js"));
      return { entry, allowed: plugin !== "demo" };
    });
    for (const { entry } of owners) {
      installOpenClawPluginSdkNativeResolver({
        moduleUrl: pathToFileURL(loaderModulePath).href,
        pluginModulePath: entry,
        pluginSdkResolution: "dist",
      });
    }
    for (const { entry, allowed } of owners) {
      const resolve = () =>
        createRequire(entry).resolve("openclaw/plugin-sdk/ssrf-runtime-internal");
      if (allowed) {
        expect(fs.realpathSync(resolve())).toBe(fs.realpathSync(internalPath));
      } else {
        expect(resolve).toThrow();
      }
    }
  });
});
