// Static method policy avoids storage; prepared shutdown avoids runtime session dependencies.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { afterAll, describe, expect, it } from "vitest";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function resolveRelativeSource(importer: string, specifier: string): string | null {
  const rawPath = path.resolve(path.dirname(importer), specifier);
  const withoutJs = rawPath.replace(/\.(?:mjs|cjs|js)$/u, "");
  for (const candidate of [
    rawPath,
    `${withoutJs}.ts`,
    `${withoutJs}.mts`,
    `${withoutJs}.cts`,
    path.join(withoutJs, "index.ts"),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function staticValueSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) {
        continue;
      }
      if (
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        !clause.name &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly)
      ) {
        continue;
      }
      specifiers.push(statement.moduleSpecifier.text);
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

// Each case reads the same checkout; retain import facts, not native syntax trees.
const importsByFile = new Map<string, string[]>();

function collectStaticValueImportGraph(entryRelativePath: string): Map<string, string[]> {
  const entryPath = path.join(repoRoot, entryRelativePath);
  const graph = new Map<string, string[]>();
  const pending = new Set([entryPath]);
  while (pending.size > 0) {
    const batch = [...pending].slice(0, 32);
    const uncached = batch.filter((filePath) => !importsByFile.has(filePath));
    if (uncached.length) {
      const sources = parser.parseSourceFiles(
        uncached.map((fileName) => ({ fileName, text: readFileSync(fileName, "utf8") })),
      );
      for (const [index, source] of sources.entries()) {
        importsByFile.set(uncached[index]!, staticValueSpecifiers(source));
      }
    }
    for (const filePath of batch) {
      pending.delete(filePath);
      const specifiers = importsByFile.get(filePath)!;
      graph.set(filePath, specifiers);
      for (const specifier of specifiers) {
        if (!specifier.startsWith(".")) {
          continue;
        }
        const resolved = resolveRelativeSource(filePath, specifier);
        if (resolved && !graph.has(resolved)) {
          pending.add(resolved);
        }
      }
    }
  }
  return graph;
}

describe("gateway startup import boundaries", () => {
  it("keeps static method policy independent of session storage", () => {
    const graph = collectStaticValueImportGraph("src/gateway/method-scopes.ts");
    const sessionStorageImports = [...graph.keys()]
      .map((filePath) => path.relative(repoRoot, filePath))
      .filter((filePath) => filePath.startsWith(path.join("src", "config", "sessions") + path.sep));

    expect(sessionStorageImports).toEqual([]);
  });

  it("keeps ordinary session lifecycle code out of the prepared shutdown graph", () => {
    const graph = collectStaticValueImportGraph("src/gateway/server-close.runtime.ts");

    expect([...graph.keys()].map((filePath) => path.relative(repoRoot, filePath))).not.toContain(
      "src/gateway/session-reset-service.ts",
    );
  });
});
