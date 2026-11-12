import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript/ast";
import { afterAll, describe, expect, it } from "vitest";
import { createNativeTypeScriptParser } from "../../../scripts/lib/native-typescript.mts";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import {
  listGitTrackedFiles,
  toRepoPath,
  toRepoRelativePath,
} from "../../test-utils/repo-files.js";

type PluginManifestFile = {
  id?: unknown;
  contracts?: { tools?: unknown };
};
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function walkFiles(dir: string): string[] {
  return listGitFiles(
    dir,
    (line) =>
      !line
        .split("/")
        .some((part) => part === "node_modules" || part === "dist" || part.startsWith(".")),
  );
}

function listGitFiles(dir: string, include: (relativePath: string) => boolean): string[] {
  const relativeDir = toRepoRelativePath(process.cwd(), dir);
  const files = listGitTrackedFiles({ pathspecs: relativeDir });
  expect(files, "tool contract scans require a Git checkout").not.toBeNull();
  return (files ?? []).filter(include).map((line) => path.join(process.cwd(), ...line.split("/")));
}

function listPluginManifestPaths(extensionsDir: string): string[] {
  return listGitFiles(extensionsDir, (line) =>
    /^extensions\/[^/]+\/openclaw\.plugin\.json$/u.test(line),
  );
}

function isProductionSource(filePath: string): boolean {
  return (
    /\.(?:cjs|mjs|js|ts|tsx)$/.test(filePath) &&
    !/(\.test\.|\.spec\.|\/__tests__\/|\/test-support\/)/.test(toRepoPath(filePath))
  );
}

function listRegisterToolCalls(filePath: string, source: string): string[][] {
  if (!source.includes("registerTool")) {
    return [];
  }
  const sourceFile = parser.parseSourceFile(filePath, source);
  const calls: string[][] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name
        : node.expression;
      if (ts.isIdentifier(callee) && callee.text === "registerTool") {
        calls.push(
          node.arguments
            .slice(0, 2)
            .map((argument) => argument.getText(sourceFile))
            .filter((argument) => argument.startsWith("{"))
            .flatMap(extractStaticRegisteredToolNamesFromObject),
        );
      }
    }
    node.forEachChild(visit);
  }
  visit(sourceFile);
  return calls;
}

function extractStringLiterals(source: string): string[] {
  return [...source.matchAll(/["']([^"']+)["']/g)].flatMap((match) => (match[1] ? [match[1]] : []));
}

function extractStaticRegisteredToolNamesFromObject(source: string): string[] {
  return [
    ...new Set([
      ...[...source.matchAll(/\bnames\s*:\s*\[([\s\S]*?)\]/g)].flatMap((match) =>
        extractStringLiterals(match[1] ?? ""),
      ),
      ...[...source.matchAll(/\bname\s*:\s*["']([^"']+)["']/g)].flatMap((match) =>
        match[1] ? [match[1]] : [],
      ),
    ]),
  ];
}

function normalizeManifestTools(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

describe("bundled plugin tool manifest contracts", () => {
  it("lists plugin tool contract inputs from git without walking extension roots", () => {
    const extensionsDir = path.join(process.cwd(), "extensions");
    expectNoReaddirSyncDuring(() => {
      const manifestPaths = listPluginManifestPaths(extensionsDir);
      const sourceFiles = manifestPaths[0]
        ? walkFiles(path.dirname(manifestPaths[0])).filter(isProductionSource)
        : [];

      expect(manifestPaths.length).toBeGreaterThan(0);
      expect(sourceFiles.length).toBeGreaterThan(0);
    });
  });

  it("declares every production registerTool owner in contracts.tools", () => {
    expect(collectToolContractFailures(path.join(process.cwd(), "extensions"))).toStrictEqual([]);
  });
});

function collectToolContractFailures(extensionsDir: string): string[] {
  const failures: string[] = [];

  for (const manifestPath of listPluginManifestPaths(extensionsDir)) {
    const pluginDir = path.dirname(manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as PluginManifestFile;
    const pluginId = typeof manifest.id === "string" ? manifest.id : path.basename(pluginDir);
    const declaredTools = new Set(normalizeManifestTools(manifest.contracts?.tools));
    const calls = walkFiles(pluginDir)
      .filter(isProductionSource)
      .flatMap((filePath) => listRegisterToolCalls(filePath, fs.readFileSync(filePath, "utf-8")));
    if (calls.length === 0) {
      continue;
    }
    if (declaredTools.size === 0) {
      failures.push(`${pluginId}: registers agent tools but has no contracts.tools`);
      continue;
    }

    const missing = [...new Set(calls.flat())]
      .filter((name) => !declaredTools.has(name))
      .toSorted();
    if (missing.length > 0) {
      failures.push(`${pluginId}: missing contracts.tools for ${missing.join(", ")}`);
    }
  }

  return failures;
}
