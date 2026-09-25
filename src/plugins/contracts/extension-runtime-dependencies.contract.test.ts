// Extension runtime dependency contract tests cover runtime dependency placement for extensions.
import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { afterAll, describe, expect, it } from "vitest";
import { createNativeTypeScriptParser } from "../../../scripts/lib/native-typescript.mts";
import { resolvePluginNpmRuntimeBuildPlan } from "../../../scripts/lib/plugin-npm-runtime-build.mts";
import { visitModuleSpecifiers } from "../../../scripts/lib/ts-guard-utils.mts";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import {
  listGitTrackedFiles,
  toRepoPath,
  toRepoRelativePath,
} from "../../test-utils/repo-files.js";

const EXTENSION_ROOT = "extensions";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const EXTENSION_RUNTIME_FILE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const BUILTIN_MODULES = new Set(builtinModules.map((moduleId) => moduleId.replace(/^node:/, "")));
const OPTIONAL_UNDECLARED_RUNTIME_IMPORTS = new Map<string, Set<string>>([
  [
    "extensions/canvas",
    // The A2UI bundle probes this optional markdown renderer and falls back when absent.
    new Set(["@a2ui/markdown-it"]),
  ],
  [
    "extensions/discord",
    // @discordjs/voice still probes the native addon in its dependency report path.
    new Set(["@discordjs/opus"]),
  ],
  ["extensions/qa-lab", new Set(["crabline"])],
]);
const INDIRECT_RUNTIME_DEPENDENCIES = new Map<string, Set<string>>([
  [
    "extensions/browser",
    // The MCP SDK loads zod through its server/zod-compat runtime path.
    new Set(["zod"]),
  ],
  [
    "extensions/whatsapp",
    // Baileys loads this optional peer for audio decoding.
    new Set(["audio-decode"]),
  ],
  [
    "extensions/memory-lancedb",
    // LanceDB imports apache-arrow at runtime through its peer dependency.
    new Set(["apache-arrow"]),
  ],
  [
    "extensions/memory-core",
    // Packaged memory tools run through generated OpenClaw runtime chunks that parse JSON5 config.
    new Set(["json5"]),
  ],
  [
    "extensions/slack",
    // Bolt loads Socket Mode, whose Undici 7 peer must be provided by the plugin package.
    new Set(["undici"]),
  ],
  [
    "extensions/tlon",
    // The Tlon plugin manifest exposes the bundled skill from this package path.
    new Set(["@tloncorp/tlon-skill"]),
  ],
]);
const COMPUTED_RUNTIME_DEPENDENCIES = new Map<string, Set<string>>([
  [
    "extensions/discord",
    // Bundled at build time into the served Discord Activity shell asset rather than
    // imported by plugin runtime code; see scripts/build-discord-activity-sdk.mts.
    new Set(["@discord/embedded-app-sdk"]),
  ],
  [
    "extensions/lobster",
    // Keep Lobster external to the plugin bundle; its computed core import is resolved at runtime.
    new Set(["@clawdbot/lobster"]),
  ],
]);

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  openclaw?: {
    build?: {
      staticAssets?: Array<{ source?: string }>;
    };
  };
};
const trackedFilesByRoot = new Map<string, readonly string[] | null>();
const runtimeImportsByPath = new Map<string, string[]>();
const parser = createNativeTypeScriptParser({ cwd: REPO_ROOT });
afterAll(() => parser.close());

function readPackageManifest(filePath: string): PackageManifest {
  return JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, filePath), "utf8")) as PackageManifest;
}

function listTrackedFiles(root: string): string[] | null {
  const relativeRoot = toRepoRelativePath(REPO_ROOT, path.resolve(REPO_ROOT, root));
  if (!relativeRoot || relativeRoot.startsWith("..")) {
    return null;
  }
  if (trackedFilesByRoot.has(relativeRoot)) {
    const files = trackedFilesByRoot.get(relativeRoot);
    return files ? [...files] : null;
  }
  const trackedFiles = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: relativeRoot });
  if (!trackedFiles) {
    trackedFilesByRoot.set(relativeRoot, null);
    return null;
  }
  const files = trackedFiles.toSorted();
  trackedFilesByRoot.set(relativeRoot, files);
  return [...files];
}

function listPackageManifests(root: string): string[] {
  const trackedFiles = listTrackedFiles(root);
  if (trackedFiles) {
    return trackedFiles
      .filter((filePath) => /^extensions\/[^/]+\/package\.json$/u.test(filePath))
      .toSorted();
  }

  const entries = fs.readdirSync(root, { withFileTypes: true });
  const manifests: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(root, entry.name, "package.json");
    if (fs.existsSync(manifestPath)) {
      manifests.push(manifestPath);
    }
  }
  return manifests.toSorted();
}

function shouldSkipRuntimeFile(filePath: string): boolean {
  const normalized = toRepoPath(filePath);
  if (
    normalized.includes("/node_modules/") ||
    normalized.includes("/dist/") ||
    normalized.includes("/coverage/") ||
    normalized.includes("/assets/") ||
    normalized.endsWith("/web/vite.config.ts")
  ) {
    return true;
  }
  return /(\.(test|spec|d)\.(ts|tsx|js|jsx|mjs|cjs)$|\/(test|tests|__tests__|test-support)\/|test-(helpers|support|harness|mocks|fixtures|runtime|shared|utils)|\.test-(helpers|support|harness|mocks|fixtures|runtime|shared|utils)|fixture-test-support|mock-setup|test-fixtures|test-runtime-mocks|\.harness\.|e2e-harness|\.mock\.|-mock\.|-mocks\.|mocks-test-support|\.fixture|\.fixtures)/.test(
    normalized,
  );
}

function listRuntimeFiles(root: string): string[] {
  const manifest = readPackageManifest(path.join(root, "package.json"));
  // Static assets execute from the packaged plugin even when a dirty remote sync has not added
  // their new source paths to Git's index, so the manifest must remain an authoritative input.
  const staticAssetSources = (manifest.openclaw?.build?.staticAssets ?? []).flatMap((entry) => {
    const source = entry.source?.trim().replace(/^\.\/+/, "");
    if (!source || source.startsWith("../") || source.includes("/../")) {
      return [];
    }
    const filePath = toRepoPath(path.posix.join(root, source));
    return EXTENSION_RUNTIME_FILE_EXTENSIONS.has(path.extname(filePath)) &&
      !shouldSkipRuntimeFile(filePath) &&
      fs.existsSync(path.resolve(REPO_ROOT, filePath))
      ? [filePath]
      : [];
  });
  const trackedFiles = listTrackedFiles(root);
  if (trackedFiles) {
    return [
      ...new Set([
        ...trackedFiles.filter(
          (filePath) =>
            EXTENSION_RUNTIME_FILE_EXTENSIONS.has(path.extname(filePath)) &&
            !shouldSkipRuntimeFile(filePath),
        ),
        ...staticAssetSources,
      ]),
    ].toSorted();
  }

  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipRuntimeFile(filePath)) {
          visit(filePath);
        }
        continue;
      }
      if (
        EXTENSION_RUNTIME_FILE_EXTENSIONS.has(path.extname(entry.name)) &&
        !shouldSkipRuntimeFile(filePath)
      ) {
        files.push(filePath);
      }
    }
  };
  visit(root);
  return [...new Set([...files, ...staticAssetSources])].toSorted();
}

function readManifestText(root: string): string {
  const manifestPath = path.join(root, "openclaw.plugin.json");
  const resolvedManifestPath = path.resolve(REPO_ROOT, manifestPath);
  return fs.existsSync(resolvedManifestPath) ? fs.readFileSync(resolvedManifestPath, "utf8") : "";
}

function packageNameForSpecifier(specifier: string): string | null {
  if (
    specifier.startsWith("$") ||
    specifier.includes("${") ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:")
  ) {
    return null;
  }
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : specifier;
  }
  return specifier.split("/")[0] ?? null;
}

function collectRuntimeImportsFromSource(source: ts.SourceFile): string[] {
  const imports = new Set<string>();
  visitModuleSpecifiers(
    source,
    ({ node, specifier }) => {
      // Inline `type` specifiers leave an empty runtime import/export under this
      // repository's verbatimModuleSyntax setting. Only whole declarations erase.
      if (
        (ts.isImportDeclaration(node) &&
          node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) ||
        (ts.isExportDeclaration(node) && node.isTypeOnly) ||
        (ts.isImportEqualsDeclaration(node) && node.isTypeOnly)
      ) {
        return;
      }
      const packageName = packageNameForSpecifier(specifier);
      if (packageName) {
        imports.add(packageName);
      }
    },
    { includeCommonJs: true },
  );
  return [...imports].toSorted();
}

function cacheRuntimeImports(filePaths: readonly string[]): void {
  const pending = [
    ...new Set(filePaths.map((filePath) => path.resolve(REPO_ROOT, filePath))),
  ].filter((filePath) => !runtimeImportsByPath.has(filePath));
  // Amortize native snapshot reloads without retaining the entire extension AST corpus.
  const batchSize = 32;
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize).map((fileName) => ({
      fileName,
      text: fs.readFileSync(fileName, "utf8"),
    }));
    for (const source of parser.parseSourceFiles(batch)) {
      runtimeImportsByPath.set(
        path.resolve(source.fileName),
        collectRuntimeImportsFromSource(source),
      );
    }
  }
}

function collectRuntimeImports(filePath: string): string[] {
  const absolutePath = path.resolve(REPO_ROOT, filePath);
  cacheRuntimeImports([absolutePath]);
  const imports = runtimeImportsByPath.get(absolutePath);
  if (!imports) {
    throw new Error(`Runtime import scan did not capture ${filePath}`);
  }
  return imports;
}

describe("runtime import syntax", () => {
  const importsFromText = (source: string, fileName = "runtime-import-fixture.ts") =>
    collectRuntimeImportsFromSource(parser.parseSourceFile(fileName, source));

  it("does not treat quoted external-runtime probe code as a plugin dependency", () => {
    const source = 'const probe = `const sky = await import("@oai/sky");`;';
    expect(importsFromText(source)).toEqual([]);
    expect(importsFromText('const sky = await import("@oai/sky");')).toEqual(["@oai/sky"]);
  });

  it("ignores imports in strings, comments, regular expressions, template text, and JSX text", () => {
    const source = [
      '// import "comment-line";',
      '/* require("comment-block"); export * from "comment-export"; */',
      'const quoted = "import(\\"quoted\\")";',
      'const regexp = /import\\("regexp"\\)/;',
      'const template = `import("template-text") ${"require(\\"quoted-expression\\")"}`;',
      'const jsx = <div>import("jsx-text")</div>;',
    ].join("\n");
    expect(importsFromText(source, "runtime-import-fixture.tsx")).toEqual([]);
  });

  it("retains actual static, dynamic, template-interpolation, and CommonJS package edges", () => {
    const source = [
      'import "side-effect";',
      'import value from "static-import/subpath";',
      'export { value } from "named-export";',
      'export * from "star-export";',
      'const dynamic = import("dynamic-import");',
      "const literal = import(`literal-template`);",
      'const cjs = require("commonjs/subpath");',
      'import legacy = require("import-equals");',
      'const interpolation = `quoted ${import("interpolated-import")}`;',
      'const jsx = <div>{require("jsx-expression")}</div>;',
    ].join("\n");
    expect(importsFromText(source, "runtime-import-fixture.tsx")).toEqual([
      "commonjs",
      "dynamic-import",
      "import-equals",
      "interpolated-import",
      "jsx-expression",
      "literal-template",
      "named-export",
      "side-effect",
      "star-export",
      "static-import",
    ]);
  });

  it("excludes erased type-only declarations but retains inline-type declaration side effects", () => {
    const source = [
      'import type Default from "type-default";',
      'import type { Named } from "type-named";',
      'export type { Named } from "type-export";',
      'export type * from "type-star";',
      'import type Legacy = require("type-equals");',
      'type Dynamic = import("type-dynamic").Shape;',
      'type Query = typeof import("type-query");',
      'import { type Named } from "inline-type-import";',
      'export { type Named } from "inline-type-export";',
      'import { type Named, runtime } from "mixed-import";',
      'export { type Named, runtime } from "mixed-export";',
      'import {} from "empty-import";',
      'export {} from "empty-export";',
    ].join("\n");
    expect(importsFromText(source)).toEqual([
      "empty-export",
      "empty-import",
      "inline-type-export",
      "inline-type-import",
      "mixed-export",
      "mixed-import",
    ]);
  });
});

function runtimeDependencyNames(manifest: PackageManifest): Set<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

function collectBundledRuntimeDependencies(root: string, manifest: PackageManifest) {
  const dependencies = new Map<string, PackageManifest>();
  const entryFiles = new Set<string>();
  const declared = runtimeDependencyNames(manifest);
  const buildDependencies = new Set(
    Object.keys(manifest.devDependencies ?? {}).filter(
      (name) => !name.startsWith("@openclaw/") && !declared.has(name),
    ),
  );
  const plan = buildDependencies.size
    ? resolvePluginNpmRuntimeBuildPlan({ repoRoot: REPO_ROOT, packageDir: root })
    : null;
  if (!plan) {
    return { dependencies, entryFiles };
  }
  const require = createRequire(path.resolve(REPO_ROOT, root, "package.json"));
  const staticAssets = (manifest.openclaw?.build?.staticAssets ?? []).flatMap((asset) =>
    asset.source ? [path.resolve(REPO_ROOT, root, asset.source)] : [],
  );
  for (const filePath of Object.values(plan.entry)) {
    // Copied assets still need installed dependencies; only emitted entrypoints bundle JS.
    if (
      staticAssets.some((asset) => filePath === asset || filePath.startsWith(`${asset}${path.sep}`))
    ) {
      continue;
    }
    entryFiles.add(toRepoPath(path.relative(REPO_ROOT, filePath)));
    for (const name of collectRuntimeImports(filePath)) {
      if (!buildDependencies.has(name) || dependencies.has(name)) {
        continue;
      }
      const packagePath = require.resolve
        .paths(name)
        ?.map((directory) => path.join(directory, name, "package.json"))
        .find((candidate) => fs.existsSync(candidate));
      if (!packagePath) {
        throw new Error(`${root} cannot resolve bundled dependency ${name}`);
      }
      dependencies.set(name, readPackageManifest(packagePath));
    }
  }
  return { dependencies, entryFiles };
}

function allDependencyNames(manifest: PackageManifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ].toSorted();
}

function isDiscordPackageDependency(dependencyName: string): boolean {
  return (
    dependencyName === "discord-api-types" ||
    dependencyName.startsWith("@discordjs/") ||
    dependencyName.startsWith("@snazzah/")
  );
}

describe("Discord dependency ownership", () => {
  it("keeps Discord packages out of the root manifest", () => {
    const manifest = readPackageManifest("package.json");
    const discordDependencies = allDependencyNames(manifest).filter(isDiscordPackageDependency);

    expect(discordDependencies).toStrictEqual([]);
  });

  for (const manifestPath of listPackageManifests(EXTENSION_ROOT)) {
    const extensionDir = toRepoPath(path.dirname(manifestPath));

    if (extensionDir === "extensions/discord") {
      continue;
    }

    it(`${extensionDir} does not own Discord package dependencies`, () => {
      const manifest = readPackageManifest(manifestPath);
      const discordDependencies = allDependencyNames(manifest).filter(isDiscordPackageDependency);

      expect(discordDependencies).toStrictEqual([]);
    });
  }
});

describe("extension runtime dependency manifests", () => {
  it("lists extension dependency inputs from git without walking extension dirs", () => {
    expectNoReaddirSyncDuring(() => {
      const manifests = listPackageManifests(EXTENSION_ROOT);
      const runtimeFiles = listRuntimeFiles("extensions/discord");

      expect(manifests.length).toBeGreaterThan(0);
      expect(runtimeFiles.length).toBeGreaterThan(0);
    });
  });

  it("keeps json5 in memory-core for packaged runtime config parsing", () => {
    const manifest = readPackageManifest("extensions/memory-core/package.json");

    expect(manifest.dependencies?.json5).toBeTypeOf("string");
    expect(manifest.dependencies?.json5).not.toBe("");
  });

  for (const [extensionDir, dependencies] of COMPUTED_RUNTIME_DEPENDENCIES) {
    it(`${extensionDir} declares every computed runtime dependency`, () => {
      const manifest = readPackageManifest(path.join(extensionDir, "package.json"));
      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
      ]);

      expect([...dependencies].filter((dependencyName) => !declared.has(dependencyName))).toEqual(
        [],
      );
    });
  }

  for (const manifestPath of listPackageManifests(EXTENSION_ROOT)) {
    const extensionDir = toRepoPath(path.dirname(manifestPath));

    it(`${extensionDir} declares every runtime package import`, () => {
      const manifest = readPackageManifest(manifestPath);
      const declared = runtimeDependencyNames(manifest);
      const bundled = collectBundledRuntimeDependencies(extensionDir, manifest);
      const allowedOptional =
        OPTIONAL_UNDECLARED_RUNTIME_IMPORTS.get(extensionDir) ?? new Set<string>();
      const missing = new Map<string, string[]>();

      const runtimeFiles = listRuntimeFiles(extensionDir);
      cacheRuntimeImports(runtimeFiles);
      for (const filePath of runtimeFiles) {
        for (const packageName of collectRuntimeImports(filePath)) {
          if (
            packageName === "openclaw" ||
            packageName.startsWith("@openclaw/") ||
            BUILTIN_MODULES.has(packageName) ||
            declared.has(packageName) ||
            (bundled.entryFiles.has(filePath) && bundled.dependencies.has(packageName)) ||
            allowedOptional.has(packageName)
          ) {
            continue;
          }
          const files = missing.get(packageName) ?? [];
          files.push(toRepoPath(filePath));
          missing.set(packageName, files);
        }
      }

      expect(Object.fromEntries(missing)).toStrictEqual({});
    });

    it(`${extensionDir} does not keep unused direct runtime dependencies`, () => {
      const manifest = readPackageManifest(manifestPath);
      const declared = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
      ].toSorted();
      const allowedIndirect = INDIRECT_RUNTIME_DEPENDENCIES.get(extensionDir) ?? new Set<string>();
      const allowedComputed = COMPUTED_RUNTIME_DEPENDENCIES.get(extensionDir) ?? new Set<string>();
      const bundled = collectBundledRuntimeDependencies(extensionDir, manifest);
      const bundledIndirect = new Map(
        [...bundled.dependencies.values()].flatMap((dependency) =>
          Object.entries({ ...dependency.dependencies, ...dependency.optionalDependencies }),
        ),
      );
      const runtimeText = listRuntimeFiles(extensionDir)
        .map((filePath) => fs.readFileSync(path.resolve(REPO_ROOT, filePath), "utf8"))
        .concat(readManifestText(extensionDir))
        .join("\n");

      const unused = declared.filter(
        (dependencyName) =>
          !allowedIndirect.has(dependencyName) &&
          !allowedComputed.has(dependencyName) &&
          bundledIndirect.get(dependencyName) !==
            (manifest.optionalDependencies?.[dependencyName] ??
              manifest.dependencies?.[dependencyName]) &&
          !runtimeText.includes(dependencyName),
      );

      expect(unused).toStrictEqual([]);
    });
  }
});
