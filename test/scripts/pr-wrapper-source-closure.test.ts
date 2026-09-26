import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import { expect, it } from "vitest";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const components = [
  "scripts/pr",
  "scripts/pr-lib",
  ...readFileSync("scripts/pr-lib/wrapper-components.txt", "utf8").trim().split("\n"),
];

it.each([
  "src/infra/gateway-state-owner.ts",
  "src/plugins/discovery.ts",
  "src/infra/sqlite-readonly-location.worker.ts",
])(
  "retains %s and its relative ESM runtime dependencies in the wrapper inventory",
  (entrypoint) => {
    const root = process.cwd();
    const pending = [entrypoint];
    const visited = new Set<string>();
    const missing = new Set<string>();
    const parser = createNativeTypeScriptParser({ cwd: root });
    try {
      while (pending.length > 0) {
        const file = pending.pop();
        if (!file || visited.has(file)) {
          continue;
        }
        visited.add(file);
        if (
          !components.some((component) => file === component || file.startsWith(`${component}/`))
        ) {
          missing.add(file);
        }
        const absolute = resolve(root, file);
        const source = parser.parseSourceFile(file, readFileSync(absolute, "utf8"));
        const enqueue = (specifier: string) => {
          if (!specifier.startsWith(".")) {
            return;
          }
          const literal = resolve(dirname(absolute), specifier);
          // Explicit runtime files win over adjacent declarations selected by TypeScript.
          const target = [literal, literal.replace(/\.([cm]?)js$/, ".$1ts")].find((candidate) =>
            statSync(candidate, { throwIfNoEntry: false })?.isFile(),
          );
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
              (clause.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
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
            if (argument && ts.isStringLiteralLikeNode(argument)) {
              enqueue(argument.text);
            }
          }
          node.forEachChild(visit);
        };
        visit(source);
      }
    } finally {
      parser.close();
    }
    expect([...missing].toSorted()).toEqual([]);
  },
);
