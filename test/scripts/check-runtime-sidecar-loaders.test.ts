import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import * as ts from "typescript/ast";
import { afterAll, expect, it } from "vitest";
import {
  collectTsdownEntrySources,
  findRuntimeSidecarLoaderViolations,
} from "../../scripts/check-runtime-sidecar-loaders.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function check(source: string, entries: string[] = []) {
  const file = "src/example/example-registry.ts";
  const ast = parser.parseSourceFile(file, source);
  return expect(findRuntimeSidecarLoaderViolations(source, file, new Set(entries), ast));
}

function collectRuntimeStaticGraph(sourcePath: string, visited = new Set<string>()): Set<string> {
  if (visited.has(sourcePath)) {
    return visited;
  }
  visited.add(sourcePath);
  const source = parser.parseSourceFile(sourcePath, readFileSync(sourcePath, "utf8"));
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) {
      continue;
    }
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) {
      continue;
    }
    const typeOnly = ts.isImportDeclaration(statement)
      ? statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
      : statement.isTypeOnly ||
        (statement.exportClause &&
          ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.every((element) => element.isTypeOnly));
    if (typeOnly || !specifier.text.startsWith(".")) {
      continue;
    }
    const resolved = resolve(dirname(sourcePath), specifier.text);
    const target = [resolved, resolved.replace(/\.js$/, ".ts"), resolve(resolved, "index.ts")].find(
      existsSync,
    );
    if (target) {
      collectRuntimeStaticGraph(target, visited);
    }
  }
  return visited;
}

it("keeps the memory runtime facade out of the manager sidecar graph", () => {
  const sourcePath = new URL("../../extensions/memory-core/runtime-api.ts", import.meta.url);
  const runtimeGraph = [...collectRuntimeStaticGraph(sourcePath.pathname)].map((filePath) =>
    relative(resolve(dirname(sourcePath.pathname), "../.."), filePath),
  );

  // Shared shadow identity helpers have no manager imports or startup effects.
  const sharedShadowTask = "extensions/memory-core/src/memory/manager-shadow-task.ts";
  expect(
    runtimeGraph.filter(
      (filePath) => filePath !== sharedShadowTask && /(^|\/)manager(?:-|\.)/.test(filePath),
    ),
  ).toEqual([]);
});

it("allows hidden createRequire runtime sidecars when the source is an explicit build entry", () => {
  check(
    `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      export function loadRuntime() {
        return require("./example-control.runtime.js");
      }
    `,
    ["src/example/example-control.runtime.ts"],
  ).toStrictEqual([]);
});

it("resolves candidate arrays used by source/build fallback loops", () => {
  check(`
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      const CANDIDATES = ["./control.runtime.js", "./control.runtime.ts"] as const;
      export function loadRuntime() {
        for (const candidate of CANDIDATES) {
          return require(candidate);
        }
      }
    `).toEqual([
    {
      line: 7,
      specifier: "./control.runtime.js",
      sourcePath: "src/example/control.runtime.ts",
      reason:
        'hidden local runtime loader "./control.runtime.js" resolves to src/example/control.runtime.ts, but that source is not an explicit tsdown entry',
    },
  ]);
});

it("ignores bundler-visible dynamic imports", () => {
  check(`
      let runtimePromise: Promise<typeof import("./control.runtime.js")> | undefined;
      export function loadRuntime() {
        runtimePromise ??= import("./control.runtime.js");
        return runtimePromise;
      }
    `).toStrictEqual([]);
});

it("collects explicit tsdown entry sources", () => {
  const entry = {
    index: "src/index.ts",
    "example-control.runtime": "src/example/example-control.runtime.ts",
  };
  expect(collectTsdownEntrySources([{ entry }])).toEqual(
    new Set(["src/index.ts", "src/example/example-control.runtime.ts"]),
  );
});
