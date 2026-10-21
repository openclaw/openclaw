import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { captureEnv } from "../test-utils/env.js";
import { createNodeEvalArgs } from "../test-utils/node-process.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import type { OpenClawConfig } from "./config-contracts.js";
import {
  createLazyFacadeObjectValue,
  listImportedBundledPluginFacadeIds,
  loadFacadeModuleAtLocationSync,
  loadBundledPluginPublicSurfaceModuleSyncCore,
  MissingPublicSurfaceError,
  resetFacadeLoaderStateForTest,
} from "./facade-loader.js";
import {
  listImportedBundledPluginFacadeIds as listImportedFacadeRuntimeIds,
  loadActivatedBundledPluginPublicSurfaceModule,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";
import { writeFacadeFiles } from "./facade-runtime.test-support.js";
import { createPluginSdkTestHarness } from "./test-helpers.js";

const { createTempDirSync } = createPluginSdkTestHarness();
const originalEnv = captureEnv([
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
]);
const FACADE_LOADER_GLOBAL = "__openclawTestLoadBundledPluginPublicSurfaceModuleSync";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const trustedBundledPluginFixtureRoots: string[] = [];
let trustedPluginIdCounter = 0;

function nextTrustedPluginId(prefix: string): string {
  return `${prefix}${trustedPluginIdCounter++}`;
}

function createPluginFixture(files: (pluginId: string) => Record<string, string>, source = false) {
  const bundledPluginsDir = path.join(packageRoot, ...(source ? [] : ["dist"]), "extensions");
  const pluginId = nextTrustedPluginId("openclaw-facade-fixture-");
  const pluginRoot = path.join(bundledPluginsDir, pluginId);
  trustedBundledPluginFixtureRoots.push(pluginRoot);
  writeFacadeFiles(pluginRoot, { "package.json": { type: "module" }, ...files(pluginId) });
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
  return { bundledPluginsDir, pluginId, pluginRoot };
}

function createMarkerFixture(marker: string, source = false) {
  return createPluginFixture(
    () => ({
      [source ? "api.ts" : "api.js"]: `export const marker = ${JSON.stringify(marker)};\n`,
    }),
    source,
  );
}
const loadFixture = (pluginId: string) =>
  loadBundledPluginPublicSurfaceModuleSyncCore<{ marker: string }>({
    dirName: pluginId,
    artifactBasename: "api.js",
  });

function createBundledChannelConfigFixtures(): string {
  const bundledPluginsDir = path.join(
    packageRoot,
    "dist",
    nextTrustedPluginId("openclaw-channel-config-fixtures-"),
  );
  trustedBundledPluginFixtureRoots.push(bundledPluginsDir);
  for (const [pluginId, exportName] of [
    ["telegram", "TelegramConfigSchema"],
    ["imessage", "IMessageConfigSchema"],
  ] as const) {
    writeFacadeFiles(path.join(bundledPluginsDir, pluginId), {
      "package.json": { type: "module" },
      "config-api.js": [
        'import { z } from "zod";',
        `export const ${exportName} = z.object({ dmPolicy: z.literal("pairing").default("pairing") });`,
        "",
      ].join("\n"),
    });
  }
  return bundledPluginsDir;
}

function createCircularPluginFixture() {
  return createPluginFixture((pluginId) => ({
    "facade.mjs": [
      `const loadBundledPluginPublicSurfaceModuleSyncCore = globalThis.${FACADE_LOADER_GLOBAL};`,
      `export const marker = loadBundledPluginPublicSurfaceModuleSyncCore({ dirName: ${JSON.stringify(
        pluginId,
      )}, artifactBasename: "api.js" }).marker;`,
      "",
    ].join("\n"),
    "helper.js": 'import { marker } from "./facade.mjs";\nexport const circularMarker = marker;\n',
    "api.js": 'import "./helper.js";\nexport const marker = "circular-ok";\n',
  }));
}

describe("plugin-sdk facade loader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetFacadeLoaderStateForTest();
    for (const dir of trustedBundledPluginFixtureRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    delete (globalThis as typeof globalThis & Record<string, unknown>)[FACADE_LOADER_GLOBAL];
    originalEnv.restore();
  });

  it("preserves object and accessor semantics through preventExtensions", () => {
    const method = function (this: unknown) {
      return this;
    };
    const original = { value: 1, method };
    const prototype = { inherited: true };
    Object.setPrototypeOf(original, prototype);
    const symbol = Symbol("receiver");
    const getter = vi.fn(function (this: unknown) {
      return this;
    });
    Object.defineProperty(original, symbol, { configurable: true, get: getter });
    const facade = createLazyFacadeObjectValue(() => original);

    Object.preventExtensions(facade);

    expect(getter).not.toHaveBeenCalled();
    expect(Object.isExtensible(facade)).toBe(false);
    expect(Object.isSealed(facade)).toBe(false);
    expect(Object.isFrozen(facade)).toBe(false);
    expect(Object.getOwnPropertyDescriptors(facade)).toEqual(
      Object.getOwnPropertyDescriptors(original),
    );
    expect(Object.getPrototypeOf(facade)).toBe(prototype);
    expect(facade.method).toBe(method);
    expect(facade.method()).toBe(facade);
    expect(Reflect.get(facade, symbol, null)).toBeNull();
    expect(Reflect.get(facade, symbol, undefined)).toBeUndefined();
    expect(Reflect.set(facade, "added", true)).toBe(false);
    expect(Reflect.deleteProperty(facade, "value")).toBe(true);
    expect(Object.hasOwn(original, "value")).toBe(false);
  });

  it("observes changes through the original after the facade becomes non-extensible", () => {
    const original = { value: 1, byHas: true, byDescriptor: true, byKeys: true };
    const symbol = Symbol("mutable");
    Object.defineProperty(original, symbol, { value: 1, writable: true, configurable: true });
    const facade = createLazyFacadeObjectValue(() => original);
    Object.preventExtensions(facade);

    original.value = 2;
    Reflect.set(original, symbol, 2);
    expect(facade.value).toBe(2);
    expect(Reflect.get(facade, symbol)).toBe(2);
    facade.value = 3;
    expect(original.value).toBe(3);
    Reflect.deleteProperty(original, "byHas");
    expect("byHas" in facade).toBe(false);
    Reflect.deleteProperty(original, "byDescriptor");
    expect(Object.getOwnPropertyDescriptor(facade, "byDescriptor")).toBeUndefined();
    Reflect.deleteProperty(original, "byKeys");
    expect(Reflect.ownKeys(facade)).toEqual(["value", symbol]);
    Object.freeze(original);
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Reflect.set(facade, "value", 4)).toBe(false);
  });

  it("resolves channel config facades lazily from generated plugin fixtures", async () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = createBundledChannelConfigFixtures();
    const { IMessageConfigSchema, TelegramConfigSchema } =
      await import("./bundled-channel-config-schema.js");

    expect(listImportedBundledPluginFacadeIds()).toEqual([]);
    type ChannelConfig = NonNullable<OpenClawConfig["channels"]>;
    const telegramResult: z.ZodSafeParseResult<NonNullable<ChannelConfig["telegram"]>> =
      TelegramConfigSchema.safeParse({ dmPolicy: "pairing" });
    expect(telegramResult.success).toBe(true);
    expect(Object.keys(TelegramConfigSchema)).toContain("type");
    const extended = TelegramConfigSchema.safeExtend({ testOnly: z.literal(true) });
    expect(extended.safeParse({ dmPolicy: "pairing", testOnly: true }).success).toBe(true);
    expect(listImportedBundledPluginFacadeIds()).toEqual(["telegram"]);

    const imessageResult: z.ZodSafeParseResult<NonNullable<ChannelConfig["imessage"]>> =
      IMessageConfigSchema.safeParse({ dmPolicy: "pairing" });
    expect(imessageResult.success).toBe(true);
    expect(listImportedBundledPluginFacadeIds()).toEqual(["imessage", "telegram"]);
  });

  it("falls back to package source surfaces when an override dir lacks a bundled plugin", () => {
    const fixture = createMarkerFixture("source-fallback", true);
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = createTempDirSync("openclaw-facade-loader-empty-");

    expect(loadFixture(fixture.pluginId).marker).toBe("source-fallback");
  });

  it("keeps bundled facade loads disabled when bundled plugins are disabled", () => {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

    const load = () =>
      loadBundledPluginPublicSurfaceModuleSyncCore({
        dirName: "browser",
        artifactBasename: "browser-maintenance.js",
      });

    expect(load).toThrow(MissingPublicSurfaceError);
    expect(load).toThrow(
      new MissingPublicSurfaceError(
        "Unable to resolve bundled plugin public surface browser/browser-maintenance.js",
      ),
    );
  });

  it("open failures are not classified as MissingPublicSurfaceError", () => {
    const tempRoot = createTempDirSync("openclaw-facade-loader-boundary-fail-");
    const boundaryRoot = path.join(tempRoot, "plugin");
    const outsidePath = path.join(tempRoot, "outside.js");
    fs.mkdirSync(boundaryRoot, { recursive: true });
    fs.writeFileSync(outsidePath, 'export const marker = "outside";\n', "utf8");

    const load = () =>
      loadFacadeModuleAtLocationSync({
        location: { modulePath: outsidePath, boundaryRoot },
        trackedPluginId: "boundary-failure",
      });

    expect(load).toThrow(
      new Error(`Unable to open bundled plugin public surface ${outsidePath}: outside plugin root`),
    );
    expect(load).not.toThrow(MissingPublicSurfaceError);
  });

  it("shares loaded facade ids with facade-runtime", () => {
    const fixture = createMarkerFixture("identity-check");

    const first = loadFixture(fixture.pluginId);
    const second = loadFixture(fixture.pluginId);

    expect(first).toBe(second);
    expect(first.marker).toBe("identity-check");
    expect(listImportedBundledPluginFacadeIds()).toEqual([fixture.pluginId]);
    expect(listImportedFacadeRuntimeIds()).toEqual([fixture.pluginId]);
    clearPluginMetadataLifecycleCaches();
    expect(listImportedBundledPluginFacadeIds()).toEqual([fixture.pluginId]);
  });

  it("breaks circular facade re-entry during module evaluation", () => {
    const fixture = createCircularPluginFixture();
    (globalThis as typeof globalThis & Record<string, unknown>)[FACADE_LOADER_GLOBAL] =
      loadBundledPluginPublicSurfaceModuleSyncCore;

    expect(loadFixture(fixture.pluginId).marker).toBe("circular-ok");
  });

  it("loads a facade when Windows reports the root and module through physical aliases", () => {
    const tempRoot = createTempDirSync("openclaw-facade-loader-root-alias-");
    const physicalRoot = path.join(tempRoot, "physical-root");
    const admittedRoot = path.join(tempRoot, "admitted-root");
    const modulePath = path.join(physicalRoot, "api.js");
    fs.mkdirSync(physicalRoot);
    fs.writeFileSync(modulePath, 'module.exports = { marker: "alias" };\n', "utf8");
    fs.symlinkSync(physicalRoot, admittedRoot, process.platform === "win32" ? "junction" : "dir");
    const loadModule = vi.fn(() => ({ marker: "alias" }));

    withMockedWindowsPlatform(() => {
      expect(
        loadFacadeModuleAtLocationSync<{ marker: string }>({
          location: { modulePath, boundaryRoot: admittedRoot },
          trackedPluginId: "root-alias",
          loadModule,
        }).marker,
      ).toBe("alias");
    });
    expect(loadModule).toHaveBeenCalledWith(modulePath);
  });
});

describe("cold facade activation", () => {
  const moduleUrl = (file: string) => pathToFileURL(path.resolve(file)).href;

  const fixtureLifetime = createFixtureLifetime();
  afterEach(async () => {
    resetFacadeRuntimeStateForTest();
    vi.unstubAllEnvs();
    await fixtureLifetime.cleanup();
  });

  function createFacade(id: string) {
    const bundledRoot = path.resolve("dist-runtime", "extensions");
    fs.mkdirSync(bundledRoot, { recursive: true });
    const root = fs.realpathSync(fixtureLifetime.createTempDir(".cold-facade-", bundledRoot));
    writeFacadeFiles(path.join(root, "fixture"), {
      "package.json": { type: "module" },
      "openclaw.plugin.json": { id, enabledByDefault: true },
      "api.ts": 'export const marker: string = "cold";\n',
    });
    return root;
  }

  it("awaits cold activation before loading a tiny allowed source facade", async () => {
    const root = createFacade("async-cold-owner");
    resetFacadeRuntimeStateForTest();
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", root);
    const pending = loadActivatedBundledPluginPublicSurfaceModule({
      dirName: "fixture",
      artifactBasename: "api.js",
    });
    expect(listImportedBundledPluginFacadeIds()).toEqual([]);
    await expect(pending).resolves.toEqual({ marker: "cold" });
    expect(listImportedBundledPluginFacadeIds()).toEqual(["async-cold-owner"]);
  });

  it("uses the live snapshot during cold synchronous activation", async ({ signal }) => {
    const fixtureRoot = createFacade("cold-native-owner");
    const isolatedRoot = fixtureLifetime.createTempDir("openclaw-cold-native-facade-");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      HOME: isolatedRoot,
      USERPROFILE: isolatedRoot,
      TMPDIR: isolatedRoot,
      TMP: isolatedRoot,
      TEMP: isolatedRoot,
      OPENCLAW_HOME: isolatedRoot,
      OPENCLAW_STATE_DIR: path.join(isolatedRoot, "state"),
      OPENCLAW_CONFIG_PATH: path.join(isolatedRoot, "missing-config.json"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: fixtureRoot,
      XDG_CONFIG_HOME: path.join(isolatedRoot, "config"),
      XDG_CACHE_HOME: path.join(isolatedRoot, "cache"),
      XDG_DATA_HOME: path.join(isolatedRoot, "data"),
      JITI_FS_CACHE: "0",
      NODE_DISABLE_COMPILE_CACHE: "1",
    };
    const source = `
    import assert from "node:assert/strict";
    const { setRuntimeConfigSnapshot } = await import(${JSON.stringify(moduleUrl("src/config/runtime-snapshot.ts"))});
    const { loadActivatedBundledPluginPublicSurfaceModuleSync: load, listImportedBundledPluginFacadeIds } = await import(${JSON.stringify(moduleUrl("src/plugin-sdk/facade-runtime.ts"))});
    const params = { dirName: "fixture", artifactBasename: "api.js" };
    const disabled = { plugins: { entries: { "cold-native-owner": { enabled: false } } } };
    setRuntimeConfigSnapshot(disabled);
    assert.throws(() => load(params), /disabled in config/);
    assert.deepEqual(listImportedBundledPluginFacadeIds(), []);
    setRuntimeConfigSnapshot({});
    const loaded = load(params);
    assert.equal(loaded.marker, "cold");
    assert.strictEqual(load(params), loaded);
    setRuntimeConfigSnapshot(disabled);
    assert.throws(() => load(params), /disabled in config/);
    console.log("cold facade follows the native source config snapshot");
    process.exit(0);
  `;
    const result = await fixtureLifetime.track(
      runNodeScript(
        createNodeEvalArgs(source, {
          imports: [moduleUrl("scripts/tsx.mjs")],
        }),
        env,
        30_000,
        {
          cwd: process.cwd(),
          signal,
          requireProcessTreeExit: process.platform !== "win32",
          maxBuffer: 64 * 1024,
        },
      ),
    );
    expect(
      [result.error, result.status],
      `Child inputs: ${fixtureRoot}; ${isolatedRoot}\n${result.stderr}`,
    ).toEqual([undefined, 0]);
    expect(result.stdout.trim()).toBe("cold facade follows the native source config snapshot");
  });
});
