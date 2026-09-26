// Tests get-reply import boundaries for lazy runtime and side-effect control.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import * as ts from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";
import { createNativeTypeScriptParser } from "../../../scripts/lib/native-typescript.mts";
import { createRuntimeImportGraph } from "../../../scripts/lib/runtime-import-closure.mts";

const getReplyPath = resolve(dirname(fileURLToPath(import.meta.url)), "get-reply.ts");
const lazyRuntimeSpecifiers = [
  "./session-reset-model.runtime.js",
  "./stage-sandbox-media.runtime.js",
] as const;

function readModuleImports(filePath: string) {
  const sourceText = readFileSync(filePath, "utf8");
  const parser = createNativeTypeScriptParser();
  const staticImports = new Set<string>();
  const dynamicImports = new Set<string>();

  function visit(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
      (!node.importClause?.namedBindings ||
        node.importClause.name ||
        ts.isNamespaceImport(node.importClause.namedBindings) ||
        node.importClause.namedBindings.elements.some((element) => !element.isTypeOnly))
    ) {
      staticImports.add(node.moduleSpecifier.text);
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.isTypeOnly &&
      (!node.exportClause ||
        ts.isNamespaceExport(node.exportClause) ||
        node.exportClause.elements.some((element) => !element.isTypeOnly))
    ) {
      staticImports.add(node.moduleSpecifier.text);
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const importArgument = expectDefined(node.arguments[0], "dynamic import argument");
      if (ts.isStringLiteral(importArgument)) {
        dynamicImports.add(importArgument.text);
      }
    }

    node.forEachChild(visit);
  }

  try {
    const sourceFile = parser.parseSourceFile(filePath, sourceText);
    visit(sourceFile);
    return { dynamicImports, staticImports };
  } finally {
    parser.close();
  }
}

function collectStaticImportPaths(entryPath: string): Set<string> {
  const paths = new Set([entryPath]);
  const root = resolve(dirname(getReplyPath), "../../..");
  const graph = createRuntimeImportGraph(root, [entryPath], { sourceImports: true });
  try {
    for (const filePath of paths) {
      for (const { specifier, resolvedFileName } of graph.dependencies(filePath)) {
        if (!specifier.startsWith(".")) {
          continue;
        }
        const resolved = expectDefined(resolvedFileName, `${filePath} -> ${specifier}`);
        if (!/\.d\.[cm]?ts$/.test(resolved)) {
          paths.add(resolved);
        }
      }
    }
    return paths;
  } finally {
    graph.close();
  }
}

describe("get-reply module imports", () => {
  it("keeps heavy runtime boundaries on dynamic imports", () => {
    const { dynamicImports, staticImports } = readModuleImports(getReplyPath);

    for (const specifier of lazyRuntimeSpecifiers) {
      expect(staticImports.has(specifier), `${specifier} should stay lazy`).toBe(false);
      expect(dynamicImports.has(specifier), `${specifier} should remain dynamically imported`).toBe(
        true,
      );
    }
  });

  it("keeps skill discovery and dispatch out of the inline-actions static import closure", () => {
    const skillsRoot = resolve(dirname(getReplyPath), "../../skills");
    const paths = collectStaticImportPaths(
      resolve(dirname(getReplyPath), "get-reply-inline-actions.ts"),
    );
    const eagerSkillRuntime = [...paths]
      .map((filePath) => relative(skillsRoot, filePath).replaceAll("\\", "/"))
      .filter((filePath) =>
        /^(?:loading\/|library\/|runtime\/|discovery\/(?:chat-commands|command-specs)(?:\.|\/))/.test(
          filePath,
        ),
      );

    expect(eagerSkillRuntime).toEqual([]);
  });
});
