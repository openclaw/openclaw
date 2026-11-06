import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { registerSubCliByName } from "../cli/program/register.subclis.js";
import { withCliCommandCleanup, withCliProcessScope } from "../cli/runtime-cleanup-scope.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  createPluginCliLoadSession,
  loadPluginCliRegistrationEntriesWithDefaults,
} from "./cli-registry-loader.js";
import { registerPluginCliCommandsFromValidatedConfig } from "./cli.js";
import { createPluginModuleLoader } from "./loader-module-runtime.js";
import * as pluginLoader from "./loader.js";
import {
  createPluginCache,
  getPluginCache,
  invalidatePluginCacheMetadata,
  resetPluginCache,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { getCachedPluginModuleLoader } from "./plugin-module-loader-cache.js";
import {
  installOpenClawPluginSdkNativeResolver,
  resolvePluginNativeAliasForParent,
} from "./plugin-sdk-native-resolver.js";
import { writeArtifact as writeFile } from "./public-surface.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { preparePluginLoaderAliases } from "./sdk-alias.js";
import { createPluginRecord } from "./status.test-fixtures.js";

beforeEach(() => resetPluginCache());
const roots: string[] = [];
const requireFixture = createRequire(import.meta.url);

function writeJson(root: string, name: string, value: unknown) {
  return writeFile(path.join(root, name), JSON.stringify(value));
}

function installResolver(f: ReturnType<typeof fixture>, pluginModulePath = f.entry) {
  installOpenClawPluginSdkNativeResolver({
    pluginModulePath,
    devSourceRoot: f.root,
    pluginSdkResolution: "dist",
  });
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lazy-alias-")));
  roots.push(root);
  fs.mkdirSync(path.join(root, "extensions"));
  writeJson(root, "package.json", {
    name: "openclaw",
    type: "module",
    bin: { openclaw: "./openclaw.mjs" },
    exports: {
      "./plugin-sdk/used": "./dist/plugin-sdk/used.js",
      "./plugin-sdk/unused": "./dist/plugin-sdk/unused.js",
    },
  });
  const used = writeFile(
    path.join(root, "dist/plugin-sdk/used.js"),
    'export const value = "dist";',
  );
  const unused = writeFile(
    path.join(root, "dist/plugin-sdk/unused.js"),
    'export const value = "unused";',
  );
  writeFile(path.join(root, "src/plugin-sdk/used.ts"), 'export const value: string = "source";');
  const entry = writeFile(
    path.join(root, "dist/extensions/demo/cli-metadata.cjs"),
    'module.exports = { marker: "metadata", load: (name) => require(name), loadEsm: (name) => import(name) };',
  );
  const write = (name: string, content: string) => writeFile(path.join(root, name), content);
  const json = (name: string, value: unknown) => writeJson(root, name, value);
  const loader = (pluginSdkResolution: "src" | "dist" = "dist") =>
    createPluginModuleLoader({ devSourceRoot: root, pluginSdkResolution });
  const metadata = () =>
    loader()(entry) as {
      load: (name: string) => unknown;
      loadEsm: (name: string) => Promise<unknown>;
    };
  const privateSdk = (subpath: string) => {
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "0");
    json("scripts/lib/plugin-sdk-private-local-only-subpaths.json", [subpath]);
    write(`dist/plugin-sdk/${subpath}.js`, "export const privateValue = true;");
  };
  return { root, entry, used, unused, write, json, loader, metadata, privateSdk };
}

function externalOwner(source: string) {
  const rootDir = path.dirname(source);
  const record = createPluginRecord({ id: "external", rootDir, source, origin: "global" });
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(record);
  return { record, rootDir, registry };
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    for (const id of Object.keys(requireFixture.cache)) {
      if (id.startsWith(`${root}${path.sep}`)) {
        delete requireFixture.cache[id];
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("native plugin alias preparation", () => {
  it("returns native SDK filenames without changing Jiti alias targets", () => {
    const f = fixture();
    const specifier = "openclaw/plugin-sdk/used";
    const aliases = preparePluginLoaderAliases({
      modulePath: f.entry,
      moduleUrl: import.meta.url,
      devSourceRoot: f.root,
      pluginSdkResolution: "dist",
    });
    installResolver(f);
    const jitiTarget = process.platform === "win32" ? f.used.replaceAll("\\", "/") : f.used;
    expect(aliases.resolveAlias(specifier)).toBe(jitiTarget);
    expect(resolvePluginNativeAliasForParent(specifier, f.entry)).toBe(f.used);
    expect(aliases.getAliasMap()[specifier]).toBe(jitiTarget);
    const requirePlugin = createRequire(f.entry);
    expect(requirePlugin.resolve(specifier)).toBe(f.used);
    const resolve = vi.spyOn(path, "resolve");
    expect([
      resolvePluginNativeAliasForParent(specifier, f.entry),
      resolvePluginNativeAliasForParent(specifier, f.entry),
    ]).toEqual([f.used, f.used]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refreshes canonical parent boundaries with metadata invalidation", () => {
    const f = fixture();
    const outside = fixture();
    const parent = path.join(path.dirname(f.entry), "linked-parent.cjs");
    fs.symlinkSync(f.entry, parent);
    installResolver(f);
    const requirePlugin = createRequire(parent);
    const specifier = "@openclaw/plugin-sdk/used";
    expect(requirePlugin.resolve(specifier)).toBe(f.used);
    fs.unlinkSync(parent);
    fs.symlinkSync(outside.entry, parent);
    expect(requirePlugin.resolve(specifier)).toBe(f.used);
    invalidatePluginCacheMetadata(getPluginCache());
    expect(() => requirePlugin.resolve(specifier)).toThrow();
    fs.unlinkSync(parent);
    fs.symlinkSync(f.entry, parent);
    invalidatePluginCacheMetadata(getPluginCache());
    expect(requirePlugin.resolve(specifier)).toBe(f.used);
  });

  it.each([
    ["src", "production", "source"],
    ["dist", "development", "dist"],
  ] as const)(
    "preserves explicit %s SDK preference in %s",
    async (pluginSdkResolution, environment, expected) => {
      const f = fixture();
      const source = f.write(
        "external/index.ts",
        'export { value } from "openclaw/plugin-sdk/used";',
      );
      vi.stubEnv("NODE_ENV", environment);
      const owner = externalOwner(source);
      try {
        expect(f.loader(pluginSdkResolution)(source, owner)).toMatchObject({ value: expected });
      } finally {
        await getPluginInstance(owner.record)?.dispose();
      }
    },
  );

  it.each(["alias", "relative"] as const)(
    "evaluates shared SDK imports before concurrent lazy CJS plugins require them (%s)",
    async (sdkImport) => {
      const f = fixture();
      f.write("dist/plugin-sdk/leaf.js", 'export const value = "dist";');
      f.write("dist/plugin-sdk/used.js", 'export { value } from "./leaf.js";');
      const bundledEntry = f.write(
        "dist/extensions/bundled/index.cjs",
        `module.exports = { start: () => import("${sdkImport === "alias" ? "openclaw/plugin-sdk/used" : "../../plugin-sdk/used.js"}") };`,
      );
      const pluginDir = path.join(f.root, "external");
      writeJson(pluginDir, "package.json", { name: "external-fixture" });
      writeFile(
        path.join(pluginDir, "lazy.cjs"),
        'module.exports = require("openclaw/plugin-sdk/used");',
      );
      const entry = writeFile(
        path.join(pluginDir, "index.cjs"),
        'module.exports = { start: () => import("./lazy.cjs") };',
      );
      const owner = externalOwner(entry);
      const load = f.loader();
      const bundled = load(bundledEntry) as { start: () => Promise<{ value: string }> };
      const external = load(entry, owner) as {
        start: () => Promise<{ default: { value: string } }>;
      };
      let reads: Promise<unknown>[] = [];
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          reads = [
            bundled.start().then((module) => module.value),
            external.start().then((module) => module.default.value),
          ];
          await expect(Promise.all(reads)).resolves.toEqual(["dist", "dist"]);
        }
      } finally {
        await Promise.allSettled(reads);
        await getPluginInstance(owner.record)?.dispose();
      }
    },
  );

  it("loads a workspace alias without reading unrelated SDK artifacts", () => {
    const f = fixture();
    f.write("dist/retry/index.js", 'export const value = "family";');
    f.json("extensions/fixture-owner/package.json", { name: "@openclaw/fixture-owner" });
    f.write("extensions/fixture-owner/diagnostic-api.ts", 'export const value = "source";');
    const entry = f.write(
      "dist/extensions/demo/family.cjs",
      'module.exports = require("@openclaw/retry");',
    );
    const read = vi.spyOn(fs, "readFileSync");
    const load = f.loader();
    expect(load(f.entry)).toMatchObject({ marker: "metadata" });
    expect(load(entry)).toMatchObject({ value: "family" });
    expect(read.mock.calls.filter(([target]) => target === f.unused)).toEqual([]);
  });

  it("does not prepare aliases for unrelated requests or unregistered parents", async () => {
    const f = fixture();
    const outside = fixture();
    const read = vi.spyOn(fs, "readFileSync");
    const metadata = f.metadata();
    expect(metadata.load("node:path")).toHaveProperty("join");
    expect(() => metadata.load("@openclaw/plugin-sdk-other/used")).toThrow();
    expect(() => metadata.load("@openclaw/not-a-workspace/used")).toThrow();
    expect(() => createRequire(outside.entry).resolve("@openclaw/plugin-sdk/used")).toThrow();
    for (const relative of ["./plain.js", "./plugin-sdk/unused.js"]) {
      const target = writeFile(
        path.join(path.dirname(f.entry), relative),
        "export const url = import.meta.url;",
      );
      await expect(metadata.loadEsm(relative)).resolves.toMatchObject({
        url: pathToFileURL(target).href,
      });
    }
    expect(read.mock.calls.filter(([target]) => target === f.unused)).toEqual([]);
  });

  it.each(["query", "unregistered"] as const)(
    "keeps native SDK URL evaluation for %s imports",
    async (kind) => {
      const f = fixture();
      const outside = fixture();
      fs.writeFileSync(f.used, "await Promise.resolve(); export const url = import.meta.url;");
      installOpenClawPluginSdkNativeResolver({ pluginModulePath: f.entry, devSourceRoot: f.root });
      const metadata = createRequire(kind === "unregistered" ? outside.entry : f.entry)(
        kind === "unregistered" ? outside.entry : f.entry,
      ) as { loadEsm: (name: string) => Promise<unknown> };
      const url = pathToFileURL(f.used);
      if (kind === "query") {
        url.search = "?generation=1";
      }
      await expect(metadata.loadEsm(url.href)).resolves.toMatchObject({ url: url.href });
    },
  );

  it("captures private QA denial before late use even if ambient authorization changes", async () => {
    const f = fixture();
    f.privateSdk("qa-runtime");
    const metadata = f.metadata();
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "1");
    expect(() => metadata.load("@openclaw/plugin-sdk/qa-runtime")).toThrow();
    await expect(metadata.loadEsm("@openclaw/plugin-sdk/qa-runtime")).rejects.toThrow();
    installOpenClawPluginSdkNativeResolver({ pluginModulePath: f.entry, devSourceRoot: f.root });
    expect(metadata.load("@openclaw/plugin-sdk/qa-runtime")).toMatchObject({ privateValue: true });
    await expect(metadata.loadEsm("@openclaw/plugin-sdk/qa-runtime")).resolves.toMatchObject({
      privateValue: true,
    });
  });

  it("does not reuse a bundled private alias grant for an external plugin", () => {
    const f = fixture();
    f.privateSdk("demoted-helper");
    const external = f.write("external/index.cjs", "module.exports = {};");
    f.json("external/package.json", { name: "external-fixture" });
    installOpenClawPluginSdkNativeResolver({ pluginModulePath: f.entry, devSourceRoot: f.root });
    expect(createRequire(f.entry)("@openclaw/plugin-sdk/demoted-helper")).toMatchObject({
      privateValue: true,
    });
    installOpenClawPluginSdkNativeResolver({ pluginModulePath: external, devSourceRoot: f.root });
    expect(() => createRequire(external).resolve("@openclaw/plugin-sdk/demoted-helper")).toThrow();
  });

  it("captures private owner denial before a package rename", () => {
    const f = fixture();
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "0");
    const packageName = "@openclaw/llama-cpp-provider";
    const packageRoot = path.join(f.root, "node_modules", packageName);
    const manifest = writeJson(packageRoot, "package.json", { name: "external-fixture" });
    const entry = writeFile(path.join(packageRoot, "index.cjs"), "module.exports = {};");
    f.write("dist/plugin-sdk/ssrf-runtime-internal.js", "export const privateValue = true;");
    installOpenClawPluginSdkNativeResolver({ pluginModulePath: entry, devSourceRoot: f.root });
    fs.writeFileSync(manifest, JSON.stringify({ name: packageName }));
    const resolve = () =>
      createRequire(entry).resolve("@openclaw/plugin-sdk/ssrf-runtime-internal");
    expect(resolve).toThrow();
  });

  it("captures stale-dist source fallback before transformer use", () => {
    const a = fixture();
    const b = fixture();
    vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", a.root);
    vi.stubEnv("NODE_ENV", "production");
    fs.writeFileSync(a.used, 'export { value } from "./missing.js";');
    const entry = a.write(
      "extensions/demo/transform.ts",
      'import { value } from "@openclaw/plugin-sdk/used"; export const marker: string = value;',
    );
    const read = vi.spyOn(fs, "readFileSync");
    const loader = getCachedPluginModuleLoader({
      modulePath: entry,
      importerUrl: import.meta.url,
      tryNative: false,
    });
    expect(read.mock.calls.filter(([target]) => target === a.unused)).toEqual([]);
    vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", b.root);
    vi.stubEnv("NODE_ENV", "production");
    expect(loader(entry)).toMatchObject({ marker: "source" });
    expect(read.mock.calls.filter(([target]) => target === b.used || target === b.unused)).toEqual(
      [],
    );
    expect(loader(entry)).toBe(loader(entry));
  });

  it.each([
    "explicit",
    "standalone",
    "deferred",
    "nodes",
    "pairing-before",
    "plugins-after",
  ] as const)("keeps late Commander action aliases for %s registration", async (registration) => {
    const nested = registration === "nodes";
    const runRegistration = async () => {
      const f = fixture();
      const pluginDir = path.dirname(f.entry);
      // Use the supported entrypoint metadata fallback, including nested CLI descriptors.
      fs.unlinkSync(f.entry);
      const observed = path.join(f.root, "action.json");
      const entry = writeFile(
        path.join(pluginDir, "index.cjs"),
        `module.exports = { id: "demo", register(api) {
      api.registerCli(({ program }) => program.command("late").action(async () => {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => require("openclaw/plugin-sdk/used")),
          import("@openclaw/plugin-sdk/unused.js"),
        ]);
        require("node:fs").writeFileSync(${JSON.stringify(observed)}, JSON.stringify(results.map(result =>
          result.status === "fulfilled" ? result.value.value : { error: result.reason.code, message: result.reason.message }
        )));
      }), { commands: ["late"], descriptors: [{ name: "late", description: "Late import", hasSubcommands: false }], parentPath: ${JSON.stringify(nested ? ["nodes"] : [])} });
    } };`,
      );
      writeJson(pluginDir, "package.json", {
        name: "demo",
        openclaw: { extensions: ["./index.cjs"] },
      });
      writeJson(pluginDir, "openclaw.plugin.json", {
        id: "demo",
        configSchema: { type: "object", properties: {} },
        cliCommands: nested
          ? undefined
          : [{ name: "late", description: "Late import", hasSubcommands: false }],
      });
      const cfg = {
        plugins: {
          allow: ["demo"],
          load: { paths: [entry] },
          entries: { demo: { enabled: true } },
        },
      };
      const env = {
        HOME: f.root,
        OPENCLAW_STATE_DIR: path.join(f.root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(f.root, "openclaw.json"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_DEV_SOURCE_ROOT: f.root,
      };
      const program = new Command().exitOverride();
      const parse = () =>
        program.parseAsync(nested ? ["nodes", "late"] : ["late"], { from: "user" });
      if (registration === "explicit") {
        const sessionCache = createPluginCache();
        const registrationCache = createPluginCache();
        const actionCache = createPluginCache();
        const session = createPluginCliLoadSession(sessionCache);
        const rawRegistryLoader = vi.spyOn(pluginLoader, "loadPluginRegistryHandle");
        try {
          expect(session.resources).toBeUndefined();
          const [registrar] = await loadPluginCliRegistrationEntriesWithDefaults({
            session,
            cfg,
            env,
            primaryCommand: "late",
          });
          await withPluginCache(registrationCache, () => registrar!.register(program));
          session.close();
          await expect(registrar!.register(new Command())).rejects.toThrow(/preparation is closed/);
          await withPluginCache(actionCache, () => session.withCache(parse));
          expect(JSON.parse(fs.readFileSync(observed, "utf8"))).toEqual(["source", "unused"]);
          return;
        } finally {
          session.close();
          const registries = rawRegistryLoader.mock.results.flatMap((result) =>
            result.type === "return" ? [result.value] : [],
          );
          rawRegistryLoader.mockRestore();
          for (const registry of registries) {
            expect((await disposePluginRegistryInstances(registry)).failures).toEqual([]);
          }
          for (const cache of [sessionCache, registrationCache, actionCache]) {
            expect((await retirePluginCache(cache)).failures).toEqual([]);
          }
        }
      } else {
        clearRuntimeConfigSnapshot();
        for (const [key, value] of Object.entries(env)) {
          vi.stubEnv(key, value);
        }
        fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
        if (registration === "standalone" || registration === "deferred") {
          await registerPluginCliCommandsFromValidatedConfig(program, env, undefined, {
            mode: registration === "deferred" ? "lazy" : "eager",
          });
          await parse();
          expect(JSON.parse(fs.readFileSync(observed, "utf8"))).toEqual(["source", "unused"]);
          return;
        }
        const name = nested ? "nodes" : registration === "pairing-before" ? "pairing" : "plugins";
        // Eager traversal forwards the active invocation to every core registrar. Memory's
        // plugin-loading policy exercises both before/after branches without changing policy.
        const argv = nested
          ? ["node", "openclaw", "nodes", "late"]
          : ["node", "openclaw", "memory", "status"];
        await registerSubCliByName(program, name, argv);
        if (!nested) {
          const names = program.commands.map((command) => command.name());
          expect(names.indexOf("late") < names.indexOf(name)).toBe(
            registration === "pairing-before",
          );
        }
        await parse();
      }
      expect(JSON.parse(fs.readFileSync(observed, "utf8"))).toEqual(["source", "unused"]);
    };
    if (registration === "explicit") {
      // Caller-owned programs retain the session without executable registry custody.
      await runRegistration();
      return;
    }
    await withCliProcessScope(() =>
      withCliCommandCleanup(false, async (cleanup) => {
        if (!cleanup?.pluginResources) {
          throw new Error("Expected executable plugin resource owner");
        }
        try {
          await runRegistration();
        } finally {
          await cleanup.pluginResources.release();
        }
      }),
    );
  });
});
