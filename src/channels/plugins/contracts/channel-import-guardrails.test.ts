import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceFile } from "typescript/ast";
import { afterAll, describe, expect, it } from "vitest";
import { classifyBundledExtensionSourcePath } from "../../../../scripts/lib/extension-source-classifier.mts";
import { collectModuleReferencesFromSource } from "../../../../scripts/lib/guard-inventory-utils.mjs";
import { createNativeTypeScriptParser } from "../../../../scripts/lib/native-typescript.mts";
import { GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES } from "../../../plugin-sdk/test-helpers/public-artifacts.js";
import { loadPluginManifestRegistryCore } from "../../../plugins/manifest-registry.js";
import {
  listGitTrackedFiles,
  toRepoPath as normalizePath,
  toRepoRelativePath,
} from "../../../test-utils/repo-files.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());
const ALLOWED_EXTENSION_PUBLIC_SURFACES = new Set(GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES);
ALLOWED_EXTENSION_PUBLIC_SURFACES.add("test-api.js");
const BUNDLED_PLUGIN_ROOT_DIR = "extensions";
const bundledPluginRecords = loadPluginManifestRegistryCore({ config: {} }).plugins.filter(
  (plugin) => plugin.origin === "bundled",
);
const bundledPluginRoots = new Map(
  bundledPluginRecords.map(
    ({ id, rootDir }) => [id, resolveBundledPluginSourceRoot(rootDir)] as const,
  ),
);
const BUNDLED_EXTENSION_IDS = [...bundledPluginRoots.keys()].toSorted(
  (left, right) => right.length - left.length,
);
const GUARDED_CHANNEL_EXTENSIONS = new Set([
  "discord",
  "feishu",
  "googlechat",
  "imessage",
  "irc",
  "line",
  "matrix",
  "mattermost",
  "msteams",
  "nostr",
  "nextcloud-talk",
  "signal",
  "slack",
  "synology-chat",
  "telegram",
  "tlon",
  "twitch",
  "whatsapp",
  "zalo",
  "zalouser",
]);

function resolveBundledPluginSourceRoot(rootDir: string): string {
  const sourceRoot = resolve(REPO_ROOT, BUNDLED_PLUGIN_ROOT_DIR, basename(rootDir));
  return fs.existsSync(sourceRoot) ? sourceRoot : rootDir;
}

function bundledPluginFile(pluginId: string, relativePath: string): string {
  const rootDir = bundledPluginRoots.get(pluginId);
  if (!rootDir) {
    throw new Error(`missing bundled plugin root for ${pluginId}`);
  }
  return normalizePath(resolve(rootDir, relativePath));
}

type GuardedSource = readonly [plugin: string, path: string, patterns: RegExp[]];
const SAME_CHANNEL_SDK_GUARDS: GuardedSource[] = [
  ...["discord", "slack", "telegram", "imessage", "whatsapp", "signal"].flatMap((id) => {
    const paths =
      id === "signal"
        ? ["src/shared.ts", "runtime-api.ts"]
        : id === "telegram"
          ? ["src/channel.ts", "src/setup-plugin.ts"]
          : ["src/shared.ts"];
    return paths.map((path): GuardedSource => [
      id,
      path,
      [new RegExp(`["']openclaw/plugin-sdk/${id}["']`), new RegExp(`plugin-sdk-internal/${id}`)],
    ]);
  }),
  ...["src/account-inspect.ts", "src/accounts.ts", "src/token.ts"].map((path): GuardedSource => [
    "telegram",
    path,
    [/["']openclaw\/plugin-sdk\/account-resolution["']/],
  ]),
  ...[
    "src/channel.ts",
    "src/action-runtime.ts",
    "src/accounts.ts",
    "src/account-inspect.ts",
    "src/api-fetch.ts",
    "src/channel.setup.ts",
    "src/probe.ts",
    "src/setup-core.ts",
    "src/token.ts",
  ].map((path): GuardedSource => ["telegram", path, [/["']\.\.\/runtime-api\.js["']/]]),
];
const docsLink = /\bformatDocsLink\b/;
const cliCommand = /\bformatCliCommand\b/;
const detectBinary = /\bdetectBinary\b/;
const SETUP_BARREL_GUARDS: GuardedSource[] = [
  ["signal", "src/setup-core.ts", [cliCommand, docsLink]],
  ["signal", "src/setup-surface.ts", [detectBinary, cliCommand, docsLink]],
  ["slack", "src/setup-core.ts", [docsLink]],
  ["slack", "src/setup-surface.ts", [docsLink]],
  ["discord", "src/setup-core.ts", [docsLink]],
  ["discord", "src/setup-surface.ts", [docsLink]],
  ["imessage", "src/setup-core.ts", [docsLink]],
  ["imessage", "src/setup-surface.ts", [detectBinary, docsLink]],
  ["telegram", "src/setup-core.ts", [cliCommand, docsLink]],
  ["whatsapp", "src/setup-surface.ts", [cliCommand, docsLink]],
];
const CHANNEL_CONFIG_SCHEMA_GUARDS: GuardedSource[] = [
  ["tlon", "src/config-schema.ts", [/["']openclaw\/plugin-sdk\/core["']/]],
];

function expectGuardedSources(sources: GuardedSource[], read = readSource) {
  for (const [plugin, path, patterns] of sources) {
    const fullPath = bundledPluginFile(plugin, path);
    const text = read(fullPath);
    for (const pattern of patterns) {
      expect(text, `${fullPath} should not match ${pattern}`).not.toMatch(pattern);
    }
  }
}

const LOCAL_EXTENSION_API_BARREL_GUARDS = [
  "acpx",
  "device-pair",
  "diagnostics-otel",
  "diagnostics-prometheus",
  "discord",
  "diffs",
  "feishu",
  "google",
  "imessage",
  "irc",
  "llm-task",
  "line",
  "lobster",
  "matrix",
  "mattermost",
  "memory-lancedb",
  "msteams",
  "nextcloud-talk",
  "nostr",
  "ollama",
  "copilot-proxy",
  "sglang",
  "zai",
  "signal",
  "synology-chat",
  "talk-voice",
  "telegram",
  "tlon",
  "voice-call",
  "vllm",
  "whatsapp",
  "twitch",
  "xai",
  "zalo",
  "zalouser",
] as const;

const LOCAL_EXTENSION_API_BARREL_EXCEPTIONS = [
  // Avoid accounts.ts -> runtime-api.ts -> plugin api barrel -> accounts.ts.
  bundledPluginFile("matrix", "src/matrix/accounts.ts"),
  // Config schema stays on the public SDK seam and is covered by dedicated config guardrails.
  bundledPluginFile("msteams", "src/config-schema.ts"),
] as const;

const sourceTextCache = new Map<string, string>();
const sourceAnalysisCache = new Map<string, string[]>();
let coreSourceFilesCache: string[] | null = null;
const extensionFilesCache = new Map<string, string[]>();
type SourceFileCollectorOptions = {
  rootDir: string;
  shouldSkipEntry?: (params: { entryName: string; normalizedFullPath: string }) => boolean;
};

function readSource(path: string): string {
  const fullPath = resolve(REPO_ROOT, path);
  const cached = sourceTextCache.get(fullPath);
  if (cached !== undefined) {
    return cached;
  }
  const text = fs.readFileSync(fullPath, "utf8");
  sourceTextCache.set(fullPath, text);
  return text;
}

function listTrackedSourceFiles(options: SourceFileCollectorOptions): string[] | null {
  const relativeRoot = toRepoRelativePath(REPO_ROOT, options.rootDir);
  if (!relativeRoot || relativeRoot.startsWith("..")) {
    return null;
  }
  return (
    listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: relativeRoot })
      ?.map((file) => resolve(REPO_ROOT, file))
      .filter((file) => isSourceFile(file, options))
      .toSorted() ?? null
  );
}

function isSourceFile(file: string, options: SourceFileCollectorOptions): boolean {
  const normalizedFullPath = normalizePath(file);
  return (
    /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u.test(file) &&
    !file.endsWith(".d.ts") &&
    !normalizedFullPath
      .split("/")
      .some((part) => ["node_modules", "dist", "coverage"].includes(part)) &&
    !options.shouldSkipEntry?.({ entryName: basename(file), normalizedFullPath })
  );
}

function collectSourceFiles(
  cached: string[] | undefined | null,
  options: SourceFileCollectorOptions,
): string[] {
  if (cached) {
    return cached;
  }
  const trackedFiles = listTrackedSourceFiles(options);
  if (trackedFiles) {
    return trackedFiles;
  }
  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        return ["node_modules", "dist", "coverage"].includes(entry.name) ? [] : walk(path);
      }
      return entry.isFile() && isSourceFile(path, options) ? [path] : [];
    });
  }
  return walk(options.rootDir);
}

function readSetupBarrelImportBlock(path: string): string {
  const lines = readSource(path).split("\n");
  const targetLineIndex = lines.findIndex((line) =>
    /from\s*"[^"]*plugin-sdk(?:-internal)?\/setup(?:\.js)?";/.test(line),
  );
  if (targetLineIndex === -1) {
    return "";
  }
  let startLineIndex = targetLineIndex;
  while (startLineIndex >= 0 && !lines[startLineIndex]?.includes("import")) {
    startLineIndex -= 1;
  }
  return lines.slice(startLineIndex, targetLineIndex + 1).join("\n");
}

function collectExtensionSourceFiles(): string[] {
  return [...bundledPluginRoots.keys()].flatMap((id) => collectExtensionFiles(id, true));
}

function isGuardedExtensionSourceFile(relativePath: string): boolean {
  const entryName = basename(relativePath);
  return (
    /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u.test(relativePath) &&
    !relativePath.endsWith(".d.ts") &&
    !relativePath.split("/").some((part) => part === "node_modules" || part === "dist") &&
    !classifyBundledExtensionSourcePath(resolve(REPO_ROOT, relativePath)).isTestLike &&
    entryName !== "api.ts" &&
    entryName !== "runtime-api.ts"
  );
}

function collectExtensionForbiddenImportMatches(literals: readonly string[]): string[] {
  const result = spawnSync(
    "git",
    [
      "grep",
      "-n",
      "-F",
      ...literals.flatMap((literal) => ["-e", literal]),
      "--",
      BUNDLED_PLUGIN_ROOT_DIR,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    throw new Error("git grep failed while checking extension import guardrails");
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      const file = line.split(":", 1)[0];
      return file ? isGuardedExtensionSourceFile(file) : false;
    })
    .toSorted();
}

function collectCoreSourceFiles(): string[] {
  const normalizedPluginSdkDir = normalizePath(resolve(REPO_ROOT, "src/plugin-sdk"));
  coreSourceFilesCache = collectSourceFiles(coreSourceFilesCache, {
    rootDir: resolve(REPO_ROOT, "src"),
    shouldSkipEntry: ({ entryName, normalizedFullPath }) =>
      /\.(?:test|test-utils|test-harness|test-helpers|test-support|mock-harness|suite|spec|fixture)\.|\.snap/u.test(
        normalizedFullPath,
      ) ||
      entryName.endsWith("-test-helpers.ts") ||
      entryName === "test-manager-helpers.ts" ||
      // The curated SDK bridge has dedicated guards, not the generic core import rule.
      normalizedFullPath.includes(`${normalizedPluginSdkDir}/`),
  });
  return coreSourceFilesCache;
}

function collectExtensionFiles(extensionId: string, excludeApi = false): string[] {
  const key = `${extensionId}:${excludeApi}`;
  const cached = extensionFilesCache.get(key);
  const rootDir = bundledPluginRoots.get(extensionId);
  if (!rootDir) {
    return [];
  }
  const files = collectSourceFiles(cached, {
    rootDir,
    shouldSkipEntry: ({ entryName, normalizedFullPath }) =>
      classifyBundledExtensionSourcePath(normalizedFullPath).isTestLike ||
      entryName === "runtime-api.ts" ||
      (excludeApi && entryName === "api.ts"),
  });
  extensionFilesCache.set(key, files);
  return files;
}

function collectModuleSpecifiers(text: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of [
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gmu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gmu,
    /^\s*import(?:\s+type)?\s+(?!["'])(?:[\s\S]*?)\s+from\s*["']([^"']+)["']/gmu,
    /^\s*import\s*["']([^"']+)["']/gmu,
    /^\s*export\s+(?:type\s+)?\*\s*(?:as\s+\w+\s+)?from\s*["']([^"']+)["']/gmu,
    /^\s*export\s+(?:type\s+)?\{[^}]*\}\s+from\s*["']([^"']+)["']/gmu,
  ]) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (specifier && /\.(?:[cm]?[jt]sx?)$/u.test(specifier)) {
        specifiers.add(specifier);
      }
    }
  }
  return [...specifiers];
}

function getImportSpecifiers(path: string): string[] {
  const fullPath = resolve(REPO_ROOT, path);
  const cached = sourceAnalysisCache.get(fullPath);
  if (cached) {
    return cached;
  }
  const imports = collectModuleSpecifiers(readSource(path));
  sourceAnalysisCache.set(fullPath, imports);
  return imports;
}

function expectNoCorePluginPrivateSrcImports(sourceFile: SourceFile): void {
  const imports = collectModuleReferencesFromSource(sourceFile, {
    acceptSpecifier: (specifier) => /(?:^|\/)extensions\/[^/]+\/src\//u.test(specifier),
  });
  expect(imports, `${sourceFile.fileName} should not import plugin-private src paths`).toEqual([]);
}

function expectOnlyApprovedExtensionSeams(file: string, imports: string[]): void {
  for (const specifier of imports) {
    if (!specifier.includes(`/${BUNDLED_PLUGIN_ROOT_DIR}/`)) {
      continue;
    }
    const normalized = specifier.replaceAll("\\", "/");
    const resolved = specifier.startsWith(".")
      ? resolve(dirname(file), specifier).replaceAll("\\", "/")
      : normalized;
    const extensionId =
      resolved.match(new RegExp(`${BUNDLED_PLUGIN_ROOT_DIR}/([^/]+)/`))?.[1] ?? null;
    if (!extensionId || !GUARDED_CHANNEL_EXTENSIONS.has(extensionId)) {
      continue;
    }
    expect(
      ALLOWED_EXTENSION_PUBLIC_SURFACES.has(resolved.split("/").at(-1) ?? ""),
      `${file} should only import approved extension surfaces, got ${specifier}`,
    ).toBe(true);
  }
}

function expectNoCrossPluginFacades(file: string, imports: string[]): void {
  const currentExtensionId =
    normalizePath(file).match(new RegExp(`/${BUNDLED_PLUGIN_ROOT_DIR}/([^/]+)/`))?.[1] ?? null;
  if (!currentExtensionId) {
    return;
  }
  for (const specifier of imports) {
    if (!specifier.startsWith("openclaw/plugin-sdk/")) {
      continue;
    }
    const targetSubpath = specifier.slice("openclaw/plugin-sdk/".length);
    const targetExtensionId = findExtensionId(targetSubpath, BUNDLED_EXTENSION_IDS);
    if (!targetExtensionId || targetExtensionId === currentExtensionId) {
      continue;
    }
    expect.fail(
      `${file} should not import another bundled plugin facade, got ${specifier}. Promote shared helpers to a neutral plugin-sdk subpath instead.`,
    );
  }
}

function findExtensionId(subpath: string, ids: Iterable<string>) {
  return [...ids].find((id) => subpath === id || subpath.startsWith(`${id}-`));
}

function expectNoCoreFacades(file: string, imports: string[]): void {
  for (const specifier of imports) {
    if (!specifier.includes("/plugin-sdk/")) {
      continue;
    }
    const targetSubpath = specifier.split("/plugin-sdk/")[1]?.replace(/\.[cm]?[jt]sx?$/u, "") ?? "";
    const targetExtensionId = findExtensionId(targetSubpath, GUARDED_CHANNEL_EXTENSIONS);
    if (!targetExtensionId) {
      continue;
    }
    expect.fail(
      `${file} should not import plugin-specific SDK facades (${specifier}) from core production code. Use a neutral contract surface or plugin hook instead.`,
    );
  }
}

describe("channel import guardrails", () => {
  it.each([
    ["own SDK barrels", SAME_CHANNEL_SDK_GUARDS, readSource],
    ["setup primitives", SETUP_BARREL_GUARDS, readSetupBarrelImportBlock],
    ["config schema imports", CHANNEL_CONFIG_SCHEMA_GUARDS, readSource],
  ] as const)("guards %s", (_name, sources, read) => expectGuardedSources(sources, read));

  it.each([
    [
      "root and compat SDK",
      [
        '"openclaw/plugin-sdk"',
        "'openclaw/plugin-sdk'",
        '"openclaw/plugin-sdk/compat"',
        "'openclaw/plugin-sdk/compat'",
      ],
    ],
    ["legacy send-deps", ["src/infra/outbound/send-deps"]],
  ] as const)("forbids %s imports", (_name, imports) => {
    expect(collectExtensionForbiddenImportMatches(imports)).toEqual([]);
  });

  it.each([
    'import { client } from "../../extensions/feishu/src/client.js";',
    'await import("../../extensions/feishu/src/client.js");',
    'export * from "../../extensions/feishu/src/client.js";',
    'require("../../extensions/feishu/src/client.js");',
    'import client = require("../../extensions/feishu/src/client");',
    'new URL("../../extensions/feishu/src/client.js", import.meta.url);',
  ])("rejects core plugin-private module references: %s", (source) => {
    expect(() =>
      expectNoCorePluginPrivateSrcImports(parser.parseSourceFile("source.ts", source)),
    ).toThrow("should not import plugin-private src paths");
  });

  it("allows diagnostic paths and import examples without loading plugin-private modules", () => {
    expectNoCorePluginPrivateSrcImports(
      parser.parseSourceFile(
        "source.ts",
        [
          'const modulePath = "extensions/feishu/src/client.ts";',
          '// import "../../extensions/feishu/src/client.js";',
          'const example = `require("../../extensions/feishu/src/client.js")`;',
        ].join("\n"),
      ),
    );
  });

  it("keeps core production files off plugin-private src imports", () => {
    const files = collectCoreSourceFiles();
    for (let offset = 0; offset < files.length; offset += 32) {
      const sources = files.slice(offset, offset + 32).map((fileName) => ({
        fileName,
        text: readSource(fileName),
      }));
      for (const sourceFile of parser.parseSourceFiles(sources)) {
        expectNoCorePluginPrivateSrcImports(sourceFile);
      }
    }
  });

  it.each<[string, () => string[], (file: string, imports: string[]) => void]>([
    ["cross-plugin facades", collectExtensionSourceFiles, expectNoCrossPluginFacades],
    ["core public seams", collectCoreSourceFiles, expectOnlyApprovedExtensionSeams],
    ["core plugin facades", collectCoreSourceFiles, expectNoCoreFacades],
    ["extension public seams", collectExtensionSourceFiles, expectOnlyApprovedExtensionSeams],
  ])("guards %s", (_name, collect, check) => {
    for (const file of collect()) {
      check(file, getImportSpecifiers(file));
    }
  });

  it("keeps internalized extension helper surfaces behind local api barrels", () => {
    for (const extensionId of LOCAL_EXTENSION_API_BARREL_GUARDS) {
      for (const file of collectExtensionFiles(extensionId)) {
        const normalized = file.replaceAll("\\", "/");
        if (
          LOCAL_EXTENSION_API_BARREL_EXCEPTIONS.some((suffix) => normalized.endsWith(suffix)) ||
          normalized.endsWith("/api.ts") ||
          normalized.endsWith("/test-runtime.ts")
        ) {
          continue;
        }
        const text = readSource(file);
        expect(
          text,
          `${normalized} should import ${extensionId} helpers via the local api barrel`,
        ).not.toMatch(new RegExp(`["']openclaw/plugin-sdk/${extensionId}(?:["'/])`, "u"));
      }
    }
  });
});
