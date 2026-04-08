import { existsSync, readFileSync } from "node:fs";
import path, { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { listBundledPluginMetadata } from "../bundled-plugin-metadata.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RUNTIME_ENTRY_HELPER_RE = /(^|\/)plugin-entry\.runtime\.[cm]?[jt]s$/;
const GUARDED_CONTRACT_ARTIFACT_BASENAMES = new Set([
  "channel-config-api.js",
  "contract-api.js",
  "secret-contract-api.js",
  "security-contract-api.js",
]);
const SOURCE_MODULE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const;
const FORBIDDEN_CONTRACT_MODULE_SPECIFIER_PATTERNS = [
  /^vitest$/u,
  /^openclaw\/plugin-sdk\/testing$/u,
  /(^|\/)test-api(?:\.[cm]?[jt]s)?$/u,
  /(^|\/)__tests__(\/|$)/u,
  /(^|\/)[^/]*\.test(?:[-.][^/]*)?(?:\.[cm]?[jt]s)?$/u,
  /(^|\/)[^/]*(?:test-harness|test-plugin|test-helper|harness)[^/]*(?:\.[cm]?[jt]s)?$/u,
] as const;
const FORBIDDEN_CONTRACT_MODULE_PATH_PATTERNS = [
  /(^|\/)__tests__(\/|$)/u,
  /(^|\/)test-api\.[cm]?[jt]s$/u,
  /(^|\/)[^/]*\.test(?:[-.][^/]*)?\.[cm]?[jt]s$/u,
  /(^|\/)[^/]*(?:test-harness|test-plugin|test-helper|harness)[^/]*\.[cm]?[jt]s$/u,
] as const;
function listBundledPluginRoots() {
  return loadPluginManifestRegistry({})
    .plugins.filter((plugin) => plugin.origin === "bundled")
    .map((plugin) => ({
      pluginId: plugin.id,
      rootDir: plugin.workspaceDir ?? plugin.rootDir,
    }))
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function resolvePublicSurfaceSourcePath(
  pluginDir: string,
  artifactBasename: string,
): string | null {
  const stem = artifactBasename.replace(/\.[^.]+$/u, "");
  for (const extension of SOURCE_MODULE_EXTENSIONS) {
    const candidate = resolve(pluginDir, `${stem}${extension}`);
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // Keep trying.
    }
  }
  return null;
}

function collectProductionContractEntryPaths(): Array<{
  pluginId: string;
  entryPath: string;
  pluginRoot: string;
}> {
  return listBundledPluginMetadata({ rootDir: REPO_ROOT }).flatMap((plugin) => {
    const pluginRoot = resolve(REPO_ROOT, "extensions", plugin.dirName);
    const entryPaths = new Set<string>();
    for (const artifact of plugin.publicSurfaceArtifacts ?? []) {
      if (!GUARDED_CONTRACT_ARTIFACT_BASENAMES.has(artifact)) {
        continue;
      }
      const sourcePath = resolvePublicSurfaceSourcePath(pluginRoot, artifact);
      if (sourcePath) {
        entryPaths.add(sourcePath);
      }
    }
    return [...entryPaths].map((entryPath) => ({
      pluginId: plugin.manifest.id,
      entryPath,
      pluginRoot,
    }));
  });
}

function formatRepoRelativePath(filePath: string): string {
  return relative(REPO_ROOT, filePath).replaceAll(path.sep, "/");
}

function collectSourceModuleSpecifiers(params: { filePath: string; source: string }): string[] {
  const sourceFile = ts.createSourceFile(
    params.filePath,
    params.source,
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.add(statement.moduleSpecifier.text);
      }
      continue;
    }

    if (!ts.isExportDeclaration(statement)) {
      continue;
    }

    if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      specifiers.add(statement.moduleSpecifier.text);
    }
  }
  return [...specifiers];
}

function matchesForbiddenContractSpecifier(specifier: string): boolean {
  for (const pattern of FORBIDDEN_CONTRACT_MODULE_SPECIFIER_PATTERNS) {
    if (pattern.test(specifier)) {
      return true;
    }
  }
  return false;
}

function collectRelativeDependencySpecifiers(params: { filePath: string; source: string }): string[] {
  return collectSourceModuleSpecifiers(params).filter((specifier) => specifier.startsWith("."));
}

function importsDefinePluginEntryFromCore(source: string, filePath: string): boolean {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    if (
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "openclaw/plugin-sdk/core"
    ) {
      continue;
    }
    if (
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => (element.propertyName?.text ?? element.name.text) === "definePluginEntry",
      )
    ) {
      return true;
    }
  }
  return false;
}

function collectForbiddenContractSpecifiers(params: { filePath: string; source: string }): string[] {
  const failures: string[] = [];
  for (const specifier of collectSourceModuleSpecifiers(params)) {
    if (matchesForbiddenContractSpecifier(specifier)) {
      failures.push(specifier);
    }
  }
  return failures;
}

function resolveRelativeSourceModulePath(fromPath: string, specifier: string): string | null {
  const rawTargetPath = resolve(dirname(fromPath), specifier);
  const candidates = new Set<string>();
  const rawExtension = path.extname(rawTargetPath);
  if (rawExtension) {
    candidates.add(rawTargetPath);
    const stem = rawTargetPath.slice(0, -rawExtension.length);
    for (const extension of SOURCE_MODULE_EXTENSIONS) {
      candidates.add(`${stem}${extension}`);
    }
  } else {
    for (const extension of SOURCE_MODULE_EXTENSIONS) {
      candidates.add(`${rawTargetPath}${extension}`);
      candidates.add(resolve(rawTargetPath, `index${extension}`));
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function findForbiddenContractModuleGraphPaths(params: {
  entryPath: string;
  pluginRoot: string;
}): string[] {
  const failures: string[] = [];
  const visited = new Set<string>();
  const pending = [params.entryPath];

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath || visited.has(currentPath)) {
      continue;
    }
    visited.add(currentPath);

    const repoRelativePath = formatRepoRelativePath(currentPath);
    for (const pattern of FORBIDDEN_CONTRACT_MODULE_PATH_PATTERNS) {
      if (pattern.test(repoRelativePath)) {
        failures.push(`${repoRelativePath} matched ${pattern}`);
      }
    }

    const source = readFileSync(currentPath, "utf8");
    for (const specifier of collectForbiddenContractSpecifiers({ filePath: currentPath, source })) {
      failures.push(`${repoRelativePath} imported ${specifier}`);
    }

    for (const specifier of collectRelativeDependencySpecifiers({ filePath: currentPath, source })) {
      const resolvedModulePath = resolveRelativeSourceModulePath(currentPath, specifier);
      if (!resolvedModulePath) {
        continue;
      }
      if (resolvedModulePath === currentPath) {
        continue;
      }
      if (!resolvedModulePath.startsWith(params.pluginRoot + path.sep)) {
        continue;
      }
      pending.push(resolvedModulePath);
    }
  }

  return failures;
}

describe("plugin entry guardrails", () => {
  it("keeps bundled extension entry modules off direct definePluginEntry imports from core", () => {
    const failures: string[] = [];

    for (const plugin of listBundledPluginRoots()) {
      const indexPath = resolve(plugin.rootDir, "index.ts");
      try {
        const source = readFileSync(indexPath, "utf8");
        if (importsDefinePluginEntryFromCore(source, indexPath)) {
          failures.push(`extensions/${plugin.pluginId}/index.ts`);
        }
      } catch {
        // Skip extensions without index.ts entry modules.
      }
    }

    expect(failures).toEqual([]);
  });

  it("does not advertise runtime helper sidecars as bundled plugin entry extensions", () => {
    const failures: string[] = [];

    for (const plugin of listBundledPluginRoots()) {
      const packageJsonPath = resolve(plugin.rootDir, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          openclaw?: { extensions?: unknown };
        };
        const extensions = Array.isArray(pkg.openclaw?.extensions) ? pkg.openclaw.extensions : [];
        if (
          extensions.some(
            (candidate) => typeof candidate === "string" && RUNTIME_ENTRY_HELPER_RE.test(candidate),
          )
        ) {
          failures.push(`extensions/${plugin.pluginId}/package.json`);
        }
      } catch {
        // Skip directories without package metadata.
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps bundled production contract barrels off test-only imports and re-exports", () => {
    const failures = collectProductionContractEntryPaths().flatMap(
      ({ pluginId, entryPath, pluginRoot }) =>
        findForbiddenContractModuleGraphPaths({
          entryPath,
          pluginRoot,
        }).map((failure) => `${pluginId}: ${failure}`),
    );

    expect(failures).toEqual([]);
  });

  it("follows relative import edges while scanning guarded contract graphs", () => {
    expect(
      collectRelativeDependencySpecifiers({
        filePath: "guardrail-fixture.ts",
        source: `
        import { x } from "./safe.js";
        import "./setup.js";
        export { x };
        export * from "./barrel.js";
        import { y } from "openclaw/plugin-sdk/testing";
      `,
      }).toSorted(),
    ).toEqual(["./barrel.js", "./safe.js", "./setup.js"]);
  });

  it("detects aliased definePluginEntry imports from core", () => {
    expect(
      importsDefinePluginEntryFromCore(
        `
          import { definePluginEntry as dpe } from "openclaw/plugin-sdk/core";
          import { somethingElse } from "openclaw/plugin-sdk/core";
        `,
        "aliased-plugin-entry.ts",
      ),
    ).toBe(true);
  });
});
