import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import * as ts from "typescript/ast";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectTsdownEntrySources,
  findRuntimeSidecarLoaderViolations,
} from "../../scripts/check-runtime-sidecar-loaders.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function check(source: string, entries: string[] = []) {
  const file = "src/example/example-registry.ts";
  return expect(
    findRuntimeSidecarLoaderViolations(
      source,
      file,
      new Set(entries),
      parser.parseSourceFile(file, source),
    ),
  );
}

function listRuntimeStaticSpecifiers(sourcePath: string): string[] {
  const source = readFileSync(sourcePath, "utf8");
  const sourceFile = parser.parseSourceFile(sourcePath, source);
  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) {
      return [];
    }
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) {
      return [];
    }
    const typeOnly = ts.isImportDeclaration(statement)
      ? statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
      : statement.isTypeOnly ||
        (statement.exportClause &&
          ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.every((element) => element.isTypeOnly));
    return typeOnly ? [] : [specifier.text];
  });
}

function resolveLocalSource(importerPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const resolved = resolve(dirname(importerPath), specifier);
  const candidates = [resolved, resolved.replace(/\.js$/, ".ts"), resolve(resolved, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function collectRuntimeStaticGraph(entryPath: string): Set<string> {
  const pending = [entryPath];
  const visited = new Set<string>();
  for (const sourcePath of pending) {
    if (visited.has(sourcePath)) {
      continue;
    }
    visited.add(sourcePath);
    for (const specifier of listRuntimeStaticSpecifiers(sourcePath)) {
      const resolved = resolveLocalSource(sourcePath, specifier);
      if (resolved && !visited.has(resolved)) {
        pending.push(resolved);
      }
    }
  }
  return visited;
}

describe("check-runtime-sidecar-loaders", () => {
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
    expect(
      collectTsdownEntrySources([
        {
          entry: {
            index: "src/index.ts",
            "example-control.runtime": "src/example/example-control.runtime.ts",
          },
        },
      ]),
    ).toEqual(new Set(["src/index.ts", "src/example/example-control.runtime.ts"]));
  });
});
