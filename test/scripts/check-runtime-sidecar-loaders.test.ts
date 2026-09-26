// Check Runtime Sidecar Loaders tests cover check runtime sidecar loaders script behavior.
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectTsdownEntrySources,
  findRuntimeSidecarLoaderViolations,
} from "../../scripts/check-runtime-sidecar-loaders.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function listRuntimeStaticSpecifiers(sourcePath: string): string[] {
  const source = readFileSync(sourcePath, "utf8");
  const sourceFile = parser.parseSourceFile(sourcePath, source);
  return sourceFile.statements.flatMap((statement) => {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword
    ) {
      return [statement.moduleSpecifier.text];
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      !statement.isTypeOnly &&
      !(
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.every((element) => element.isTypeOnly)
      )
    ) {
      return [statement.moduleSpecifier.text];
    }
    return [];
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

    expect(runtimeGraph.filter((filePath) => /(^|\/)manager(?:-|\.)/.test(filePath))).toEqual([]);
  });

  it("flags hidden createRequire runtime sidecars that are not build entries", () => {
    const source = `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      export function loadRuntime() {
        return require("./missing.runtime.js");
      }
    `;

    expect(
      findRuntimeSidecarLoaderViolations(
        source,
        "src/example/example-registry.ts",
        new Set(),
        parser.parseSourceFile("src/example/example-registry.ts", source),
      ),
    ).toEqual([
      {
        line: 5,
        specifier: "./missing.runtime.js",
        sourcePath: "src/example/missing.runtime.ts",
        reason:
          'hidden local runtime loader "./missing.runtime.js" resolves to src/example/missing.runtime.ts, but that source is not an explicit tsdown entry',
      },
    ]);
  });

  it("allows hidden createRequire runtime sidecars when the source is an explicit build entry", () => {
    const source = `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      export function loadRuntime() {
        return require("./example-control.runtime.js");
      }
    `;

    expect(
      findRuntimeSidecarLoaderViolations(
        source,
        "src/example/example-registry.ts",
        new Set(["src/example/example-control.runtime.ts"]),
        parser.parseSourceFile("src/example/example-registry.ts", source),
      ),
    ).toStrictEqual([]);
  });

  it("resolves candidate arrays used by source/build fallback loops", () => {
    const source = `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      const CANDIDATES = ["./control.runtime.js", "./control.runtime.ts"] as const;
      export function loadRuntime() {
        for (const candidate of CANDIDATES) {
          return require(candidate);
        }
      }
    `;

    expect(
      findRuntimeSidecarLoaderViolations(
        source,
        "src/example/example-registry.ts",
        new Set(),
        parser.parseSourceFile("src/example/example-registry.ts", source),
      ),
    ).toEqual([
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
    const source = `
      let runtimePromise: Promise<typeof import("./control.runtime.js")> | undefined;
      export function loadRuntime() {
        runtimePromise ??= import("./control.runtime.js");
        return runtimePromise;
      }
    `;

    expect(
      findRuntimeSidecarLoaderViolations(
        source,
        "src/example/example-registry.ts",
        new Set(),
        parser.parseSourceFile("src/example/example-registry.ts", source),
      ),
    ).toStrictEqual([]);
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
