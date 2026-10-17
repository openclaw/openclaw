/**
 * Tests bundled plugin facade loader resolution and activation checks.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { captureEnv } from "../test-utils/env.js";
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
import { listImportedBundledPluginFacadeIds as listImportedFacadeRuntimeIds } from "./facade-runtime.js";
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

function captureThrownError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected function to throw");
}

type TrustedBundledPluginFixture = {
  bundledPluginsDir: string;
  pluginId: string;
  pluginRoot: string;
};

function nextTrustedPluginId(prefix: string): string {
  return `${prefix}${trustedPluginIdCounter++}`;
}

function createTrustedBundledPluginsRoot(kind: "dist" | "dist-runtime" = "dist"): string {
  const rootDir = path.join(packageRoot, kind, "extensions");
  fs.mkdirSync(rootDir, { recursive: true });
  return rootDir;
}

function writeFixturePackageJson(
  pluginRoot: string,
  pluginId: string,
  type: "commonjs" | "module" = "module",
): void {
  writeJsonFile(path.join(pluginRoot, "package.json"), {
    name: `@openclaw/${pluginId}`,
    version: "0.0.0",
    type,
  });
}

function createBundledPluginFixture(params: {
  prefix: string;
  marker: string;
  kind?: "dist" | "dist-runtime";
  pluginId?: string;
}): TrustedBundledPluginFixture {
  const bundledPluginsDir = createTrustedBundledPluginsRoot(params.kind);
  const pluginId = params.pluginId ?? nextTrustedPluginId(params.prefix);
  const pluginRoot = path.join(bundledPluginsDir, pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  trustedBundledPluginFixtureRoots.push(pluginRoot);
  writeFixturePackageJson(pluginRoot, pluginId);
  fs.writeFileSync(
    path.join(pluginRoot, "api.js"),
    `export const marker = ${JSON.stringify(params.marker)};\n`,
    "utf8",
  );
  return { bundledPluginsDir, pluginId, pluginRoot };
}

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
    const pluginRoot = path.join(bundledPluginsDir, pluginId);
    fs.mkdirSync(pluginRoot, { recursive: true });
    writeFixturePackageJson(pluginRoot, pluginId);
    fs.writeFileSync(
      path.join(pluginRoot, "config-api.js"),
      [
        'import { z } from "zod";',
        `export const ${exportName} = z.object({ dmPolicy: z.literal("pairing").default("pairing") });`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
  return bundledPluginsDir;
}

function createPackageSourcePluginFixture(params: {
  prefix: string;
  marker: string;
}): TrustedBundledPluginFixture {
  const bundledPluginsDir = path.join(packageRoot, "extensions");
  const pluginId = nextTrustedPluginId(params.prefix);
  const pluginRoot = path.join(bundledPluginsDir, pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  trustedBundledPluginFixtureRoots.push(pluginRoot);
  writeFixturePackageJson(pluginRoot, pluginId);
  fs.writeFileSync(
    path.join(pluginRoot, "api.ts"),
    `export const marker = ${JSON.stringify(params.marker)};\n`,
    "utf8",
  );
  return { bundledPluginsDir, pluginId, pluginRoot };
}

function createCircularPluginFixture(prefix: string): TrustedBundledPluginFixture {
  const bundledPluginsDir = createTrustedBundledPluginsRoot();
  const pluginId = nextTrustedPluginId(prefix);
  const pluginRoot = path.join(bundledPluginsDir, pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  trustedBundledPluginFixtureRoots.push(pluginRoot);
  writeFixturePackageJson(pluginRoot, pluginId);
  fs.writeFileSync(
    path.join(pluginRoot, "facade.mjs"),
    [
      `const loadBundledPluginPublicSurfaceModuleSyncCore = globalThis.${FACADE_LOADER_GLOBAL};`,
      `if (typeof loadBundledPluginPublicSurfaceModuleSyncCore !== "function") {`,
      '  throw new Error("missing facade loader test loader");',
      "}",
      `export const marker = loadBundledPluginPublicSurfaceModuleSyncCore({ dirName: ${JSON.stringify(
        pluginId,
      )}, artifactBasename: "api.js" }).marker;`,
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "helper.js"),
    ['import { marker } from "./facade.mjs";', "export const circularMarker = marker;", ""].join(
      "\n",
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "api.js"),
    ['import "./helper.js";', 'export const marker = "circular-ok";', ""].join("\n"),
    "utf8",
  );
  return { bundledPluginsDir, pluginId, pluginRoot };
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
  resetFacadeLoaderStateForTest();
  for (const dir of trustedBundledPluginFixtureRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete (globalThis as typeof globalThis & Record<string, unknown>)[FACADE_LOADER_GLOBAL];
  originalEnv.restore();
});

describe("plugin-sdk facade loader", () => {
  it("preserves object and accessor semantics through preventExtensions", () => {
    const method = function (this: unknown) {
      return this;
    };
    const original = {
      value: 1,
      method,
    };
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
    const fixture = createPackageSourcePluginFixture({
      prefix: "openclaw-facade-loader-source-fallback-",
      marker: "source-fallback",
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = createTempDirSync("openclaw-facade-loader-empty-");

    const loaded = loadBundledPluginPublicSurfaceModuleSyncCore<{
      marker: string;
    }>({
      dirName: fixture.pluginId,
      artifactBasename: "api.js",
    });

    expect(loaded.marker).toBe("source-fallback");
  });

  it("keeps bundled facade loads disabled when bundled plugins are disabled", () => {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

    const error = captureThrownError(() =>
      loadBundledPluginPublicSurfaceModuleSyncCore({
        dirName: "browser",
        artifactBasename: "browser-maintenance.js",
      }),
    );

    expect(error).toBeInstanceOf(MissingPublicSurfaceError);
    expect(error.message).toBe(
      "Unable to resolve bundled plugin public surface browser/browser-maintenance.js",
    );
  });

  it("open failures are not classified as MissingPublicSurfaceError", () => {
    const tempRoot = createTempDirSync("openclaw-facade-loader-boundary-fail-");
    const boundaryRoot = path.join(tempRoot, "plugin");
    const outsidePath = path.join(tempRoot, "outside.js");
    fs.mkdirSync(boundaryRoot, { recursive: true });
    fs.writeFileSync(outsidePath, 'export const marker = "outside";\n', "utf8");

    const error = captureThrownError(() =>
      loadFacadeModuleAtLocationSync({
        location: { modulePath: outsidePath, boundaryRoot },
        trackedPluginId: "boundary-failure",
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MissingPublicSurfaceError);
    expect(error.message).toBe(
      `Unable to open bundled plugin public surface ${outsidePath}: outside plugin root`,
    );
  });

  it("shares loaded facade ids with facade-runtime", () => {
    const fixture = createBundledPluginFixture({
      prefix: "openclaw-facade-loader-ids-",
      marker: "identity-check",
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = fixture.bundledPluginsDir;

    const first = loadBundledPluginPublicSurfaceModuleSyncCore<{ marker: string }>({
      dirName: fixture.pluginId,
      artifactBasename: "api.js",
    });
    const second = loadBundledPluginPublicSurfaceModuleSyncCore<{ marker: string }>({
      dirName: fixture.pluginId,
      artifactBasename: "api.js",
    });

    expect(first).toBe(second);
    expect(first.marker).toBe("identity-check");
    expect(listImportedBundledPluginFacadeIds()).toEqual([fixture.pluginId]);
    expect(listImportedFacadeRuntimeIds()).toEqual([fixture.pluginId]);
  });

  it("reloads replaced facade artifacts and dependencies without erasing imported-plugin history", () => {
    const pluginRoot = fs.realpathSync(createTempDirSync("openclaw-facade-replacement-"));
    const modulePath = path.join(pluginRoot, "api.js");
    const dependencyPath = path.join(pluginRoot, "dependency.js");
    fs.writeFileSync(path.join(pluginRoot, "package.json"), '{"type":"commonjs"}\n', "utf8");

    const writeArtifact = (marker: string) => {
      fs.writeFileSync(dependencyPath, `module.exports = ${JSON.stringify(marker)};\n`, "utf8");
      fs.writeFileSync(modulePath, 'module.exports = { marker: require("./dependency.js") };\n');
    };
    const loadArtifact = () =>
      loadFacadeModuleAtLocationSync<{ marker: string }>({
        location: { modulePath, boundaryRoot: pluginRoot },
        trackedPluginId: "replacement-plugin",
      }).marker;

    writeArtifact("retired");
    expect(loadArtifact()).toBe("retired");

    writeArtifact("replacement");
    expect(loadArtifact()).toBe("retired");

    clearPluginMetadataLifecycleCaches();

    expect(listImportedBundledPluginFacadeIds()).toContain("replacement-plugin");
    expect(loadArtifact()).toBe("replacement");
  });

  it("breaks circular facade re-entry during module evaluation", () => {
    const fixture = createCircularPluginFixture("openclaw-facade-loader-circular-");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = fixture.bundledPluginsDir;
    (globalThis as typeof globalThis & Record<string, unknown>)[FACADE_LOADER_GLOBAL] =
      loadBundledPluginPublicSurfaceModuleSyncCore;

    const loaded = loadBundledPluginPublicSurfaceModuleSyncCore<{ marker: string }>({
      dirName: fixture.pluginId,
      artifactBasename: "api.js",
    });

    expect(loaded.marker).toBe("circular-ok");
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
