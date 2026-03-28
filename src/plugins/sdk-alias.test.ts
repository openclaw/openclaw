import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  listPluginSdkAliasCandidates,
  listPluginSdkExportedSubpaths,
  resolveExtensionApiAlias,
  resolvePluginRuntimeModulePath,
  resolvePluginSdkAliasFile,
  shouldPreferNativeJiti,
} from "./sdk-alias.js";
import { makeTrackedTempDir, mkdirSafeDir } from "./test-helpers/fs-fixtures.js";

type CreateJiti = typeof import("jiti").createJiti;

let createJitiPromise: Promise<CreateJiti> | undefined;

async function getCreateJiti() {
  createJitiPromise ??= import("jiti").then(({ createJiti }) => createJiti);
  return createJitiPromise;
}

const fixtureTempDirs: string[] = [];
const fixtureRoot = makeTrackedTempDir("openclaw-sdk-alias-root", fixtureTempDirs);
let tempDirIndex = 0;

function makeTempDir() {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  mkdirSafeDir(dir);
  return dir;
}

function withCwd<T>(cwd: string, run: () => T): T {
  const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
  try {
    return run();
  } finally {
    cwdSpy.mockRestore();
  }
}

function createPluginSdkAliasFixture(params?: {
  srcFile?: string;
  distFile?: string;
  srcBody?: string;
  distBody?: string;
  packageName?: string;
  packageExports?: Record<string, unknown>;
  trustedRootIndicators?: boolean;
  trustedRootIndicatorMode?: "bin+marker" | "cli-entry-only" | "none";
}) {
  const root = makeTempDir();
  const srcFile = path.join(root, "src", "plugin-sdk", params?.srcFile ?? "index.ts");
  const distFile = path.join(root, "dist", "plugin-sdk", params?.distFile ?? "index.js");
  mkdirSafeDir(path.dirname(srcFile));
  mkdirSafeDir(path.dirname(distFile));
  const trustedRootIndicatorMode =
    params?.trustedRootIndicatorMode ??
    (params?.trustedRootIndicators === false ? "none" : "bin+marker");
  const packageJson: Record<string, unknown> = {
    name: params?.packageName ?? "openclaw",
    type: "module",
  };
  if (trustedRootIndicatorMode === "bin+marker") {
    packageJson.bin = {
      openclaw: "openclaw.mjs",
    };
  }
  if (params?.packageExports || trustedRootIndicatorMode === "cli-entry-only") {
    const trustedExports: Record<string, unknown> =
      trustedRootIndicatorMode === "cli-entry-only"
        ? { "./cli-entry": { default: "./dist/cli-entry.js" } }
        : {};
    packageJson.exports = {
      "./plugin-sdk": { default: "./dist/plugin-sdk/index.js" },
      ...trustedExports,
      ...params?.packageExports,
    };
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson, null, 2), "utf-8");
  if (trustedRootIndicatorMode === "bin+marker") {
    fs.writeFileSync(path.join(root, "openclaw.mjs"), "export {};\n", "utf-8");
  }
  fs.writeFileSync(srcFile, params?.srcBody ?? "export {};\n", "utf-8");
  fs.writeFileSync(distFile, params?.distBody ?? "export {};\n", "utf-8");
  return { root, srcFile, distFile };
}

function createExtensionApiAliasFixture(params?: { srcBody?: string; distBody?: string }) {
  const root = makeTempDir();
  const srcFile = path.join(root, "src", "extensionAPI.ts");
  const distFile = path.join(root, "dist", "extensionAPI.js");
  mkdirSafeDir(path.dirname(srcFile));
  mkdirSafeDir(path.dirname(distFile));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(path.join(root, "openclaw.mjs"), "export {};\n", "utf-8");
  fs.writeFileSync(srcFile, params?.srcBody ?? "export {};\n", "utf-8");
  fs.writeFileSync(distFile, params?.distBody ?? "export {};\n", "utf-8");
  return { root, srcFile, distFile };
}

function createPluginRuntimeAliasFixture(params?: { srcBody?: string; distBody?: string }) {
  const root = makeTempDir();
  const srcFile = path.join(root, "src", "plugins", "runtime", "index.ts");
  const distFile = path.join(root, "dist", "plugins", "runtime", "index.js");
  mkdirSafeDir(path.dirname(srcFile));
  mkdirSafeDir(path.dirname(distFile));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    srcFile,
    params?.srcBody ?? "export const createPluginRuntime = () => ({});\n",
    "utf-8",
  );
  fs.writeFileSync(
    distFile,
    params?.distBody ?? "export const createPluginRuntime = () => ({});\n",
    "utf-8",
  );
  return { root, srcFile, distFile };
}

function createPluginSdkAliasTargetFixture() {
  const fixture = createPluginSdkAliasFixture({
    srcFile: "channel-runtime.ts",
    distFile: "channel-runtime.js",
    packageExports: {
      "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
    },
  });
  const sourceRootAlias = path.join(fixture.root, "src", "plugin-sdk", "root-alias.cjs");
  const distRootAlias = path.join(fixture.root, "dist", "plugin-sdk", "root-alias.cjs");
  fs.writeFileSync(sourceRootAlias, "module.exports = {};\n", "utf-8");
  fs.writeFileSync(distRootAlias, "module.exports = {};\n", "utf-8");
  return { fixture, sourceRootAlias, distRootAlias };
}

function writePluginEntry(root: string, relativePath: string) {
  const pluginEntry = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(pluginEntry), { recursive: true });
  fs.writeFileSync(pluginEntry, 'export const plugin = "demo";\n', "utf-8");
  return pluginEntry;
}

function createUserInstalledPluginSdkAliasFixture() {
  const { fixture, sourceRootAlias } = createPluginSdkAliasTargetFixture();
  const externalPluginRoot = path.join(makeTempDir(), ".openclaw", "extensions", "demo");
  const externalPluginEntry = path.join(externalPluginRoot, "index.ts");
  mkdirSafeDir(externalPluginRoot);
  fs.writeFileSync(externalPluginEntry, 'export const plugin = "demo";\n', "utf-8");
  return { externalPluginEntry, externalPluginRoot, fixture, sourceRootAlias };
}

function resolvePluginSdkAlias(params: {
  srcFile: string;
  distFile: string;
  modulePath: string;
  argv1?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const run = () =>
    resolvePluginSdkAliasFile({
      srcFile: params.srcFile,
      distFile: params.distFile,
      modulePath: params.modulePath,
      argv1: params.argv1,
    });
  return params.env ? withEnv(params.env, run) : run();
}

function resolvePluginRuntimeModule(params: {
  modulePath: string;
  argv1?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const run = () =>
    resolvePluginRuntimeModulePath({
      modulePath: params.modulePath,
      argv1: params.argv1,
    });
  return params.env ? withEnv(params.env, run) : run();
}

function expectResolvedFixturePath(params: {
  resolved: string | null;
  fixture: { srcFile: string; distFile: string };
  expected: "src" | "dist";
}) {
  expect(params.resolved).toBe(
    params.expected === "dist" ? params.fixture.distFile : params.fixture.srcFile,
  );
}

function expectPluginSdkAliasTargets(
  aliases: Record<string, string | undefined>,
  params: {
    rootAliasPath: string;
    channelRuntimePath?: string;
  },
) {
  expect(fs.realpathSync(aliases["openclaw/plugin-sdk"] ?? "")).toBe(
    fs.realpathSync(params.rootAliasPath),
  );
  if (params.channelRuntimePath) {
    expect(fs.realpathSync(aliases["openclaw/plugin-sdk/channel-runtime"] ?? "")).toBe(
      fs.realpathSync(params.channelRuntimePath),
    );
  }
}

function expectPluginSdkAliasResolution(params: {
  fixture: { root: string; srcFile: string; distFile: string };
  srcFile: string;
  distFile: string;
  modulePath: (root: string) => string;
  argv1?: (root: string) => string;
  env?: NodeJS.ProcessEnv;
  expected: "src" | "dist";
}) {
  const resolved = resolvePluginSdkAlias({
    srcFile: params.srcFile,
    distFile: params.distFile,
    modulePath: params.modulePath(params.fixture.root),
    argv1: params.argv1?.(params.fixture.root),
    env: params.env,
  });
  expectResolvedFixturePath({
    resolved,
    fixture: params.fixture,
    expected: params.expected,
  });
}

function expectExtensionApiAliasResolution(params: {
  fixture: { root: string; srcFile: string; distFile: string };
  modulePath: (root: string) => string;
  argv1?: (root: string) => string;
  env?: NodeJS.ProcessEnv;
  expected: "src" | "dist";
}) {
  const resolved = withEnv(params.env ?? {}, () =>
    resolveExtensionApiAlias({
      modulePath: params.modulePath(params.fixture.root),
      argv1: params.argv1?.(params.fixture.root),
    }),
  );
  expectResolvedFixturePath({
    resolved,
    fixture: params.fixture,
    expected: params.expected,
  });
}

function expectExportedSubpaths(params: {
  fixture: { root: string };
  modulePath: string;
  expected: readonly string[];
  cwd?: string;
}) {
  const run = () =>
    listPluginSdkExportedSubpaths({
      modulePath: params.modulePath,
    });
  const subpaths = params.cwd ? withCwd(params.cwd, run) : run();
  expect(subpaths).toEqual(params.expected);
}

function expectCwdFallbackPluginSdkAliasResolution(params: {
  fixture: { root: string; srcFile: string; distFile: string };
  expected: "src" | "dist" | null;
}) {
  const resolved = withCwd(params.fixture.root, () =>
    resolvePluginSdkAlias({
      srcFile: "channel-runtime.ts",
      distFile: "channel-runtime.js",
      modulePath: "/tmp/tsx-cache/openclaw-loader.js",
      env: { NODE_ENV: undefined },
    }),
  );
  if (params.expected === null) {
    expect(resolved).toBeNull();
    return;
  }
  expectResolvedFixturePath({
    resolved,
    fixture: params.fixture,
    expected: params.expected,
  });
}

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("plugin sdk alias helpers", () => {
  it.each([
    {
      name: "prefers dist plugin-sdk alias when loader runs from dist",
      buildFixture: () => createPluginSdkAliasFixture(),
      modulePath: (root: string) => path.join(root, "dist", "plugins", "loader.js"),
      srcFile: "index.ts",
      distFile: "index.js",
      expected: "dist" as const,
    },
    {
      name: "prefers src plugin-sdk alias when loader runs from src in non-production",
      buildFixture: () => createPluginSdkAliasFixture(),
      modulePath: (root: string) => path.join(root, "src", "plugins", "loader.ts"),
      srcFile: "index.ts",
      distFile: "index.js",
      env: { NODE_ENV: undefined },
      expected: "src" as const,
    },
    {
      name: "falls back to src plugin-sdk alias when dist is missing in production",
      buildFixture: () => {
        const fixture = createPluginSdkAliasFixture();
        fs.rmSync(fixture.distFile);
        return fixture;
      },
      modulePath: (root: string) => path.join(root, "src", "plugins", "loader.ts"),
      srcFile: "index.ts",
      distFile: "index.js",
      env: { NODE_ENV: "production", VITEST: undefined },
      expected: "src" as const,
    },
    {
      name: "prefers dist root-alias shim when loader runs from dist",
      buildFixture: () =>
        createPluginSdkAliasFixture({
          srcFile: "root-alias.cjs",
          distFile: "root-alias.cjs",
          srcBody: "module.exports = {};\n",
          distBody: "module.exports = {};\n",
        }),
      modulePath: (root: string) => path.join(root, "dist", "plugins", "loader.js"),
      srcFile: "root-alias.cjs",
      distFile: "root-alias.cjs",
      expected: "dist" as const,
    },
    {
      name: "prefers src root-alias shim when loader runs from src in non-production",
      buildFixture: () =>
        createPluginSdkAliasFixture({
          srcFile: "root-alias.cjs",
          distFile: "root-alias.cjs",
          srcBody: "module.exports = {};\n",
          distBody: "module.exports = {};\n",
        }),
      modulePath: (root: string) => path.join(root, "src", "plugins", "loader.ts"),
      srcFile: "root-alias.cjs",
      distFile: "root-alias.cjs",
      env: { NODE_ENV: undefined },
      expected: "src" as const,
    },
    {
      name: "resolves plugin-sdk alias from package root when loader runs from transpiler cache path",
      buildFixture: () =>
        createPluginSdkAliasFixture({
          packageExports: {
            "./plugin-sdk/index": { default: "./dist/plugin-sdk/index.js" },
          },
        }),
      modulePath: () => "/tmp/tsx-cache/openclaw-loader.js",
      argv1: (root: string) => path.join(root, "openclaw.mjs"),
      srcFile: "index.ts",
      distFile: "index.js",
      env: { NODE_ENV: undefined },
      expected: "src" as const,
    },
  ])("$name", ({ buildFixture, modulePath, argv1, srcFile, distFile, env, expected }) => {
    const fixture = buildFixture();
    expectPluginSdkAliasResolution({
      fixture,
      srcFile,
      distFile,
      modulePath,
      argv1,
      env,
      expected,
    });
  });

  it.each([
    {
      name: "prefers dist extension-api alias when loader runs from dist",
      modulePath: (root: string) => path.join(root, "dist", "plugins", "loader.js"),
      expected: "dist" as const,
    },
    {
      name: "prefers src extension-api alias when loader runs from src in non-production",
      modulePath: (root: string) => path.join(root, "src", "plugins", "loader.ts"),
      env: { NODE_ENV: undefined },
      expected: "src" as const,
    },
    {
      name: "resolves extension-api alias from package root when loader runs from transpiler cache path",
      modulePath: () => "/tmp/tsx-cache/openclaw-loader.js",
      argv1: (root: string) => path.join(root, "openclaw.mjs"),
      env: { NODE_ENV: undefined },
      expected: "src" as const,
    },
  ])("$name", ({ modulePath, argv1, env, expected }) => {
    const fixture = createExtensionApiAliasFixture();
    expectExtensionApiAliasResolution({
      fixture,
      modulePath,
      argv1,
      env,
      expected,
    });
  });

  it.each([
    {
      name: "prefers dist candidates first for production src runtime",
      env: { NODE_ENV: "production", VITEST: undefined },
      expectedFirst: "dist" as const,
    },
    {
      name: "prefers src candidates first for non-production src runtime",
      env: { NODE_ENV: undefined },
      expectedFirst: "src" as const,
    },
  ])("$name", ({ env, expectedFirst }) => {
    const fixture = createPluginSdkAliasFixture();
    const candidates = withEnv(env ?? {}, () =>
      listPluginSdkAliasCandidates({
        srcFile: "index.ts",
        distFile: "index.js",
        modulePath: path.join(fixture.root, "src", "plugins", "loader.ts"),
      }),
    );
    const first = expectedFirst === "dist" ? fixture.distFile : fixture.srcFile;
    const second = expectedFirst === "dist" ? fixture.srcFile : fixture.distFile;
    expect(candidates.indexOf(first)).toBeLessThan(candidates.indexOf(second));
  });

  it("derives plugin-sdk subpaths from package exports", () => {
    const fixture = createPluginSdkAliasFixture({
      packageExports: {
        "./plugin-sdk/compat": { default: "./dist/plugin-sdk/compat.js" },
        "./plugin-sdk/telegram": { default: "./dist/plugin-sdk/telegram.js" },
        "./plugin-sdk/nested/value": { default: "./dist/plugin-sdk/nested/value.js" },
        "./plugin-sdk/..\\..\\evil": { default: "./dist/plugin-sdk/evil.js" },
        "./plugin-sdk/C:temp": { default: "./dist/plugin-sdk/drive.js" },
        "./plugin-sdk/.hidden": { default: "./dist/plugin-sdk/hidden.js" },
      },
    });
    const subpaths = listPluginSdkExportedSubpaths({
      modulePath: path.join(fixture.root, "src", "plugins", "loader.ts"),
    });
    expect(subpaths).toEqual(["compat", "telegram"]);
  });

  it("derives plugin-sdk subpaths from nearest package exports even when package name is renamed", () => {
    const fixture = createPluginSdkAliasFixture({
      packageName: "moltbot",
      packageExports: {
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
        "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
        "./plugin-sdk/compat": { default: "./dist/plugin-sdk/compat.js" },
      },
    });
    const subpaths = listPluginSdkExportedSubpaths({
      modulePath: path.join(fixture.root, "src", "plugins", "loader.ts"),
    });
    expect(subpaths).toEqual(["channel-runtime", "compat", "core"]);
  });

  it.each([
    {
      name: "derives plugin-sdk subpaths via cwd fallback when module path is a transpiler cache and package is renamed",
      fixture: () =>
        createPluginSdkAliasFixture({
          packageName: "moltbot",
          packageExports: {
            "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
            "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
          },
        }),
      expected: ["channel-runtime", "core"],
    },
    {
      name: "does not derive plugin-sdk subpaths from cwd fallback when package root is not an OpenClaw root",
      fixture: () =>
        createPluginSdkAliasFixture({
          packageName: "moltbot",
          trustedRootIndicators: false,
          packageExports: {
            "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
            "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
          },
        }),
      expected: [],
    },
    {
      name: "derives plugin-sdk subpaths via cwd fallback when trusted root indicator is cli-entry export",
      fixture: () =>
        createPluginSdkAliasFixture({
          packageName: "moltbot",
          trustedRootIndicatorMode: "cli-entry-only",
          packageExports: {
            "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
            "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
          },
        }),
      expected: ["channel-runtime", "core"],
    },
  ] as const)("$name", ({ fixture: buildFixture, expected }) => {
    const fixture = buildFixture();
    expectExportedSubpaths({
      fixture,
      cwd: fixture.root,
      modulePath: "/tmp/tsx-cache/openclaw-loader.js",
      expected,
    });
  });

  it("builds plugin-sdk aliases from the module being loaded, not the loader location", () => {
    const { fixture, sourceRootAlias, distRootAlias } = createPluginSdkAliasTargetFixture();
    const sourcePluginEntry = writePluginEntry(fixture.root, "extensions/demo/src/index.ts");

    const sourceAliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry),
    );
    expectPluginSdkAliasTargets(sourceAliases, {
      rootAliasPath: sourceRootAlias,
      channelRuntimePath: path.join(fixture.root, "src", "plugin-sdk", "channel-runtime.ts"),
    });

    const distPluginEntry = writePluginEntry(fixture.root, "dist/extensions/demo/index.js");

    const distAliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(distPluginEntry),
    );
    expectPluginSdkAliasTargets(distAliases, {
      rootAliasPath: distRootAlias,
      channelRuntimePath: path.join(fixture.root, "dist", "plugin-sdk", "channel-runtime.js"),
    });
  });

  it("applies explicit dist resolution to plugin-sdk subpath aliases too", () => {
    const { fixture, distRootAlias } = createPluginSdkAliasTargetFixture();
    const sourcePluginEntry = writePluginEntry(fixture.root, "extensions/demo/src/index.ts");

    const distAliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry, undefined, undefined, "dist"),
    );

    expectPluginSdkAliasTargets(distAliases, {
      rootAliasPath: distRootAlias,
      channelRuntimePath: path.join(fixture.root, "dist", "plugin-sdk", "channel-runtime.js"),
    });
  });

  it("resolves plugin-sdk aliases for user-installed plugins via the running openclaw argv hint", () => {
    const { externalPluginEntry, externalPluginRoot, fixture, sourceRootAlias } =
      createUserInstalledPluginSdkAliasFixture();

    const aliases = withCwd(externalPluginRoot, () =>
      withEnv({ NODE_ENV: undefined }, () =>
        buildPluginLoaderAliasMap(externalPluginEntry, path.join(fixture.root, "openclaw.mjs")),
      ),
    );

    expectPluginSdkAliasTargets(aliases, {
      rootAliasPath: sourceRootAlias,
      channelRuntimePath: path.join(fixture.root, "src", "plugin-sdk", "channel-runtime.ts"),
    });
  });

  it("resolves plugin-sdk aliases for user-installed plugins via moduleUrl hint", () => {
    const { externalPluginEntry, externalPluginRoot, fixture, sourceRootAlias } =
      createUserInstalledPluginSdkAliasFixture();

    // Simulate loader.ts passing its own import.meta.url as the moduleUrl hint.
    // This covers installations where argv1 does not resolve to the openclaw root
    // (e.g. single-binary distributions or custom process launchers).
    // Use openclaw.mjs which is created by createPluginSdkAliasFixture (bin+marker mode).
    // Use fixture.root as cwd so process.cwd() fallback also resolves to fixture, not the
    // real openclaw repo root in the test runner environment.
    const loaderModuleUrl = pathToFileURL(path.join(fixture.root, "openclaw.mjs")).href;

    // Use externalPluginRoot as cwd so process.cwd() fallback cannot accidentally
    // resolve to the fixture root — only the moduleUrl hint can bridge the gap.
    // Pass "" for argv1: undefined would trigger the STARTUP_ARGV1 default (the vitest
    // runner binary, inside the openclaw repo), which resolves before moduleUrl is checked.
    // An empty string is falsy so resolveTrustedOpenClawRootFromArgvHint returns null,
    // meaning only the moduleUrl hint can bridge the gap.
    const aliases = withCwd(externalPluginRoot, () =>
      withEnv({ NODE_ENV: undefined }, () =>
        buildPluginLoaderAliasMap(
          externalPluginEntry,
          "", // explicitly disable argv1 (empty string bypasses STARTUP_ARGV1 default)
          loaderModuleUrl,
        ),
      ),
    );

    expectPluginSdkAliasTargets(aliases, {
      rootAliasPath: sourceRootAlias,
      channelRuntimePath: path.join(fixture.root, "src", "plugin-sdk", "channel-runtime.ts"),
    });
  });

  it.each([
    {
      name: "resolves plugin-sdk alias files via cwd fallback when module path is a transpiler cache and package is renamed",
      fixture: () =>
        createPluginSdkAliasFixture({
          srcFile: "channel-runtime.ts",
          distFile: "channel-runtime.js",
          packageName: "moltbot",
          packageExports: {
            "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
          },
        }),
      expected: "src" as const,
    },
    {
      name: "does not resolve plugin-sdk alias files from cwd fallback when package root is not an OpenClaw root",
      fixture: () =>
        createPluginSdkAliasFixture({
          srcFile: "channel-runtime.ts",
          distFile: "channel-runtime.js",
          packageName: "moltbot",
          trustedRootIndicators: false,
          packageExports: {
            "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
          },
        }),
      expected: null,
    },
  ] as const)("$name", ({ fixture: buildFixture, expected }) => {
    const fixture = buildFixture();
    expectCwdFallbackPluginSdkAliasResolution({
      fixture,
      expected,
    });
  });

  it("configures the plugin loader jiti boundary to prefer native dist modules", () => {
    const options = buildPluginLoaderJitiOptions({});

    expect(options.tryNative).toBe(true);
    expect(options.interopDefault).toBe(true);
    expect(options.extensions).toContain(".js");
    expect(options.extensions).toContain(".ts");
    expect("alias" in options).toBe(false);
  });

  it("uses transpiled Jiti loads for source TypeScript plugin entries", () => {
    expect(shouldPreferNativeJiti("/repo/dist/plugins/runtime/index.js")).toBe(true);
    expect(shouldPreferNativeJiti("/repo/extensions/discord/src/channel.runtime.ts")).toBe(false);
  });

  it("disables native Jiti loads under Bun even for built JavaScript entries", () => {
    const originalVersions = process.versions;
    Object.defineProperty(process, "versions", {
      configurable: true,
      value: {
        ...originalVersions,
        bun: "1.2.0",
      },
    });

    try {
      expect(shouldPreferNativeJiti("/repo/dist/plugins/runtime/index.js")).toBe(false);
      expect(shouldPreferNativeJiti("/repo/dist/extensions/browser/index.js")).toBe(false);
    } finally {
      Object.defineProperty(process, "versions", {
        configurable: true,
        value: originalVersions,
      });
    }
  });

  it("loads source runtime shims through the non-native Jiti boundary", async () => {
    const copiedExtensionRoot = path.join(makeTempDir(), "extensions", "discord");
    const copiedSourceDir = path.join(copiedExtensionRoot, "src");
    const copiedPluginSdkDir = path.join(copiedExtensionRoot, "plugin-sdk");
    mkdirSafeDir(copiedSourceDir);
    mkdirSafeDir(copiedPluginSdkDir);
    const jitiBaseFile = path.join(copiedSourceDir, "__jiti-base__.mjs");
    fs.writeFileSync(jitiBaseFile, "export {};\n", "utf-8");
    fs.writeFileSync(
      path.join(copiedSourceDir, "channel.runtime.ts"),
      `import { resolveOutboundSendDep } from "openclaw/plugin-sdk/infra-runtime";

export const syntheticRuntimeMarker = {
  resolveOutboundSendDep,
};
`,
      "utf-8",
    );
    const copiedChannelRuntimeShim = path.join(copiedPluginSdkDir, "infra-runtime.ts");
    fs.writeFileSync(
      copiedChannelRuntimeShim,
      `export function resolveOutboundSendDep() {
  return "shimmed";
}
`,
      "utf-8",
    );
    const copiedChannelRuntime = path.join(copiedExtensionRoot, "src", "channel.runtime.ts");
    const jitiBaseUrl = pathToFileURL(jitiBaseFile).href;

    const createJiti = await getCreateJiti();
    const withoutAlias = createJiti(jitiBaseUrl, {
      ...buildPluginLoaderJitiOptions({}),
      tryNative: false,
    });
    expect(() => withoutAlias(copiedChannelRuntime)).toThrow();

    const withAlias = createJiti(jitiBaseUrl, {
      ...buildPluginLoaderJitiOptions({
        "openclaw/plugin-sdk/infra-runtime": copiedChannelRuntimeShim,
      }),
      tryNative: false,
    });
    expect(withAlias(copiedChannelRuntime)).toMatchObject({
      syntheticRuntimeMarker: {
        resolveOutboundSendDep: expect.any(Function),
      },
    });
  }, 240_000);

  it.each([
    {
      name: "prefers dist plugin runtime module when loader runs from dist",
      modulePath: (root: string) => path.join(root, "dist", "plugins", "loader.js"),
      expected: "dist" as const,
    },
    {
      name: "resolves plugin runtime module from package root when loader runs from transpiler cache path",
      modulePath: () => "/tmp/tsx-cache/openclaw-loader.js",
      argv1: (root: string) => path.join(root, "openclaw.mjs"),
      env: { NODE_ENV: undefined },
      expected: "src" as const,
    },
  ])("$name", ({ modulePath, argv1, env, expected }) => {
    const fixture = createPluginRuntimeAliasFixture();
    const resolved = resolvePluginRuntimeModule({
      modulePath: modulePath(fixture.root),
      argv1: argv1?.(fixture.root),
      env,
    });
    expect(resolved).toBe(expected === "dist" ? fixture.distFile : fixture.srcFile);
  });
});
