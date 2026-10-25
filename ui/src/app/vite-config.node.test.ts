// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { createServer, type Alias } from "vite";
import { expect, it, vi } from "vitest";
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

function catalogImport(
  catalog: TranslationMap & { common: TranslationMap },
  startup: TranslationMap = { common: catalog.common },
) {
  return {
    module: {
      loadControlUiSourceCatalog: () => catalog,
      loadControlUiStartupCatalog: () => startup,
    },
    dependencies: [],
  };
}

function memoryEntry(
  cache_key: string,
  segment_id: string,
  text: string,
  translated: string,
  hint = false,
) {
  return {
    cache_key,
    segment_id,
    ...(hint ? { text } : {}),
    text_hash: hashControlUiTranslationText(text),
    translated,
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

function dataModuleUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
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
  expect(await createControlUiPrecompressedAssetVariants("index.html", source)).toEqual([]);
  expect(await createControlUiPrecompressedAssetVariants("assets/logo.png", source)).toEqual([]);
  expect(await createControlUiPrecompressedAssetVariants("assets/app.js.map", source)).toEqual([]);
});

it("precompresses assets starting at 4 KiB only when the encoding saves bytes", async () => {
  expect(
    await createControlUiPrecompressedAssetVariants("assets/small.js", "x".repeat(4095)),
  ).toEqual([]);
  const boundary = "é".repeat(2048);
  const variants = await createControlUiPrecompressedAssetVariants("assets/boundary.js", boundary);
  expect(variants.map((variant) => variant.fileName)).toEqual([
    "assets/boundary.js.br",
    "assets/boundary.js.gz",
  ]);
  for (const variant of variants) {
    expect(variant.source.byteLength).toBeLessThan(Buffer.byteLength(boundary));
  }
  const incompressible = Buffer.concat(
    Array.from({ length: 128 }, (_, index) => createHash("sha256").update(String(index)).digest()),
  );
  expect(
    await createControlUiPrecompressedAssetVariants("assets/random.wasm", incompressible),
  ).toEqual([]);
  // These tails produce an exactly 4096-byte Brotli or gzip output, respectively.
  incompressible.fill(0, 4096 - 29);
  expect(
    await createControlUiPrecompressedAssetVariants("assets/equal-br.wasm", incompressible),
  ).toEqual([]);
  incompressible.fill(0, 4096 - 66);
  expect(
    (await createControlUiPrecompressedAssetVariants("assets/equal-gzip.wasm", incompressible)).map(
      (variant) => variant.fileName,
    ),
  ).toEqual(["assets/equal-gzip.wasm.br"]);
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
    const variants = await createControlUiPrecompressedAssetVariants(
      fileName,
      source,
      startupAssets,
    );
    expect(variants.map((variant) => variant.fileName)).toEqual([
      `${fileName}.br`,
      `${fileName}.gz`,
    ]);
  }
  expect(
    await createControlUiPrecompressedAssetVariants("assets/chat.js", source, startupAssets),
  ).toEqual([]);
  expect(
    await createControlUiPrecompressedAssetVariants("assets/tiny.css", "x", startupAssets),
  ).toEqual([]);
  expect(
    await createControlUiPrecompressedAssetVariants("assets/entry.js", "x", startupAssets),
  ).toEqual([]);
});

it("uses the supplied artifact identity without reading Git metadata", () => {
  const buildInfo = {
    version: "2026.7.10",
    commit: "0123456789abcdef0123456789abcdef01234567",
    commitAt: "2026-07-10T11:22:33.000Z",
    builtAt: "2026-07-10T12:34:56.000Z",
    branch: null,
    dirty: null,
    release: false,
    buildId: "mock-artifact",
  };
  childProcessMocks.execFileSync.mockClear();
  const config = controlUiViteConfig({ command: "serve", buildInfo });
  expect(config.define?.["globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO"]).toBe(
    JSON.stringify(buildInfo),
  );
  expect(childProcessMocks.execFileSync).not.toHaveBeenCalled();
});

it("selects a polling watcher when the existing environment opt-in is enabled", async ({
  onTestFinished,
}) => {
  vi.stubEnv("CHOKIDAR_USEPOLLING", "1");
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
    expect(server.watcher.options.usePolling).toBe(true);
    expect(server.watcher.options.useFsEvents).toBe(false);
  } finally {
    await server.close();
  }
});

it("embeds one canonical artifact identity from explicit build inputs", () => {
  const readGitCommit = vi.fn(() => "f".repeat(40));
  const readGitCommitTimestamp = vi.fn(() => "2026-07-10T10:11:12.000Z");
  expect(
    resolveBuildInfo({
      env: {
        GIT_COMMIT: "0123456789abcdef0123456789abcdef01234567",
        OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T12:34:56Z",
      },
      readGitCommit,
      readGitCommitTimestamp,
      readPackageVersion: () => "2026.7.10",
    }),
  ).toEqual({
    version: "2026.7.10",
    commit: "0123456789abcdef0123456789abcdef01234567",
    commitAt: "2026-07-10T10:11:12.000Z",
    builtAt: "2026-07-10T12:34:56.000Z",
    branch: null,
    dirty: null,
    release: false,
    buildId: "2026.7.10-0123456789ab-2026-07-10T12-34-56.000Z",
  });
  expect(readGitCommit).not.toHaveBeenCalled();
  expect(readGitCommitTimestamp).toHaveBeenCalledWith("0123456789abcdef0123456789abcdef01234567");
});

it("keeps source-build identity stable when no build timestamp is provided", () => {
  const sources = {
    env: {},
    readGitCommit: () => "a".repeat(40),
    readGitCommitTimestamp: () => null,
  };
  const first = resolveBuildInfo(sources);
  const second = resolveBuildInfo(sources);
  expect(first).toEqual(second);
  expect(first).toEqual({
    version: null,
    commit: "a".repeat(40),
    commitAt: null,
    builtAt: null,
    branch: null,
    dirty: null,
    release: false,
    buildId: "aaaaaaaaaaaa",
  });
});

it("hard-kills every advisory Git read after its deadline", async () => {
  await childProcessMocks.execFileSync.withImplementation(
    ((_file: string, args?: readonly string[]) => {
      const commandArgs = args ?? [];
      if (commandArgs.includes("--format=%ct")) {
        return "0\n";
      }
      if (commandArgs.includes("--abbrev-ref")) {
        return "main\n";
      }
      if (commandArgs.includes("--porcelain")) {
        return "";
      }
      return `${"a".repeat(40)}\n`;
    }) as typeof import("node:child_process").execFileSync,
    async () => {
      childProcessMocks.execFileSync.mockClear();
      expect(resolveControlUiBuildInfo({ env: {}, readPackageVersion: () => null })).toMatchObject({
        commit: "a".repeat(40),
        commitAt: "1970-01-01T00:00:00.000Z",
        branch: "main",
        dirty: false,
      });
      expect(childProcessMocks.execFileSync).toHaveBeenCalledTimes(4);
      for (const call of childProcessMocks.execFileSync.mock.calls) {
        const args = call[1];
        const options = call[2];
        expect(args).toContain("--no-optional-locks");
        expect(options).toMatchObject({
          killSignal: "SIGKILL",
          timeout: 2_000,
        });
      }
    },
  );
});

it.each([
  ["checked-out Git", { GITHUB_SHA: "b".repeat(40) }, "c".repeat(40), "c".repeat(40), 1],
  ["GitHub fallback", { GITHUB_SHA: "b".repeat(40) }, null, "b".repeat(40), 1],
  [
    "explicit alias",
    { GIT_SHA: "A".repeat(40), GITHUB_SHA: "b".repeat(40) },
    "c".repeat(40),
    "a".repeat(40),
    0,
  ],
] as const)("resolves commit identity from %s", (_name, env, git, commit, calls) => {
  const readGitCommit = vi.fn(() => git);
  expect(resolveBuildInfo({ env, readGitCommit })).toMatchObject({ commit, commitAt: null });
  expect(readGitCommit).toHaveBeenCalledTimes(calls);
});

it.each([
  [
    "explicit",
    {
      GIT_BRANCH: " feature/from-env ",
      GITHUB_REF_NAME: "feature/github",
      GITHUB_REF_TYPE: "branch",
    },
    "git-fallback",
    "feature/from-env",
    0,
  ],
  [
    "GitHub branch",
    { GITHUB_REF_NAME: "feature/github", GITHUB_REF_TYPE: "branch" },
    "git-fallback",
    "feature/github",
    0,
  ],
  [
    "GitHub tag",
    { GITHUB_REF_NAME: "v2026.7.10", GITHUB_REF_TYPE: "tag" },
    "git-fallback",
    "git-fallback",
    1,
  ],
  ["checkout", {}, "feature/from-git", "feature/from-git", 1],
  ["detached HEAD", {}, "HEAD", null, 1],
] as const)("resolves %s branch identity", (_name, env, git, branch, calls) => {
  const readGitBranch = vi.fn(() => git);
  expect(resolveBuildInfo({ env, readGitBranch }).branch).toBe(branch);
  expect(readGitBranch).toHaveBeenCalledTimes(calls);
});

it.each([true, false, null])("preserves Git dirty state %s", (dirty) => {
  expect(resolveBuildInfo({ readGitDirty: () => dirty }).dirty).toBe(dirty);
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
    version: "2026.7.10",
    commit: "a".repeat(40),
    branch: "release/2026.7.10",
    dirty: false,
    release,
    buildId: `2026.7.10-${marker}aaaaaaaaaaaa-2026-07-10T13-14-15.000Z`,
  });
});

it.each([
  ["OPENCLAW_CONTROL_UI_RELEASE_BUILD", "true", "must be 1 when set", 1],
  ["GITHUB_SHA", "bad", "must be a full 40-character hexadecimal SHA", 1],
  ["GIT_COMMIT", "deadbeef", "must be a full 40-character hexadecimal SHA", 0],
  [
    "OPENCLAW_BUILD_TIMESTAMP",
    "2026-07-10 12:34:56",
    "must be a valid UTC ISO-8601 timestamp ending in Z",
    1,
  ],
] as const)("rejects malformed %s", (key, value, error, calls) => {
  const readGitCommit = vi.fn(() => (key === "GITHUB_SHA" ? null : "a".repeat(40)));
  expect(() =>
    resolveBuildInfo({
      env: { [key]: value },
      readGitCommit,
      readPackageVersion: () => "2026.7.10",
    }),
  ).toThrow(`${key} ${error}`);
  expect(readGitCommit).toHaveBeenCalledTimes(calls);
});

it("resolves root tsconfig package aliases for source imports", () => {
  const alias = resolveTsconfigPathAliasesForVite().find(
    ({ find }) => find === "@openclaw/net-policy/ip",
  );
  expect(alias?.replacement).toBe(path.join(repoRoot, "packages/net-policy/src/ip.ts"));
});

it("resolves Control UI dev-server source aliases for internal packages", () => {
  const aliases = resolveSourcePackageAliasesForVite();
  const rootIndex = aliases.findIndex((alias) => alias.find === "@openclaw/normalization-core");
  for (const subpath of [
    "agent-id",
    "json-schema",
    "string-coerce",
    "phone-presentation",
    "session-key-comparison",
    "result",
    "stable-stringify",
  ]) {
    const index = aliases.findIndex(
      (alias) => alias.find === `@openclaw/normalization-core/${subpath}`,
    );
    expect(aliases[index]).toEqual({
      find: `@openclaw/normalization-core/${subpath}`,
      replacement: path.join(repoRoot, `packages/normalization-core/src/${subpath}.ts`),
    });
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(rootIndex);
  }
});

it("uses Node package resolution for external packages inherited by worktrees", () => {
  const resolvePackage = vi.fn((specifier: string) => path.join("/parent/node_modules", specifier));
  const aliases = resolveExternalPackageAliasesForVite(resolvePackage);
  expect(resolvePackage.mock.calls).toEqual([
    ["@openclaw/libterminal/package.json"],
    ["@openclaw/uirouter/package.json"],
  ]);
  expect(aliases.find((alias) => alias.find === "@openclaw/libterminal/browser")).toEqual({
    find: "@openclaw/libterminal/browser",
    replacement: path.join("/parent/node_modules/@openclaw/libterminal", "dist/browser.js"),
  });
});

it("keeps specific tsconfig aliases ahead of broad package aliases", () => {
  const aliases = resolveTsconfigPathAliasesForVite();
  const netPolicyIpIndex = aliases.findIndex((alias) => alias.find === "@openclaw/net-policy/ip");
  const netPolicyPackageIndex = aliases.findIndex((alias) => alias.find === "@openclaw/net-policy");
  const netPolicyWildcardIndex = aliases.findIndex(
    (alias) =>
      alias.find instanceof RegExp && alias.replacement.includes("packages/net-policy/src/$1"),
  );
  const broadOpenClawWildcardIndex = aliases.findIndex(
    (alias) => alias.find instanceof RegExp && alias.replacement.includes("extensions/$1"),
  );
  expect(netPolicyIpIndex).toBeGreaterThanOrEqual(0);
  expect(netPolicyWildcardIndex).toBeGreaterThanOrEqual(0);
  expect(netPolicyPackageIndex).toBeGreaterThanOrEqual(0);
  expect(broadOpenClawWildcardIndex).toBeGreaterThanOrEqual(0);
  expect(netPolicyIpIndex).toBeLessThan(netPolicyPackageIndex);
  expect(netPolicyWildcardIndex).toBeLessThan(broadOpenClawWildcardIndex);
});

it("composes the complete source without registering runtime English", () => {
  const before = structuredClone(en);
  const source = loadControlUiSourceCatalog();
  const flat = flattenTranslations(source);
  expect(en).toEqual(before);
  expect(source).not.toBe(en);
  expect(source.configView).not.toBe(en.configView);
  expect(flat.get("activity.title")).toBe("Activity");
  expect(flat.get("memoryImport.title")).toBe("Import assistant memory");
  expect(flat.get("login.failure.authRequired.title")).toBe("This Gateway expects its token");
  expect(flat.get("sessionsView.runsOnDevice")).toBe("Runs on device");
  expect(flat.get("pluginConsent.widenedTitle")).toBe("What changed");
  expect(flat.get("configPage.themeImported")).toBe("Imported {name}.");
  expect(flat.get("configView.sections.cron")).toBe("Automations");
  expect(flat.get("updates.page.intro")).toBe(
    "Manage the connected Gateway's release channel and update policy.",
  );
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
  {
    name: "empty",
    memory: "",
    expected: "Control UI fr translation memory is missing or empty",
  },
  { name: "malformed", memory: "{", expected: SyntaxError },
])("rejects $name locale memory", async ({ memory, expected }) => {
  const { load } = await localeHooks();
  await fsMocks.readFileSync.withImplementation(
    () => memory,
    async () => {
      await expect(loadLocaleSource(load, baseLocaleId, vi.fn())).rejects.toThrow(expected);
    },
  );
});

it.each([
  { name: "stale resolved", outcome: "resolve" as const, invalidate: true },
  { name: "stale rejected", outcome: "reject" as const, invalidate: true },
  { name: "current rejected", outcome: "reject" as const, invalidate: false },
])("recovers a $name source-catalog generation", async ({ outcome, invalidate }) => {
  const staleImport = deferred<ReturnType<typeof catalogImport>>();
  const currentCatalog = {
    common: { health: "current health" },
    configHints: { gateway: { auth: { token: { label: "current token" } } } },
  };
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
      staleImport.resolve(
        catalogImport({
          common: { health: "stale health" },
          configHints: { gateway: { auth: { token: { label: "stale token" } } } },
        }),
      );
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
        expect(await readCatalog()).toEqual({
          common: { health: "first" },
          configHints: { fixture: { label: "first" } },
        });
        expect(watchedPaths(addWatchFile)).toContain(dependency);
        await writeFile(dependency, 'export const label = "second";\n');
        await watchChange.call({} as never, dependency, {} as never);
        expect(await readCatalog()).toEqual({
          common: { health: "second" },
          configHints: { fixture: { label: "second" } },
        });
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("invalidates a resolved locale generation at build start", async () => {
  const catalogs: Array<TranslationMap & { common: TranslationMap }> = [
    { common: { health: "first" }, configHints: { first: { label: "first" } } },
    { common: { health: "second" }, configHints: { second: { label: "second" } } },
  ];
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
  const memory = [
    memoryEntry("current", "configView.chatPrefs.title", "Chat", "Discussion"),
    memoryEntry("stale", "updates.page.intro", "Retired update introduction", "Obsolete"),
    memoryEntry("current-hint", currentHintKey, currentHintText, "Ağ geçidi belirteci", true),
    memoryEntry("stale-hint", staleHintKey, staleHintText, "Eski ağ geçidi belirteci", true),
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  await fsMocks.existsSync.withImplementation(
    () => true,
    async () => {
      await fsMocks.readFileSync.withImplementation(
        () => memory,
        async () => {
          const baseSource = await loadLocaleSource(load);
          const { catalog } = await executeLocale(load, baseSource);
          const flat = flattenTranslations(catalog);
          expect(flat.get("configView.chatPrefs.title")).toBe("Discussion");
          expect(flat.get(currentHintKey)).toBe("Ağ geçidi belirteci");
          expect(flat.has("updates.page.intro")).toBe(false);
          expect(flat.has(staleHintKey)).toBe(false);
        },
      );
    },
  );
});
