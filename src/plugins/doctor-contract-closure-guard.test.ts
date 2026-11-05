// Doctor contract closure guard tests keep enumeration paths dependency-light.
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript/ast";
import { afterAll, describe, expect, it } from "vitest";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { toLine, visitModuleSpecifiers } from "../../scripts/lib/ts-guard-utils.mts";
import { resolvePluginDoctorContractArtifact } from "./doctor-contract-artifact.js";
import { loadBundledPluginManifestRegistry } from "./manifest-registry-build.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());
const SOURCE_MODULE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const;
const FORBIDDEN_SPECIFIER = "openclaw/plugin-sdk/agent-runtime";
type ClosureKind = "doctor-contract" | "legacy-setup";
// Doctor enumeration must stay dependency-light. Legacy setup also forbids the second group.
const FORBIDDEN_SPECIFIER_RULES = new Map([
  ...[
    "matrix-js-sdk/lib/matrix.js",
    "openclaw/plugin-sdk/provider-model-shared",
    "openclaw/plugin-sdk/acp-runtime",
    "openclaw/plugin-sdk/conversation-runtime",
    "openclaw/plugin-sdk/provider-auth",
    "openclaw/plugin-sdk/channel-secret-basic-runtime",
    "openclaw/plugin-sdk/plugin-state-store-runtime",
    "openclaw/plugin-sdk/session-store-runtime",
    "openclaw/plugin-sdk/channel-outbound",
    "openclaw/plugin-sdk/memory-core-host-engine-schema",
  ].map((specifier) => [specifier, false] as const),
  ...[
    FORBIDDEN_SPECIFIER,
    "openclaw/plugin-sdk/doctor-repair-runtime",
    "openclaw/plugin-sdk/runtime-doctor",
    "openclaw/plugin-sdk/ssrf-runtime",
    "openclaw/plugin-sdk/logging-core",
    "openclaw/plugin-sdk/realtime-voice",
    "openclaw/plugin-sdk/memory-host-core",
  ].map((specifier) => [specifier, true] as const),
]);
const LEGACY_SETUP_PROPERTIES = new Set([
  "legacyStateMigrations",
  "legacySessionSurface",
  "legacySessionSurfaces",
]);

type ClosureEntry = {
  pluginId: string;
  pluginRoot: string;
  entryPath: string;
  kind: ClosureKind;
};

type ModuleReference = { kind: string; line: number; specifier: string };

function formatRepoPath(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
}

function isInsideRoot(rootPath: string, filePath: string): boolean {
  const relativePath = path.relative(rootPath, filePath);
  return !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function resolveRelativeSourceModule(importerPath: string, specifier: string): string | null {
  const targetPath = path.resolve(path.dirname(importerPath), specifier);
  const targetExtension = path.extname(targetPath);
  const candidates: string[] = [];
  if (
    SOURCE_MODULE_EXTENSIONS.includes(targetExtension as (typeof SOURCE_MODULE_EXTENSIONS)[number])
  ) {
    const stem = targetPath.slice(0, -targetExtension.length);
    candidates.push(...SOURCE_MODULE_EXTENSIONS.map((extension) => `${stem}${extension}`));
  } else if (!targetExtension) {
    for (const extension of SOURCE_MODULE_EXTENSIONS) {
      candidates.push(`${targetPath}${extension}`, path.join(targetPath, `index${extension}`));
    }
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function propertyNameText(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLikeNode(name) ? name.text : null;
}

function collectLegacySetupSpecifiers(setupEntryPath: string): string[] {
  const source = fs.readFileSync(setupEntryPath, "utf8");
  const sourceFile = parser.parseSourceFile(setupEntryPath, source);
  const specifiers = new Set<string>();

  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      LEGACY_SETUP_PROPERTIES.has(propertyNameText(node.name) ?? "") &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          propertyNameText(property.name) === "specifier" &&
          ts.isStringLiteralLikeNode(property.initializer)
        ) {
          specifiers.add(property.initializer.text);
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return [...specifiers].toSorted();
}

function hasStaticValue(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    const bindings = clause?.namedBindings;
    return Boolean(
      !clause ||
      (clause.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
        (clause.name ||
          (bindings &&
            (ts.isNamespaceImport(bindings) ||
              bindings.elements.some((element) => !element.isTypeOnly))))),
    );
  }
  if (ts.isExportDeclaration(node)) {
    const clause = node.exportClause;
    return (
      !node.isTypeOnly &&
      (!clause ||
        ts.isNamespaceExport(clause) ||
        clause.elements.some((element) => !element.isTypeOnly))
    );
  }
  return ts.isImportEqualsDeclaration(node) && !node.isTypeOnly;
}

function collectStaticValueReferences(
  filePath: string,
  source: string,
  acceptSpecifier = (specifier: string) =>
    FORBIDDEN_SPECIFIER_RULES.has(specifier) || specifier.startsWith("."),
): ModuleReference[] {
  const sourceFile = parser.parseSourceFile(filePath, source);
  const references: ModuleReference[] = [];
  visitModuleSpecifiers(
    sourceFile,
    ({ kind, node, specifier, specifierNode }) => {
      if (hasStaticValue(node) && acceptSpecifier(specifier)) {
        references.push({ kind, line: toLine(sourceFile, specifierNode), specifier });
      }
    },
    { includeCommonJs: true },
  );
  return references.toSorted(
    (left, right) =>
      left.line - right.line ||
      left.kind.localeCompare(right.kind) ||
      left.specifier.localeCompare(right.specifier),
  );
}

function collectClosureEntries(): ClosureEntry[] {
  const entries: ClosureEntry[] = [];
  const env = {
    ...process.env,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(REPO_ROOT, "extensions"),
  };
  for (const record of loadBundledPluginManifestRegistry({ env }).plugins) {
    const pluginRoot = path.resolve(record.rootDir);
    const doctorContractPath = resolvePluginDoctorContractArtifact({
      ...record,
      rootDir: pluginRoot,
      sourcePreferred: true,
    })?.modulePath;
    // A declaration listing no surface gates the artifact off every enumeration
    // path, exactly as `resolvePluginDoctorContracts` does, so its closure cost
    // is never paid. Absent declarations still load eagerly and are enforced.
    const declaresAnyDoctorSurface =
      !record.doctorContract ||
      Object.values(record.doctorContract).some((value) => value ?? false);
    if (doctorContractPath && declaresAnyDoctorSurface) {
      entries.push({
        pluginId: record.id,
        pluginRoot,
        entryPath: doctorContractPath,
        kind: "doctor-contract",
      });
    }

    if (record.channels.length === 0) {
      continue;
    }
    const packageJsonPath = path.join(pluginRoot, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      openclaw?: { setupEntry?: unknown };
    };
    const setupEntry = packageJson.openclaw?.setupEntry;
    if (typeof setupEntry !== "string") {
      continue;
    }
    const setupEntryPath = path.resolve(pluginRoot, setupEntry);
    for (const specifier of collectLegacySetupSpecifiers(setupEntryPath)) {
      const entryPath = resolveRelativeSourceModule(setupEntryPath, specifier);
      if (entryPath && isInsideRoot(pluginRoot, entryPath)) {
        entries.push({ pluginId: record.id, pluginRoot, entryPath, kind: "legacy-setup" });
      }
    }
  }
  return entries;
}

function inspectRelativeClosure(
  entryPath: string,
  root: string,
  inspect: (filePath: string, reference: ModuleReference) => string | undefined,
): string[] {
  const violations: string[] = [];
  const visited = new Set<string>();
  const pending = [entryPath];

  while (pending.length > 0) {
    const filePath = pending.pop();
    if (!filePath || visited.has(filePath)) {
      continue;
    }
    visited.add(filePath);
    const source = fs.readFileSync(filePath, "utf8");
    for (const reference of collectStaticValueReferences(filePath, source)) {
      const violation = inspect(filePath, reference);
      if (violation) {
        violations.push(violation);
        continue;
      }
      const resolvedPath = resolveRelativeSourceModule(filePath, reference.specifier);
      if (resolvedPath && isInsideRoot(root, resolvedPath)) {
        pending.push(resolvedPath);
      }
    }
  }

  return violations;
}

function collectForbiddenClosureImports(entry: ClosureEntry): string[] {
  return inspectRelativeClosure(entry.entryPath, entry.pluginRoot, (filePath, reference) => {
    const legacyToo = FORBIDDEN_SPECIFIER_RULES.get(reference.specifier);
    return legacyToo !== undefined && (entry.kind === "doctor-contract" || legacyToo)
      ? `${entry.pluginId}: ${formatRepoPath(filePath)}:${reference.line} imports ${reference.specifier}; use a focused subpath or defer the import until migration`
      : undefined;
  });
}

function collectHeavyRuntimeDoctorMigrationImports(): string[] {
  const entryPath = path.join(REPO_ROOT, "src/plugin-sdk/runtime-doctor-migrations.ts");
  const forbiddenPrefixes = ["src/plugin-state/plugin-state-store", "src/state/openclaw-state-db"];
  return inspectRelativeClosure(entryPath, REPO_ROOT, (filePath, reference) => {
    const resolvedPath = resolveRelativeSourceModule(filePath, reference.specifier);
    const repoPath =
      resolvedPath && isInsideRoot(REPO_ROOT, resolvedPath)
        ? formatRepoPath(resolvedPath)
        : undefined;
    return repoPath && forbiddenPrefixes.some((prefix) => repoPath.startsWith(prefix))
      ? `${formatRepoPath(filePath)}:${reference.line} reaches heavy doctor dependency ${repoPath}`
      : undefined;
  });
}

const PLUGIN_SDK_SPECIFIER_PREFIX = "openclaw/plugin-sdk/";

function isKyselySpecifier(specifier: string): boolean {
  return specifier === "kysely" || specifier.startsWith("kysely/");
}

// The transitive walk follows relative imports (plugin-local, core src, and the
// deep-relative package bridges) plus openclaw/plugin-sdk/* subpaths. Other bare
// specifiers are node builtins or npm/workspace packages; only the repo root
// depends on kysely, so every kysely edge is reachable through this resolution.
function resolveTraversalModule(filePath: string, specifier: string): string | null {
  if (specifier.startsWith(".")) {
    return resolveRelativeSourceModule(filePath, specifier);
  }
  if (specifier.startsWith(PLUGIN_SDK_SPECIFIER_PREFIX)) {
    const subpath = specifier.slice(PLUGIN_SDK_SPECIFIER_PREFIX.length);
    return resolveRelativeSourceModule(
      path.join(REPO_ROOT, "src/plugin-sdk", "entrypoint-anchor.ts"),
      `./${subpath}`,
    );
  }
  return null;
}

// Cached per file: null = kysely unreachable; otherwise the first found import
// chain from this file to a kysely value import (repo-relative, entry first).
const kyselyReachabilityByFile = new Map<string, string[] | null>();

function findKyselyChain(filePath: string, inProgress: Set<string>): string[] | null {
  const cached = kyselyReachabilityByFile.get(filePath);
  if (cached !== undefined) {
    return cached;
  }
  if (inProgress.has(filePath)) {
    // Cycle back-edge: the ancestor still explores its remaining children, so
    // skipping here cannot hide a kysely edge.
    return null;
  }
  inProgress.add(filePath);
  let chain: string[] | null = null;
  const source = fs.readFileSync(filePath, "utf8");
  for (const reference of collectStaticValueReferences(
    filePath,
    source,
    (specifier) =>
      isKyselySpecifier(specifier) ||
      specifier.startsWith(".") ||
      specifier.startsWith(PLUGIN_SDK_SPECIFIER_PREFIX),
  )) {
    if (isKyselySpecifier(reference.specifier)) {
      chain = [`${formatRepoPath(filePath)}:${reference.line} imports ${reference.specifier}`];
      break;
    }
    const resolvedPath = resolveTraversalModule(filePath, reference.specifier);
    if (!resolvedPath || !isInsideRoot(REPO_ROOT, resolvedPath)) {
      continue;
    }
    const childChain = findKyselyChain(resolvedPath, inProgress);
    if (childChain) {
      chain = [`${formatRepoPath(filePath)}:${reference.line} -> ${reference.specifier}`].concat(
        childChain,
      );
      break;
    }
  }
  inProgress.delete(filePath);
  kyselyReachabilityByFile.set(filePath, chain);
  return chain;
}

describe("doctor contract import closures", () => {
  it("classifies only static value module edges", () => {
    const source = [
      `import type { A } from "${FORBIDDEN_SPECIFIER}";`,
      `import { type B } from "${FORBIDDEN_SPECIFIER}";`,
      `export type { C } from "${FORBIDDEN_SPECIFIER}";`,
      `export { type D } from "${FORBIDDEN_SPECIFIER}";`,
      `type E = import("${FORBIDDEN_SPECIFIER}").E;`,
      `const lazy = () => import("${FORBIDDEN_SPECIFIER}");`,
      `import { type F, value } from "${FORBIDDEN_SPECIFIER}";`,
      `export { type G, otherValue } from "${FORBIDDEN_SPECIFIER}";`,
    ].join("\n");

    expect(collectStaticValueReferences("fixture.ts", source)).toEqual([
      { kind: "import", line: 7, specifier: FORBIDDEN_SPECIFIER },
      { kind: "export", line: 8, specifier: FORBIDDEN_SPECIFIER },
    ]);
  });

  it("keeps broad agent runtime and heavy doctor barrels off doctor enumeration paths", () => {
    const violations = collectClosureEntries().flatMap(collectForbiddenClosureImports).toSorted();
    expect(violations).toStrictEqual([]);
  });

  it("keeps the runtime doctor migration helper off state DB and plugin-state graphs", () => {
    expect(collectHeavyRuntimeDoctorMigrationImports()).toStrictEqual([]);
  });

  // The exhaustive backstop: no doctor-contract or legacy-setup closure may reach
  // the kysely package through any static value import chain, regardless of which
  // barrel introduces the edge. Type-only and dynamic imports stay allowed.
  it("keeps kysely statically unreachable from every plugin closure", () => {
    const violations = collectClosureEntries()
      .flatMap((entry) => {
        const chain = findKyselyChain(entry.entryPath, new Set());
        return chain
          ? [`${entry.pluginId}: closure reaches kysely via\n    ${chain.join("\n    ")}`]
          : [];
      })
      .toSorted();
    expect(violations).toStrictEqual([]);
  });
});
