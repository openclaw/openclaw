// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { createServer, type Alias } from "vite";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  hashControlUiTranslationText,
  loadControlUiTranslationMemory,
} from "../../../scripts/lib/control-ui-i18n-catalog-values.ts";
import {
  loadControlUiSourceCatalog,
  readControlUiSourceCatalog,
} from "../../../scripts/lib/control-ui-i18n-catalog.ts";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { selectControlUiRoutePreloads } from "../../../src/gateway/control-ui-route-preloads.ts";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { controlUiLocaleModulesPlugin } from "../../config/control-ui-locales.ts";
import { extractControlUiStartupAssetPaths } from "../../config/control-ui-startup-assets.ts";
import controlUiViteConfig, {
  createControlUiPrecompressedAssetVariants,
  resolveControlUiBuildInfo,
  resolveExternalPackageAliasesForVite,
  resolveSourcePackageAliasesForVite,
  resolveTsconfigPathAliasesForVite,
} from "../../vite.config.ts";
import { configHintTranslationKey } from "../i18n/lib/config-hint-translation.ts";
import type { TranslationMap } from "../i18n/lib/types.ts";
import { en } from "../i18n/locales/en.ts";

const childProcessMocks = vi.hoisted(() => {
  // Shared Node browser fixtures can load Vite before this file registers its mocks.
  vi.resetModules();
  return { execFileSync: vi.fn() };
});
const fsMocks = vi.hoisted(() => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));
const viteMocks = vi.hoisted(() => ({ runnerImport: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  childProcessMocks.execFileSync.mockImplementation(actual.execFileSync);
  return { ...actual, execFileSync: childProcessMocks.execFileSync };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsMocks.existsSync.mockImplementation(actual.existsSync);
  fsMocks.readFileSync.mockImplementation(actual.readFileSync);
  return { ...actual, existsSync: fsMocks.existsSync, readFileSync: fsMocks.readFileSync };
});

vi.mock("vite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vite")>();
  viteMocks.runnerImport.mockImplementation(actual.runnerImport);
  return { ...actual, runnerImport: viteMocks.runnerImport };
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const baseLocaleId = "\0virtual:openclaw-control-ui-locale/fr";
const commit = "0123456789abcdef0123456789abcdef01234567";
const buildInfo = {
  version: "2026.7.10",
  commit,
  commitAt: "2026-07-10T11:22:33.000Z",
  builtAt: "2026-07-10T12:34:56.000Z",
  branch: null,
  dirty: null,
  release: false,
  buildId: "mock-artifact",
};
type Catalog = TranslationMap & { common: TranslationMap };
const labeledCatalog = (label: string): Catalog => ({
  common: { health: label },
  configHints: { fixture: { label } },
});
const resolveBuildInfo = (sources: Parameters<typeof resolveControlUiBuildInfo>[0] = {}) =>
  resolveControlUiBuildInfo({
    env: {},
    readGitCommit: () => null,
    readGitBranch: () => null,
    readGitDirty: () => null,
    readPackageVersion: () => null,
    ...sources,
  });

function hook<T extends (...args: never[]) => unknown>(value: T | { handler: T } | undefined) {
  return typeof value === "function" ? value : value?.handler;
}

async function localeHooks(aliases: Alias[] = []) {
  const plugin = controlUiLocaleModulesPlugin();
  const configResolved = hook(plugin.configResolved);
  const alias = [
    ...aliases,
    ...resolveSourcePackageAliasesForVite(),
    ...resolveTsconfigPathAliasesForVite(),
  ];
  await configResolved?.call({} as never, { resolve: { alias } } as never);
  const resolveId = hook(plugin.resolveId);
  const load = hook(plugin.load);
  const watchChange = hook(plugin.watchChange);
  const buildStart = hook(plugin.buildStart);
  if (!resolveId || !load || !watchChange || !buildStart) {
    throw new Error("Expected locale module resolver, loader, and invalidation hooks");
  }
  return { buildStart, resolveId, load, watchChange };
}

async function loadLocaleSource(
  load: Awaited<ReturnType<typeof localeHooks>>["load"],
  id: string = baseLocaleId,
  addWatchFile: (path: string) => void = vi.fn(),
) {
  const result = await load.call({ addWatchFile } as never, id, {} as never);
  if (typeof result !== "string") {
    throw new Error("Expected locale module loader to return generated source");
  }
  return result;
}

function catalogImport(catalog: Catalog, startup: TranslationMap = { common: catalog.common }) {
  return {
    module: {
      loadControlUiSourceCatalog: () => catalog,
      loadControlUiStartupCatalog: () => startup,
    },
    dependencies: [],
  };
}

const watchedPaths = (addWatchFile: ReturnType<typeof vi.fn>) =>
  addWatchFile.mock.calls.map(([file]) => path.normalize(file));

const withoutMemory = (run: () => Promise<void>) =>
  fsMocks.existsSync.withImplementation(() => false, run);
const withSourceImport = (
  source: Parameters<typeof viteMocks.runnerImport.withImplementation>[0],
  run: () => Promise<void>,
) =>
  withoutMemory(async () => {
    await viteMocks.runnerImport.withImplementation(source, run);
  });
const withMemory = (memory: string, run: () => Promise<void>) =>
  fsMocks.existsSync.withImplementation(
    () => true,
    () => fsMocks.readFileSync.withImplementation(() => memory, run),
  );

function dataModuleUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function expectEncodings(
  file: string,
  source: string | Buffer,
  encodings: string[] = [],
  startup?: Set<string>,
) {
  const variants = await createControlUiPrecompressedAssetVariants(file, source, startup);
  expect(variants.map(({ fileName }) => fileName)).toEqual(
    encodings.map((ext) => `${file}.${ext}`),
  );
  return variants;
}

function expectBefore<T>(values: T[], first: T, second: T) {
  expect(values.includes(first)).toBe(true);
  expect(values.includes(second)).toBe(true);
  expect(values.indexOf(first)).toBeLessThan(values.indexOf(second));
}

async function executeLocale(
  load: Awaited<ReturnType<typeof localeHooks>>["load"],
  baseSource: string,
  deferNamespaces = false,
) {
  const lazyCatalogPath = path.join(repoRoot, "ui/src/i18n/lib/lazy-catalog.ts");
  const lazyCatalogUrl = pathToFileURL(lazyCatalogPath).href;
  let executableSource = baseSource.replace(
    JSON.stringify(lazyCatalogPath),
    JSON.stringify(lazyCatalogUrl),
  );
  const namespaces: string[] = [];
  for (const match of baseSource.matchAll(/import\("(virtual:[^"]+)"\)/g)) {
    const specifier = match[1]!;
    const namespace = specifier.startsWith("virtual:openclaw-control-ui-locale-config-hints/")
      ? "configHints"
      : specifier.split("/").at(-1)!;
    namespaces.push(namespace);
    const source = await loadLocaleSource(load, `\0${specifier}`);
    executableSource = executableSource.replace(
      JSON.stringify(specifier),
      JSON.stringify(dataModuleUrl(source)),
    );
  }
  const metadataUrl = pathToFileURL(path.join(repoRoot, "ui/src/i18n/lib/locale-catalog.ts")).href;
  executableSource += `\nexport { getLazyLocaleCatalog } from ${JSON.stringify(metadataUrl)};`;
  const module: {
    default: TranslationMap;
    getLazyLocaleCatalog: typeof import("../i18n/lib/locale-catalog.ts").getLazyLocaleCatalog;
  } = await import(dataModuleUrl(executableSource));
  const catalog = module.default;
  const loadNamespace = async (namespace: string) => {
    await module.getLazyLocaleCatalog(catalog)?.load(namespace);
  };
  const loadAll = async () => {
    for (const namespace of namespaces) {
      await loadNamespace(namespace);
    }
  };
  if (!deferNamespaces) {
    await loadAll();
  }
  return { catalog, loadNamespace, loadAll };
}

it("emits Brotli and gzip variants only for bundled compressible assets", async () => {
  const source = Array.from(
    { length: 200 },
    (_, index) => `console.log("startup-${index % 97}", ${index % 31});\n`,
  ).join("");
  const variants = await createControlUiPrecompressedAssetVariants(
    "assets/app-AbCd1234.js",
    source,
  );
  expect(variants.map((variant) => variant.fileName)).toEqual([
    "assets/app-AbCd1234.js.br",
    "assets/app-AbCd1234.js.gz",
  ]);
  expect(brotliDecompressSync(variants[0]?.source ?? Buffer.alloc(0)).toString()).toBe(source);
  expect(gunzipSync(variants[1]?.source ?? Buffer.alloc(0)).toString()).toBe(source);
  expect(createHash("sha256").update(variants[1]!.source).digest("hex")).toBe(
    "aabdc80dc704c3abc609a76c6ac3e9ae872cf023770c6ea5fbb29ffe56adfcab",
  );
  // No timestamp, filename, or host OS field may make the pinned gzip bytes host-dependent.
  expect(variants[1]!.source.subarray(0, 10).toString("hex")).toBe("1f8b08000000000002ff");
  const repeated = await createControlUiPrecompressedAssetVariants(
    "assets/app-AbCd1234.js",
    Buffer.from(source),
  );
  expect(repeated).toEqual(variants);
  for (const excluded of ["index.html", "assets/logo.png", "assets/app.js.map"]) {
    await expectEncodings(excluded, source);
  }
});

it("precompresses assets starting at 4 KiB only when the encoding saves bytes", async () => {
  await expectEncodings("assets/small.js", "x".repeat(4095));
  const boundary = "é".repeat(2048);
  const variants = await expectEncodings("assets/boundary.js", boundary, ["br", "gz"]);
  for (const variant of variants) {
    expect(variant.source.byteLength).toBeLessThan(Buffer.byteLength(boundary));
  }
  const incompressible = Buffer.concat(
    Array.from({ length: 128 }, (_, index) => createHash("sha256").update(String(index)).digest()),
  );
  await expectEncodings("assets/random.wasm", incompressible);
  // These tails produce an exactly 4096-byte Brotli or gzip output, respectively.
  incompressible.fill(0, 4096 - 29);
  await expectEncodings("assets/equal-br.wasm", incompressible);
  incompressible.fill(0, 4096 - 66);
  await expectEncodings("assets/equal-gzip.wasm", incompressible, ["br"]);
});

it("keeps small CSS and measured startup assets compressed, excluding deferred route preloads", async () => {
  const html = `
    <script type="module" src="./assets/entry.js"></script>
    <link rel="modulepreload" href="/control/assets/runtime.js">
    <template data-openclaw-route-preloads="chat">
      <link rel="modulepreload" href="./assets/chat.js">
    </template>`;
  const startupAssets = new Set(
    extractControlUiStartupAssetPaths(selectControlUiRoutePreloads(html, null)),
  );
  const source = "export const value = 123;\n".repeat(20);
  for (const fileName of ["assets/entry.js", "assets/runtime.js", "assets/lazy.css"]) {
    await expectEncodings(fileName, source, ["br", "gz"], startupAssets);
  }
  await expectEncodings("assets/chat.js", source, [], startupAssets);
  await expectEncodings("assets/tiny.css", "x", [], startupAssets);
  await expectEncodings("assets/entry.js", "x", [], startupAssets);
});

it("uses the supplied artifact identity without reading Git metadata", () => {
  childProcessMocks.execFileSync.mockClear();
  const config = controlUiViteConfig({ command: "serve", buildInfo });
  expect(config.define?.["globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO"]).toBe(
    JSON.stringify(buildInfo),
  );
  expect(childProcessMocks.execFileSync).not.toHaveBeenCalled();
});

it.each(["", "1"])(
  "selects the development watcher with CHOKIDAR_USEPOLLING=%j",
  async (polling) => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", polling);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-ui-watcher-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const config = controlUiViteConfig({ command: "serve", buildInfo: resolveBuildInfo() });
    const server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { ...config.server, middlewareMode: true, hmr: false },
    });
    try {
      // Chokidar can report polling enabled while still choosing FSEvents on macOS.
      expect(server.watcher.options.usePolling).toBe(polling === "1");
      expect(server.watcher.options.useFsEvents).toBe(false);
    } finally {
      await server.close();
    }
  },
);

it("embeds one canonical artifact identity from explicit build inputs", () => {
  expect(
    resolveBuildInfo({
      env: { GIT_COMMIT: commit, OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T12:34:56Z" },
      readGitCommit: () => {
        throw new Error("Explicit identity must not read HEAD");
      },
      readGitCommitTimestamp: (requested) => {
        expect(requested).toBe(commit);
        return buildInfo.commitAt;
      },
      readPackageVersion: () => buildInfo.version,
    }),
  ).toEqual({
    ...buildInfo,
    buildId: "2026.7.10-0123456789ab-2026-07-10T12-34-56.000Z",
  });
});

it("keeps source-build identity stable when no build timestamp is provided", () => {
  const info = resolveBuildInfo({ readGitCommit: () => "a".repeat(40) });
  expect(info).toMatchObject({ builtAt: null, buildId: "aaaaaaaaaaaa" });
});

it("hard-kills every advisory Git read after its deadline", async () => {
  await childProcessMocks.execFileSync.withImplementation(
    ((_file: string, args: readonly string[], options: unknown) => {
      expect(args).toContain("--no-optional-locks");
      expect(options).toMatchObject({ killSignal: "SIGKILL", timeout: 2_000 });
      return args.includes("--format=%ct")
        ? "0\n"
        : args.includes("--abbrev-ref")
          ? "main\n"
          : args.includes("--porcelain")
            ? ""
            : `${"a".repeat(40)}\n`;
    }) as typeof import("node:child_process").execFileSync,
    async () => {
      expect(resolveControlUiBuildInfo({ env: {}, readPackageVersion: () => null })).toMatchObject({
        commit: "a".repeat(40),
        commitAt: "1970-01-01T00:00:00.000Z",
        branch: "main",
        dirty: false,
      });
    },
  );
});

it.each([
  ["checked-out Git", { GITHUB_SHA: "b".repeat(40) }, "c".repeat(40), "c".repeat(40)],
  ["GitHub fallback", { GITHUB_SHA: "b".repeat(40) }, null, "b".repeat(40)],
  [
    "explicit alias",
    { GIT_SHA: "A".repeat(40), GITHUB_SHA: "b".repeat(40) },
    "c".repeat(40),
    "a".repeat(40),
  ],
] as const)("resolves commit identity from %s", (_name, env, git, expectedCommit) => {
  expect(resolveBuildInfo({ env, readGitCommit: () => git })).toMatchObject({
    commit: expectedCommit,
    commitAt: null,
  });
});

it.each([
  ["explicit", { GIT_BRANCH: " feature/from-env ", GITHUB_REF_TYPE: "branch" }, "feature/from-env"],
  ["GitHub branch", { GITHUB_REF_TYPE: "branch" }, "feature/github"],
  ["GitHub tag", { GITHUB_REF_TYPE: "tag" }, "git-fallback"],
  ["checkout", {}, "git-fallback"],
  ["detached HEAD", {}, null],
] as const)("resolves %s branch identity", (name, env, branch) => {
  expect(
    resolveBuildInfo({
      env: { GITHUB_REF_NAME: "feature/github", ...env },
      readGitBranch: () => (name === "detached HEAD" ? "HEAD" : "git-fallback"),
    }).branch,
  ).toBe(branch);
});

it.each([
  ["release", { OPENCLAW_CONTROL_UI_RELEASE_BUILD: "1" }, true, "release-"],
  ["generic selector", { OPENCLAW_VERSION: "latest" }, false, ""],
  ["blank explicit id", { OPENCLAW_CONTROL_UI_BUILD_ID: "   " }, false, ""],
] as const)("builds canonical identity with %s", (_name, env, release, marker) => {
  expect(
    resolveBuildInfo({
      env: { ...env, OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T13:14:15.000Z" },
      readGitCommit: () => "a".repeat(40),
      readGitBranch: () => "release/2026.7.10",
      readGitDirty: () => false,
      readPackageVersion: () => "2026.7.10",
    }),
  ).toMatchObject({
    release,
    buildId: `2026.7.10-${marker}aaaaaaaaaaaa-2026-07-10T13-14-15.000Z`,
  });
});

it.each([
  ["OPENCLAW_CONTROL_UI_RELEASE_BUILD", "true", "must be 1 when set"],
  ["GITHUB_SHA", "bad", "must be a full 40-character hexadecimal SHA"],
  ["GIT_COMMIT", "deadbeef", "must be a full 40-character hexadecimal SHA"],
  [
    "OPENCLAW_BUILD_TIMESTAMP",
    "2026-07-10 12:34:56",
    "must be a valid UTC ISO-8601 timestamp ending in Z",
  ],
] as const)("rejects malformed %s", (key, value, error) => {
  expect(() =>
    resolveBuildInfo({
      env: { [key]: value },
      readGitCommit: () => (key === "GITHUB_SHA" ? null : "a".repeat(40)),
    }),
  ).toThrow(`${key} ${error}`);
});

it.each(["agent-id", "error-coercion", "expect"])(
  "resolves internal source aliases for %s",
  (subpath) => {
    const aliases = resolveSourcePackageAliasesForVite();
    const moduleId = `@openclaw/normalization-core/${subpath}`;
    expect(aliases.find((alias) => alias.find === moduleId)?.replacement).toBe(
      path.join(repoRoot, `packages/normalization-core/src/${subpath}.ts`),
    );
    expectBefore(
      aliases.map((alias) => alias.find),
      moduleId,
      "@openclaw/normalization-core",
    );
  },
);

it("uses Node package resolution for external packages inherited by worktrees", () => {
  const resolvePackage = vi.fn((specifier: string) => path.join("/parent/node_modules", specifier));
  const aliases = resolveExternalPackageAliasesForVite(resolvePackage);
  expect(aliases.find((alias) => alias.find === "@openclaw/libterminal/browser")).toEqual({
    find: "@openclaw/libterminal/browser",
    replacement: path.join("/parent/node_modules/@openclaw/libterminal", "dist/browser.js"),
  });
});

it("keeps specific tsconfig aliases ahead of broad package aliases", () => {
  const aliases = resolveTsconfigPathAliasesForVite();
  expect(aliases.find((alias) => alias.find === "@openclaw/net-policy/ip")?.replacement).toBe(
    path.join(repoRoot, "packages/net-policy/src/ip.ts"),
  );
  expectBefore(
    aliases.map((alias) => alias.find),
    "@openclaw/net-policy/ip",
    "@openclaw/net-policy",
  );
  expectBefore(
    aliases.filter((alias) => alias.find instanceof RegExp).map((alias) => alias.replacement),
    path.join(repoRoot, "packages/net-policy/src/$1"),
    path.join(repoRoot, "extensions/$1"),
  );
});

it("composes the complete source without registering runtime English", () => {
  const before = structuredClone(en);
  const source = loadControlUiSourceCatalog();
  const flat = flattenTranslations(source);
  expect(en).toEqual(before);
  expect(source).not.toBe(en);
  expect(source.configView).not.toBe(en.configView);
  expect(flat.get("activity.title")).toBe("Activity");
  expect(flat.get("configView.sections.cron")).toBe("Automations");
});

it("includes every English dependency in the raw source-hash input", async () => {
  const localesDir = path.join(repoRoot, "ui/src/i18n/locales");
  const sourceRaw = await readControlUiSourceCatalog();
  const englishFiles = readdirSync(localesDir).filter(
    (file) => /^en(?:-.+)?\.ts$/.test(file) && !file.endsWith(".test.ts"),
  );
  for (const file of englishFiles) {
    expect(sourceRaw, file).toContain(readFileSync(path.join(localesDir, file), "utf8"));
  }
});

it("defers page and config-hint translations until their namespace loads", async () => {
  const { load, resolveId } = await localeHooks();
  const resolve = (id: string) => resolveId.call({} as never, id, undefined, {} as never);
  const baseId = "virtual:openclaw-control-ui-locale/fr";
  const configHintsId = "virtual:openclaw-control-ui-locale-config-hints/fr";
  const resolvedBase = await resolve(baseId);
  expect(resolvedBase).toBe(`\0${baseId}`);
  expect(await resolve(configHintsId)).toBe(`\0${configHintsId}`);
  const activityId = "virtual:openclaw-control-ui-locale-namespace/fr/activity";
  expect(await resolve(activityId)).toBe(`\0${activityId}`);
  expect(await resolve(`${baseId}/../../secret`)).toBeNull();
  const addWatchFile = vi.fn();
  const baseSource = await loadLocaleSource(load, resolvedBase as string, addWatchFile);
  const { catalog, loadNamespace } = await executeLocale(load, baseSource, true);
  expect(flattenTranslations(catalog).has("activity.title")).toBe(false);
  expect(catalog.configHints).toBeUndefined();
  const memoryPath = path.join(repoRoot, "ui/src/i18n/.i18n/fr.tm.jsonl");
  const healthText = flattenTranslations(en).get("common.health");
  if (typeof healthText !== "string") {
    throw new Error("Expected English health source");
  }
  const healthEntry = [...loadControlUiTranslationMemory(memoryPath).values()].find(
    (entry) =>
      (entry.segment_id === "common.health" || entry.segment_ids?.includes("common.health")) &&
      entry.text_hash === hashControlUiTranslationText(healthText),
  );
  expect(healthEntry).toBeDefined();
  expect(flattenTranslations(catalog).get("common.health")).toBe(healthEntry?.translated);
  await loadNamespace("activity");
  expect(flattenTranslations(catalog).get("activity.title")).toBeTypeOf("string");
  expect(catalog.configHints).toBeUndefined();
  await loadNamespace("configHints");
  expect(catalog.configHints).toBeTypeOf("object");
  expect(addWatchFile).toHaveBeenCalledWith(memoryPath);
  const watchedFiles = watchedPaths(addWatchFile);
  for (const source of [
    "scripts/lib/control-ui-i18n-catalog.ts",
    "ui/src/i18n/locales/en-activity.ts",
    "src/config/schema.hints.ts",
    "src/config/schema.help.ts",
    "src/config/schema.labels.ts",
    "packages/net-policy/src/redact-sensitive-url.ts",
  ]) {
    expect(watchedFiles).toContain(path.join(repoRoot, source));
  }
});

it("bootstraps only an absent locale memory from the English catalog", async () => {
  const { load } = await localeHooks();
  const baseId = baseLocaleId;
  const addWatchFile = vi.fn();
  await withoutMemory(async () => {
    const baseSource = await loadLocaleSource(load, baseId, addWatchFile);
    const { catalog, loadAll } = await executeLocale(load, baseSource, true);
    expect(flattenTranslations(catalog).has("activity.title")).toBe(false);
    expect(catalog.configHints).toBeUndefined();
    await loadAll();
    expect(flattenTranslations(catalog)).toEqual(flattenTranslations(loadControlUiSourceCatalog()));
    expect(watchedPaths(addWatchFile)).toContain(path.join(repoRoot, "src/config/schema.hints.ts"));
  });
});

it.each([
  ["empty", "", "Control UI fr translation memory is missing or empty"],
  ["malformed", "{", SyntaxError],
] as const)("rejects %s locale memory", async (_name, memory, expected) => {
  const { load } = await localeHooks();
  await fsMocks.readFileSync.withImplementation(
    () => memory,
    async () => {
      await expect(loadLocaleSource(load, baseLocaleId, vi.fn())).rejects.toThrow(expected);
    },
  );
});

it.each([
  ["stale resolved", "resolve", true],
  ["stale rejected", "reject", true],
  ["current rejected", "reject", false],
] as const)("recovers a %s source-catalog generation", async (_name, outcome, invalidate) => {
  const staleImport = deferred<ReturnType<typeof catalogImport>>();
  const currentCatalog = labeledCatalog("current");
  let imports = 0;
  const sourceImport = vi.fn(async () =>
    imports++ === 0 ? staleImport.promise : catalogImport(currentCatalog),
  );
  await withSourceImport(sourceImport, async () => {
    const { load, watchChange } = await localeHooks();
    let baseSourcePromise = loadLocaleSource(load);
    await vi.waitFor(() => expect(sourceImport).toHaveBeenCalledOnce());
    if (invalidate) {
      await watchChange.call({} as never, "src/config/schema.hints.ts", {} as never);
    }
    if (outcome === "resolve") {
      staleImport.resolve(catalogImport(labeledCatalog("stale")));
    } else {
      const error = new Error("source import failed");
      staleImport.reject(error);
      if (!invalidate) {
        await expect(baseSourcePromise).rejects.toBe(error);
        baseSourcePromise = loadLocaleSource(load);
      }
    }
    const baseSource = await baseSourcePromise;
    const { catalog } = await executeLocale(load, baseSource);
    expect(catalog).toEqual(currentCatalog);
    expect(sourceImport).toHaveBeenCalledTimes(2);
  });
});

it("reloads configured source aliases instead of installed package outputs", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "control-ui-locale-")));
  const entry = path.join(root, "catalog.ts");
  const dependency = path.join(root, "labels.ts");
  const installedPackage = path.join(root, "node_modules/@fixture/labels");
  const { runnerImport } = await vi.importActual<typeof import("vite")>("vite");
  try {
    await writeFile(
      entry,
      'import { label } from "@fixture/labels";\n' +
        "export const loadControlUiSourceCatalog = () => " +
        "({ common: { health: label }, configHints: { fixture: { label } } });\n" +
        "export const loadControlUiStartupCatalog = () => ({ common: { health: label } });\n",
    );
    await mkdir(installedPackage, { recursive: true });
    await writeFile(
      path.join(installedPackage, "package.json"),
      JSON.stringify({ name: "@fixture/labels", type: "module", exports: "./index.js" }),
    );
    await writeFile(path.join(installedPackage, "index.js"), 'export const label = "stale";\n');
    await writeFile(dependency, 'export const label = "first";\n');
    await withSourceImport(
      (_entry, config) => runnerImport(entry, config),
      async () => {
        const { load, watchChange } = await localeHooks([
          { find: "@fixture/labels", replacement: dependency },
        ]);
        const addWatchFile = vi.fn();
        const readCatalog = async () => {
          const base = await loadLocaleSource(load, baseLocaleId, addWatchFile);
          return (await executeLocale(load, base)).catalog;
        };
        expect(await readCatalog()).toEqual(labeledCatalog("first"));
        expect(watchedPaths(addWatchFile)).toContain(dependency);
        await writeFile(dependency, 'export const label = "second";\n');
        await watchChange.call({} as never, dependency, {} as never);
        expect(await readCatalog()).toEqual(labeledCatalog("second"));
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("invalidates a resolved locale generation at build start", async () => {
  const catalogs = ["first", "second"].map((label) => ({
    common: { health: label },
    configHints: { [label]: { label } },
  }));
  let imports = 0;
  await withSourceImport(
    async () => catalogImport(catalogs[imports++]!, { common: { health: "health" } }),
    async () => {
      const { buildStart, load } = await localeHooks();
      const firstBase = await loadLocaleSource(load);
      const first = await executeLocale(load, firstBase);
      expect(first.catalog).toEqual(catalogs[0]);
      await buildStart.call({} as never, {} as never);
      const secondBase = await loadLocaleSource(load);
      const second = await executeLocale(load, secondBase);
      expect(second.catalog).toEqual(catalogs[1]);
    },
  );
});

it("omits stale config and Settings translations so runtime English can resolve them", async () => {
  const { load } = await localeHooks();
  const currentHintText = "Gateway Token";
  const currentHintKey = configHintTranslationKey("gateway.auth.token", "label", currentHintText);
  const staleHintText = "Old Gateway Token";
  const staleHintKey = configHintTranslationKey("gateway.auth.token", "label", staleHintText);
  const memory = (
    [
      ["configView.chatPrefs.title", "Chat", "Discussion", false],
      ["updates.page.intro", "Retired update introduction", "Obsolete", false],
      [currentHintKey, currentHintText, "Ağ geçidi belirteci", true],
      [staleHintKey, staleHintText, "Eski ağ geçidi belirteci", true],
    ] as const
  )
    .map(([segment_id, text, translated, hint]) =>
      JSON.stringify({
        cache_key: segment_id,
        segment_id,
        ...(hint ? { text } : {}),
        text_hash: hashControlUiTranslationText(text),
        translated,
      }),
    )
    .join("\n");
  await withMemory(memory, async () => {
    const baseSource = await loadLocaleSource(load);
    const { catalog } = await executeLocale(load, baseSource);
    const flat = flattenTranslations(catalog);
    expect(flat.get("configView.chatPrefs.title")).toBe("Discussion");
    expect(flat.get(currentHintKey)).toBe("Ağ geçidi belirteci");
    expect(flat.has("updates.page.intro")).toBe(false);
    expect(flat.has(staleHintKey)).toBe(false);
  });
});
