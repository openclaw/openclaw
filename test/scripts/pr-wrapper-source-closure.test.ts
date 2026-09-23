import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const components = [
  "scripts/pr",
  "scripts/pr-lib",
  ...readFileSync("scripts/pr-lib/wrapper-components.txt", "utf8").trim().split("\n"),
];

it.each([
  "src/infra/sqlite-coordinator.ts",
  "src/plugins/discovery.ts",
  "src/infra/sqlite-readonly-location.worker.ts",
])(
  "retains %s and its relative ESM runtime dependencies in the wrapper inventory",
  (entrypoint) => {
    const root = process.cwd();
    const pending = [entrypoint];
    const visited = new Set<string>();
    const missing = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop();
      if (!file || visited.has(file)) {
        continue;
      }
      visited.add(file);
      if (!components.some((component) => file === component || file.startsWith(`${component}/`))) {
        missing.add(file);
      }
      const absolute = resolve(root, file);
      const source = ts.createSourceFile(
        file,
        readFileSync(absolute, "utf8"),
        ts.ScriptTarget.Latest,
      );
      const enqueue = (specifier: string) => {
        if (!specifier.startsWith(".")) {
          return;
        }
        const literal = resolve(dirname(absolute), specifier);
        // Explicit runtime files win over adjacent declarations selected by TypeScript.
        const target = statSync(literal, { throwIfNoEntry: false })?.isFile()
          ? literal
          : ts.resolveModuleName(
              specifier,
              absolute,
              {
                allowJs: true,
                module: ts.ModuleKind.NodeNext,
                moduleResolution: ts.ModuleResolutionKind.NodeNext,
                resolveJsonModule: true,
              },
              ts.sys,
            ).resolvedModule?.resolvedFileName;
        if (!target || /\.d\.[cm]?ts$/.test(target)) {
          throw new Error(`Cannot resolve wrapper runtime dependency ${file}: ${specifier}`);
        }
        pending.push(relative(root, target).replaceAll("\\", "/"));
      };
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const clause = node.importClause;
          const bindings = clause?.namedBindings;
          if (
            !clause ||
            (!clause.isTypeOnly &&
              (clause.name ||
                !bindings ||
                ts.isNamespaceImport(bindings) ||
                bindings.elements.some((element) => !element.isTypeOnly)))
          ) {
            enqueue(node.moduleSpecifier.text);
          }
          return;
        }
        if (ts.isExportDeclaration(node)) {
          const clause = node.exportClause;
          if (
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            !node.isTypeOnly &&
            (!clause ||
              ts.isNamespaceExport(clause) ||
              clause.elements.some((element) => !element.isTypeOnly))
          ) {
            enqueue(node.moduleSpecifier.text);
          }
          return;
        }
        if (ts.isImportTypeNode(node)) {
          return;
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteralLike(argument)) {
            enqueue(argument.text);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect([...missing].toSorted()).toEqual([]);
  },
);
