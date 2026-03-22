import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
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

type CreateJiti = typeof import("jiti").createJiti;

let createJitiPromise: Promise<CreateJiti> | undefined;

async function getCreateJiti() {
  createJitiPromise ??= import("jiti").then(({ createJiti }) => createJiti);
  return createJitiPromise;
}

function chmodSafeDir(dir: string) {
  if (process.platform === "win32") {
    return;
  }
  fs.chmodSync(dir, 0o755);
}

function mkdtempSafe(prefix: string) {
  const dir = fs.mkdtempSync(prefix);
  chmodSafeDir(dir);
  return dir;
}

function mkdirSafe(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  chmodSafeDir(dir);
}

const fixtureRoot = mkdtempSafe(path.join(os.tmpdir(), "openclaw-sdk-alias-"));
let tempDirIndex = 0;

function makeTempDir() {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  mkdirSafe(dir);
  return dir;
}

function withCwd<T>(cwd: string, run: () => T): T {
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    return run();
  } finally {
    process.chdir(previousCwd);
  }
}

function withArgv1<T>(argv1: string | undefined, run: () => T): T {
  const previousArgv = [...process.argv];
  if (argv1 === undefined) {
    process.argv.splice(1, 1);
  } else {
    process.argv[1] = argv1;
  }
  try {
    return run();
  } finally {
    process.argv.splice(0, process.argv.length, ...previousArgv);
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
  mkdirSafe(path.dirname(srcFile));
  mkdirSafe(path.dirname(distFile));
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
  mkdirSafe(path.dirname(srcFile));
  mkdirSafe(path.dirname(distFile));
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
  mkdirSafe(path.dirname(srcFile));
  mkdirSafe(path.dirname(distFile));
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
      buildFixture: () => createPluginSdkAliasFixture(),
      modulePath: () => "/tmp/tsx-cache/openclaw-loader.js",
      argv1: (root: string) => path.join(root, "openclaw.mjs"),
      srcFile: "index.ts",
      distFile: "index.js",
      env: { NODE_ENV: undefined },
      expected: "src" as const,
    },
  ])("$name", ({ buildFixture, modulePath, argv1, srcFile, distFile, env, expected }) => {
    const fixture = buildFixture();
    const resolved = resolvePluginSdkAlias({
      srcFile,
      distFile,
      modulePath: modulePath(fixture.root),
      argv1: argv1?.(fixture.root),
      env,
    });
    expect(resolved).toBe(expected === "dist" ? fixture.distFile : fixture.srcFile);
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
    const resolved = withEnv(env ?? {}, () =>
      resolveExtensionApiAlias({
        modulePath: modulePath(fixture.root),
        argv1: argv1?.(fixture.root),
      }),
    );
    expect(resolved).toBe(expected === "dist" ? fixture.distFile : fixture.srcFile);
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

  it("derives plugin-sdk subpaths via cwd fallback when module path is a transpiler cache and package is renamed", () => {
    const fixture = createPluginSdkAliasFixture({
      packageName: "moltbot",
      packageExports: {
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
        "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
      },
    });
    const subpaths = withCwd(fixture.root, () =>
      listPluginSdkExportedSubpaths({
        modulePath: "/tmp/tsx-cache/openclaw-loader.js",
      }),
    );
    expect(subpaths).toEqual(["channel-runtime", "core"]);
  });

  it("resolves plugin-sdk alias files via cwd fallback when module path is a transpiler cache and package is renamed", () => {
    const fixture = createPluginSdkAliasFixture({
      srcFile: "channel-runtime.ts",
      distFile: "channel-runtime.js",
      packageName: "moltbot",
      packageExports: {
        "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
      },
    });
    const resolved = withCwd(fixture.root, () =>
      resolvePluginSdkAlias({
        srcFile: "channel-runtime.ts",
        distFile: "channel-runtime.js",
        modulePath: "/tmp/tsx-cache/openclaw-loader.js",
        env: { NODE_ENV: undefined },
      }),
    );
    expect(resolved).not.toBeNull();
    expect(fs.realpathSync(resolved ?? "")).toBe(fs.realpathSync(fixture.srcFile));
  });

  it("does not derive plugin-sdk subpaths from cwd fallback when package root is not an OpenClaw root", () => {
    const fixture = createPluginSdkAliasFixture({
      packageName: "moltbot",
      trustedRootIndicators: false,
      packageExports: {
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
        "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
      },
    });
    const subpaths = withCwd(fixture.root, () =>
      listPluginSdkExportedSubpaths({
        modulePath: "/tmp/tsx-cache/openclaw-loader.js",
      }),
    );
    expect(subpaths).toEqual([]);
  });

  it("derives plugin-sdk subpaths via cwd fallback when trusted root indicator is cli-entry export", () => {
    const fixture = createPluginSdkAliasFixture({
      packageName: "moltbot",
      trustedRootIndicatorMode: "cli-entry-only",
      packageExports: {
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
        "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
      },
    });
    const subpaths = withCwd(fixture.root, () =>
      listPluginSdkExportedSubpaths({
        modulePath: "/tmp/tsx-cache/openclaw-loader.js",
      }),
    );
    expect(subpaths).toEqual(["channel-runtime", "core"]);
  });

  it("builds plugin-sdk aliases from the module being loaded, not the loader location", () => {
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
    const sourcePluginEntry = path.join(fixture.root, "extensions", "demo", "src", "index.ts");
    fs.mkdirSync(path.dirname(sourcePluginEntry), { recursive: true });
    fs.writeFileSync(sourcePluginEntry, 'export const plugin = "demo";\n', "utf-8");

    const sourceAliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry),
    );
    expect(fs.realpathSync(sourceAliases["openclaw/plugin-sdk"] ?? "")).toBe(
      fs.realpathSync(sourceRootAlias),
    );
    expect(fs.realpathSync(sourceAliases["openclaw/plugin-sdk/channel-runtime"] ?? "")).toBe(
      fs.realpathSync(path.join(fixture.root, "src", "plugin-sdk", "channel-runtime.ts")),
    );

    const distPluginEntry = path.join(fixture.root, "dist", "extensions", "demo", "index.js");
    fs.mkdirSync(path.dirname(distPluginEntry), { recursive: true });
    fs.writeFileSync(distPluginEntry, 'export const plugin = "demo";\n', "utf-8");

    const distAliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(distPluginEntry),
    );
    expect(fs.realpathSync(distAliases["openclaw/plugin-sdk"] ?? "")).toBe(
      fs.realpathSync(distRootAlias),
    );
    expect(fs.realpathSync(distAliases["openclaw/plugin-sdk/channel-runtime"] ?? "")).toBe(
      fs.realpathSync(path.join(fixture.root, "dist", "plugin-sdk", "channel-runtime.js")),
    );
  });

  it("builds plugin-sdk aliases via argv1 fallback when cwd is outside the package root", () => {
    const fixture = createPluginSdkAliasFixture({
      srcFile: "channel-runtime.ts",
      distFile: "channel-runtime.js",
      packageExports: {
        "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
      },
    });
    const unrelatedCwd = makeTempDir();
    const distPluginEntry = path.join(fixture.root, "dist", "extensions", "demo", "index.js");
    fs.mkdirSync(path.dirname(distPluginEntry), { recursive: true });
    fs.writeFileSync(distPluginEntry, 'export const plugin = "demo";\n', "utf-8");

    const aliases = withCwd(unrelatedCwd, () =>
      withArgv1(path.join(fixture.root, "openclaw.mjs"), () =>
        withEnv({ NODE_ENV: undefined }, () => buildPluginLoaderAliasMap(distPluginEntry)),
      ),
    );

    expect(fs.realpathSync(aliases["openclaw/plugin-sdk/channel-runtime"] ?? "")).toBe(
      fs.realpathSync(path.join(fixture.root, "dist", "plugin-sdk", "channel-runtime.js")),
    );
  });

  it("does not resolve plugin-sdk alias files from cwd fallback when package root is not an OpenClaw root", () => {
    const fixture = createPluginSdkAliasFixture({
      srcFile: "channel-runtime.ts",
      distFile: "channel-runtime.js",
      packageName: "moltbot",
      trustedRootIndicators: false,
      packageExports: {
        "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
      },
    });
    const resolved = withCwd(fixture.root, () =>
      resolvePluginSdkAlias({
        srcFile: "channel-runtime.ts",
        distFile: "channel-runtime.js",
        modulePath: "/tmp/tsx-cache/openclaw-loader.js",
        env: { NODE_ENV: undefined },
      }),
    );
    expect(resolved).toBeNull();
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

  it("loads source runtime shims through the non-native Jiti boundary", async () => {
    const copiedExtensionRoot = path.join(makeTempDir(), "extensions", "discord");
    const copiedSourceDir = path.join(copiedExtensionRoot, "src");
    const copiedPluginSdkDir = path.join(copiedExtensionRoot, "plugin-sdk");
    mkdirSafe(copiedSourceDir);
    mkdirSafe(copiedPluginSdkDir);
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
