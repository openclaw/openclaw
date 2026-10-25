import fs from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
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
const bundledPluginRoots = new Map(
  loadPluginManifestRegistryCore({ config: {} })
    .plugins.filter((plugin) => plugin.origin === "bundled")
    .map(
      ({ id, rootDir }) =>
        [id, resolve(REPO_ROOT, BUNDLED_PLUGIN_ROOT_DIR, basename(rootDir))] as const,
    ),
);
const BUNDLED_EXTENSION_IDS = [...bundledPluginRoots.keys()].toSorted(
  (left, right) => right.length - left.length,
);
const GUARDED_CHANNEL_EXTENSIONS = new Set(
  `discord feishu googlechat imessage irc line matrix mattermost msteams nostr
   nextcloud-talk signal slack synology-chat telegram tlon twitch whatsapp zalo zalouser`.split(
    /\s+/u,
  ),
);

function bundledPluginFile(pluginId: string, relativePath: string): string {
  const rootDir = expectDefined(
    bundledPluginRoots.get(pluginId),
    `missing bundled plugin root for ${pluginId}`,
  );
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
  ..."channel action-runtime accounts account-inspect api-fetch channel.setup probe setup-core token"
    .split(" ")
    .map((name): GuardedSource => [
      "telegram",
      `src/${name}.ts`,
      [/["']\.\.\/runtime-api\.js["']/],
    ]),
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

const LOCAL_EXTENSION_API_BARREL_GUARDS =
  `acpx device-pair diagnostics-otel diagnostics-prometheus discord diffs feishu google
   imessage irc llm-task line lobster matrix mattermost memory-lancedb msteams nextcloud-talk
   nostr ollama copilot-proxy sglang zai signal synology-chat talk-voice telegram tlon voice-call
   vllm whatsapp twitch xai zalo zalouser`.split(/\s+/u);

const LOCAL_EXTENSION_API_BARREL_EXCEPTIONS = [
  // Avoid accounts.ts -> runtime-api.ts -> plugin api barrel -> accounts.ts.
  bundledPluginFile("matrix", "src/matrix/accounts.ts"),
  // Config schema stays on the public SDK seam and is covered by dedicated config guardrails.
  bundledPluginFile("msteams", "src/config-schema.ts"),
] as const;

const sourceTextCache = new Map<string, string>();
const trackedFiles = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: ["src", "extensions"] });
if (!trackedFiles) {
  throw new Error("Channel import guardrails require a Git checkout");
}
const sourceFiles = trackedFiles
  .filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file) && !file.endsWith(".d.ts"))
  .filter((file) => !/(?:^|\/)(?:node_modules|dist|coverage)\//u.test(file))
  .map((file) => normalizePath(resolve(REPO_ROOT, file)));

function readSource(path: string): string {
  const text = sourceTextCache.get(path) ?? fs.readFileSync(path, "utf8");
  sourceTextCache.set(path, text);
  return text;
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

function collectCoreSourceFiles(): string[] {
  const normalizedPluginSdkDir = normalizePath(resolve(REPO_ROOT, "src/plugin-sdk"));
  return sourceFiles.filter(
    (file) =>
      toRepoRelativePath(REPO_ROOT, file).startsWith("src/") &&
      !/\.(?:test|test-utils|test-harness|test-helpers|test-support|mock-harness|suite|spec|fixture)\.|\.snap/u.test(
        file,
      ) &&
      !basename(file).endsWith("-test-helpers.ts") &&
      basename(file) !== "test-manager-helpers.ts" &&
      !file.startsWith(`${normalizedPluginSdkDir}/`),
  );
}

function collectExtensionFiles(extensionId: string, excludeApi = false): string[] {
  const rootDir = bundledPluginRoots.get(extensionId);
  if (!rootDir) {
    return [];
  }
  return sourceFiles.filter(
    (file) =>
      file.startsWith(`${normalizePath(rootDir)}/`) &&
      !classifyBundledExtensionSourcePath(file).isTestLike &&
      basename(file) !== "runtime-api.ts" &&
      (!excludeApi || basename(file) !== "api.ts"),
  );
}

function visitSources(files: string[], check: (source: SourceFile) => void) {
  for (let offset = 0; offset < files.length; offset += 32) {
    const sources = files
      .slice(offset, offset + 32)
      .map((fileName) => ({ fileName, text: readSource(fileName) }));
    for (const source of parser.parseSourceFiles(sources)) {
      check(source);
    }
  }
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

function expectNoPluginFacades(file: string, imports: string[], core = false): void {
  const currentExtensionId =
    normalizePath(file).match(new RegExp(`/${BUNDLED_PLUGIN_ROOT_DIR}/([^/]+)/`))?.[1] ?? null;
  if (!core && !currentExtensionId) {
    return;
  }
  for (const specifier of imports) {
    const targetSubpath = core
      ? (specifier.split("/plugin-sdk/")[1]?.replace(/\.[cm]?[jt]sx?$/u, "") ?? "")
      : specifier.startsWith("openclaw/plugin-sdk/")
        ? specifier.slice("openclaw/plugin-sdk/".length)
        : "";
    const targetExtensionId = findExtensionId(
      targetSubpath,
      core ? GUARDED_CHANNEL_EXTENSIONS : BUNDLED_EXTENSION_IDS,
    );
    if (!targetExtensionId || (!core && targetExtensionId === currentExtensionId)) {
      continue;
    }
    expect.fail(
      `${file} should not import ${core ? "plugin-specific SDK facades from core" : "another bundled plugin facade"}: ${specifier}. Use a neutral plugin-sdk surface instead.`,
    );
  }
}

function findExtensionId(subpath: string, ids: Iterable<string>) {
  return [...ids].find((id) => subpath === id || subpath.startsWith(`${id}-`));
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
    expect(
      sourceFiles.filter(
        (file) =>
          toRepoRelativePath(REPO_ROOT, file).startsWith("extensions/") &&
          !classifyBundledExtensionSourcePath(file).isTestLike &&
          !["api.ts", "runtime-api.ts"].includes(basename(file)) &&
          imports.some((literal) => readSource(file).includes(literal)),
      ),
    ).toEqual([]);
  });

  it("rejects core plugin-private import-equals references", () => {
    const source = parser.parseSourceFile(
      "source.ts",
      'import client = require("../../extensions/feishu/src/client");',
    );
    expect(() => expectNoCorePluginPrivateSrcImports(source)).toThrow(
      "should not import plugin-private src paths",
    );
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
    visitSources(collectCoreSourceFiles(), expectNoCorePluginPrivateSrcImports);
  });

  it.each<[string, () => string[], (file: string, imports: string[]) => void]>([
    ["cross-plugin facades", collectExtensionSourceFiles, expectNoPluginFacades],
    ["core public seams", collectCoreSourceFiles, expectOnlyApprovedExtensionSeams],
    [
      "core plugin facades",
      collectCoreSourceFiles,
      (file, imports) => expectNoPluginFacades(file, imports, true),
    ],
    ["extension public seams", collectExtensionSourceFiles, expectOnlyApprovedExtensionSeams],
  ])("guards %s", (_name, collect, check) => {
    visitSources(collect(), (source) =>
      check(
        source.fileName,
        collectModuleReferencesFromSource(source)
          .filter(
            ({ kind, specifier }) =>
              kind !== "import-meta-url" && /\.(?:[cm]?[jt]sx?)$/u.test(specifier),
          )
          .map(({ specifier }) => specifier),
      ),
    );
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
