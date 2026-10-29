import fs from "node:fs";
import path from "node:path";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "openclaw/plugin-sdk/test-fixtures";
import type { SourceFile } from "typescript/ast";
import { afterAll, describe, expect, it } from "vitest";
import { getChangedPathFacts } from "../scripts/lib/changed-path-facts.mjs";
import { collectModuleReferencesFromSource } from "../scripts/lib/guard-inventory-utils.mjs";
import { createNativeTypeScriptParser } from "../scripts/lib/native-typescript.mts";
import { GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES } from "../src/plugin-sdk/test-helpers/public-artifacts.js";
import { expectNoReaddirSyncDuring } from "../src/test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../src/test-utils/repo-files.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());
const ALLOWED_EXTENSION_PUBLIC_SURFACE_BASENAMES = new Set(
  GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES,
);
const CHANNEL_CONTRACT_TEST_HELPERS_PREFIX = "src/channels/plugins/contracts/test-helpers/";
const BUNDLED_PLUGIN_RESOLVER_TEST_FILES = [
  "src/plugin-sdk/facade-loader.test.ts",
  "src/plugins/public-surface-loader.test.ts",
  "src/plugins/public-surface-runtime.test.ts",
] as const;
const BROAD_PUBLIC_SOURCE_ARTIFACT_BASENAMES = new Set(["api.js", "runtime-api.js"]);
const ROOTDIR_BOUNDARY_CANARY_RE =
  /(^|\/)__rootdir_boundary_canary__\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u;
const LEGACY_HELPER_IMPORTS = [
  /["']openclaw\/plugin-sdk\/test-utils["']/u,
  /["'](?:\.\.\/)+(?:src\/channels\/plugins\/contracts\/test-helpers\/)[^"']+["']/u,
  /["'](?:\.\.\/)+(?:test\/helpers\/)[^"']+["']/u,
];

function listGitFiles(dir: string): string[] {
  const files = listGitTrackedFiles({ repoRoot, pathspecs: toRepoRelativePath(repoRoot, dir) });
  if (!files) {
    throw new Error("Boundary guards require a Git source checkout");
  }
  return files;
}

const walk = (dir: string) => listGitFiles(dir).filter((file) => /\.test\.tsx?$/u.test(file));
const walkCode = (dir: string) =>
  listGitFiles(dir).filter(
    (file) => /\.tsx?$/u.test(file) && !ROOTDIR_BOUNDARY_CANARY_RE.test(file),
  );
const readSource = (file: string) => fs.readFileSync(path.join(repoRoot, file), "utf8");
const matchingFiles = (files: string[], matches: (source: string) => boolean) =>
  files.filter((file) => matches(readSource(file)));
const importMatches = (source: string, patterns: RegExp[]) =>
  patterns.flatMap((pattern) => [...source.matchAll(pattern)]);
const coreTests = (directories = ["src", "test", "packages"]) =>
  directories
    .flatMap((dir) => walk(path.join(repoRoot, dir)))
    .filter(
      (file) => !file.startsWith(BUNDLED_PLUGIN_PATH_PREFIX) && !file.startsWith("test/helpers/"),
    );

function findExtensionImports(source: SourceFile): string[] {
  return (
    collectModuleReferencesFromSource(source, {
      acceptSpecifier: (specifier) => /^(?:\.\.\/)+extensions\//u.test(specifier),
    })
      // This guard owns import specifiers, not URL construction for fixture roots or manifests.
      .filter(({ kind }) => kind !== "import-meta-url")
      .map(({ specifier }) => specifier)
  );
}

function isAllowedExtensionPublicImport(specifier: string): boolean {
  return /(?:^|\/)extensions\/[^/]+\/(?:api|index|runtime-api|setup-entry|login-qr-api|test-api)\.js$/u.test(
    specifier,
  );
}

function findPluginSdkImports(source: string): string[] {
  return importMatches(source, [
    /from\s+["']((?:\.\.\/)+plugin-sdk\/[^"']+)["']/g,
    /import\(\s*["']((?:\.\.\/)+plugin-sdk\/[^"']+)["']\s*\)/g,
  ]).flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

function findBundledPluginPublicSurfaceImports(source: string): string[] {
  return importMatches(source, [
    /from\s+["'](?:\.\.\/)+test-utils\/bundled-plugin-public-surface\.js["']/g,
    /import\(\s*["'](?:\.\.\/)+test-utils\/bundled-plugin-public-surface\.js["']\s*\)/g,
  ]).map((match) => match[0]);
}

function findRelativeSrcImports(source: string): string[] {
  return importMatches(source, [
    /from\s+["']((?:\.\.?\/)+src\/[^"']+)["']/g,
    /import\(\s*["']((?:\.\.?\/)+src\/[^"']+)["']\s*\)/g,
    /vi\.(?:mock|doMock)\s*\(\s*["']((?:\.\.?\/)+src\/[^"']+)["']/g,
  ]).flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

function getImportBasename(importPath: string): string {
  return importPath.split("/").at(-1) ?? importPath;
}

function readImportBindingName(binding: string): string {
  return (
    binding
      .trim()
      .replace(/^type\s+/u, "")
      .split(/\s+as\s+/u)[0] ?? ""
  );
}

function collectBundledPluginIds(): Set<string> {
  return new Set(
    listGitFiles(path.join(repoRoot, "extensions"))
      .map((file) => /^extensions\/([^/]+)\//u.exec(file)?.[1])
      .filter((pluginId): pluginId is string => Boolean(pluginId)),
  );
}

function getLineNumber(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function findRealBroadSourceApiResolverReferences(
  source: string,
  pluginIds: Set<string>,
): string[] {
  const offenders: string[] = [];
  for (const match of source.matchAll(/\{[^{}]*\bdirName:\s*["'][^"']+["'][^{}]*\}/g)) {
    const objectLiteral = match[0];
    const dirName = objectLiteral.match(/\bdirName:\s*["']([^"']+)["']/)?.[1];
    const artifactBasename = objectLiteral.match(/\bartifactBasename:\s*["']([^"']+)["']/)?.[1];
    if (
      dirName &&
      artifactBasename &&
      pluginIds.has(dirName) &&
      BROAD_PUBLIC_SOURCE_ARTIFACT_BASENAMES.has(artifactBasename)
    ) {
      offenders.push(`${dirName}/${artifactBasename}:${getLineNumber(source, match.index ?? 0)}`);
    }
  }

  return offenders;
}

function isAllowedCoreContractSuite(file: string, imports: readonly string[]): boolean {
  return (
    file.startsWith("src/channels/plugins/contracts/") &&
    file.endsWith(".contract.test.ts") &&
    imports.every((entry) =>
      ALLOWED_EXTENSION_PUBLIC_SURFACE_BASENAMES.has(getImportBasename(entry)),
    )
  );
}

describe("non-extension test boundaries", () => {
  it("ignores fixture URLs", () => {
    expect(
      findExtensionImports(
        parser.parseSourceFile(
          "source.ts",
          'const fixtureUrl = new URL("../../extensions/feishu/openclaw.plugin.json", import.meta.url);',
        ),
      ),
    ).toEqual([]);
  });

  it("lists boundary scan files from git without walking repo roots", () => {
    expectNoReaddirSyncDuring(() => {
      const srcTests = walk(path.join(repoRoot, "src"));
      const srcCode = walkCode(path.join(repoRoot, "src"));
      const pluginIds = collectBundledPluginIds();

      expect(srcTests.length).toBeGreaterThan(0);
      expect(srcCode.length).toBeGreaterThan(0);
      expect(pluginIds.size).toBeGreaterThan(0);
    });
  });

  it("keeps plugin-owned behavior suites under the bundled plugin tree", () => {
    const testFiles = coreTests();

    const offenders: { file: string; imports: string[] }[] = [];
    // Batch project reloads without retaining syntax trees for the entire repository.
    const batchSize = 128;
    for (let offset = 0; offset < testFiles.length; offset += batchSize) {
      const sources = testFiles.slice(offset, offset + batchSize).map((fileName) => ({
        fileName,
        text: fs.readFileSync(path.join(repoRoot, fileName), "utf8"),
      }));
      for (const source of parser.parseSourceFiles(sources)) {
        const file = toRepoRelativePath(repoRoot, source.fileName);
        const imports = findExtensionImports(source).filter(
          (specifier) => !isAllowedExtensionPublicImport(specifier),
        );
        if (imports.length === 0 || isAllowedCoreContractSuite(file, imports)) {
          continue;
        }
        offenders.push({ file, imports });
      }
    }

    expect(offenders).toStrictEqual([]);
  });

  it("keeps extension-owned onboard helper coverage out of the core onboard auth suite", () => {
    const bannedPluginSdkModules = new Set(
      "litellm minimax mistral opencode-go opencode openrouter synthetic xai xiaomi"
        .split(" ")
        .map((name) => `../plugin-sdk/${name}.js`),
    );
    const file = "src/commands/onboard-auth.test.ts";
    const source = readSource(file);
    const imports = findPluginSdkImports(source).filter((entry) =>
      bannedPluginSdkModules.has(entry),
    );

    expect(imports).toStrictEqual([]);
  });

  it("keeps resolver tests on generated fixtures for broad bundled plugin source APIs", () => {
    const bundledPluginIds = collectBundledPluginIds();
    const offenders = BUNDLED_PLUGIN_RESOLVER_TEST_FILES.flatMap((file) => {
      const source = readSource(file);
      return findRealBroadSourceApiResolverReferences(source, bundledPluginIds).map(
        (reference) => `${file}: ${reference}`,
      );
    });

    expect(offenders).toStrictEqual([]);
  });

  it.each([
    {
      name: "bundled plugin public-surface imports out of core production source",
      files: () =>
        walkCode(path.join(repoRoot, "src")).filter(
          (file) =>
            !getChangedPathFacts(file).isTestOnly &&
            !file.startsWith(CHANNEL_CONTRACT_TEST_HELPERS_PREFIX),
        ),
      matches: (source: string) => findBundledPluginPublicSurfaceImports(source).length > 0,
    },
    {
      name: "bundled channel security collector coverage under extension tests",
      files: () =>
        coreTests(["src", "test"]).filter(
          (file) => file !== "test/extension-test-boundary.test.ts",
        ),
      matches: (source: string) =>
        source.includes("test/helpers/channels/security-audit-contract.js") ||
        source.includes("src/channels/plugins/contracts/test-helpers/security-audit-contract.js"),
    },
    {
      name: "extension channel contract helpers on the public testing surface",
      files: () => walkCode(path.join(repoRoot, "extensions")),
      matches: (source: string) => source.includes("src/channels/plugins/contracts/test-helpers/"),
    },
    {
      name: "extension tests off the legacy test alias and repo helper bridges",
      files: () => walkCode(path.join(repoRoot, "extensions")),
      matches: (source: string) => LEGACY_HELPER_IMPORTS.some((pattern) => pattern.test(source)),
    },
  ])("keeps $name", ({ files, matches }) => {
    expect(matchingFiles(files(), matches)).toStrictEqual([]);
  });

  it("keeps extension root test-support helpers from reaching into private src trees", () => {
    const files = walkCode(path.join(repoRoot, "extensions")).filter((file) =>
      /^extensions\/[^/]+\/test-support(?:\.ts|\/)/u.test(file),
    );

    const offenders = files
      .map((file) => {
        const imports = findRelativeSrcImports(readSource(file));
        return imports.length === 0 ? null : { file, imports };
      })
      .filter((entry): entry is { file: string; imports: string[] } => entry !== null);

    expect(offenders).toStrictEqual([]);
  });

  it("keeps bundled extension sources on the canonical channel config schema facade", () => {
    const files = walkCode(path.join(repoRoot, "extensions"));
    // The legacy/primitives shells stay export-compatible for third-party
    // plugins only; bundled code imports channel-config-schema, plus the
    // bundled facade strictly for retained bundled provider schemas.
    const bannedSpecifiers = [
      "openclaw/plugin-sdk/channel-config-schema-legacy",
      "openclaw/plugin-sdk/channel-config-primitives",
    ];
    const bundledProviderSchemaNames = new Set([
      "GoogleChatConfigSchema",
      "IMessageConfigSchema",
      "TelegramConfigSchema",
      "WhatsAppConfigSchema",
    ]);
    const bundledFacadeBindingPattern =
      /\b(?:import|export)\s+(?:type\s+)?\{(?<bindings>[^}]*)\}\s*from\s*["']openclaw\/plugin-sdk\/bundled-channel-config-schema["']/gu;

    const offenders = files.flatMap((file) => {
      const source = readSource(file);
      const fileOffenders = bannedSpecifiers
        .filter((specifier) => source.includes(specifier))
        .map((specifier) => `${file}: ${specifier}`);
      for (const match of source.matchAll(bundledFacadeBindingPattern)) {
        const genericBindings = (match.groups?.bindings ?? "")
          .split(",")
          .map(readImportBindingName)
          .filter((name) => name.length > 0 && !bundledProviderSchemaNames.has(name));
        fileOffenders.push(
          ...genericBindings.map((name) => `${file}: bundled-channel-config-schema#${name}`),
        );
      }
      return fileOffenders;
    });

    expect(offenders).toStrictEqual([]);
  });
});
