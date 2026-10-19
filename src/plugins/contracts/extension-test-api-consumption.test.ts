import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/ast";
import { afterAll, describe, expect, it } from "vitest";
import { collectModuleReferencesFromSource } from "../../../scripts/lib/guard-inventory-utils.mjs";
import { createNativeTypeScriptParser } from "../../../scripts/lib/native-typescript.mts";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const THIS_TEST_FILE = "src/plugins/contracts/extension-test-api-consumption.test.ts";
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function listTrackedFiles(pathspecs: string | readonly string[]): string[] {
  const files = listGitTrackedFiles({ pathspecs, repoRoot: REPO_ROOT });
  if (!files) {
    throw new Error(`failed to list tracked files for ${JSON.stringify(pathspecs)}`);
  }
  return files;
}

function stripModuleExtension(value: string): string {
  return value.replace(/\.(?:[cm]?[jt]sx?)$/u, "");
}

function listExtensionTestApis() {
  return listTrackedFiles("extensions/*/test-api.ts").map((repoPath) => {
    const pluginId = repoPath.split("/")[1];
    if (!pluginId) {
      throw new Error(`invalid extension test API path: ${repoPath}`);
    }
    const parsed = JSON.parse(
      fs.readFileSync(resolve(REPO_ROOT, "extensions", pluginId, "package.json"), "utf8"),
    ) as {
      exports?: Record<string, unknown>;
      name?: unknown;
    };
    return {
      absoluteStem: stripModuleExtension(resolve(REPO_ROOT, repoPath)),
      packageName: typeof parsed.name === "string" ? parsed.name : undefined,
      packageExportsTestApi: Object.keys(parsed.exports ?? {}).some(
        (key) => stripModuleExtension(key) === "./test-api",
      ),
      pluginId,
      repoPath,
    };
  });
}

function objectStringProperty(node: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const property of node.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteralLikeNode(property.name)) &&
      property.name.text === name &&
      ts.isStringLiteralLikeNode(property.initializer)
    ) {
      return property.initializer.text;
    }
  }
  return undefined;
}

function collectReferences(source: ts.SourceFile | string) {
  const sourceFile =
    typeof source === "string" ? parser.parseSourceFile("source.ts", source) : source;
  const moduleSpecifiers = collectModuleReferencesFromSource(sourceFile)
    .filter((entry) => entry.kind !== "import-meta-url")
    .map((entry) => entry.specifier)
    .toSorted();
  const pluginIds = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name
        : node.expression;
      const pluginId = node.arguments[0];
      if (
        ts.isIdentifier(callee) &&
        callee.text === "loadQaRunnerBundledPluginTestApi" &&
        pluginId &&
        ts.isStringLiteralLikeNode(pluginId)
      ) {
        pluginIds.add(pluginId.text);
      }
    } else if (ts.isObjectLiteralExpression(node)) {
      const pluginId = objectStringProperty(node, "pluginId");
      if (pluginId && objectStringProperty(node, "artifactBasename") === "test-api.js") {
        pluginIds.add(pluginId);
      }
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
  return { moduleSpecifiers, pluginIds: [...pluginIds].toSorted() };
}

function resolveTestApiPluginId(
  specifier: string,
  importerFile: string,
  testApis: Readonly<ReturnType<typeof listExtensionTestApis>>,
): string | undefined {
  const relative = specifier.startsWith(".") || specifier.startsWith("/");
  const stem = stripModuleExtension(
    relative ? resolve(dirname(importerFile), specifier) : specifier,
  );
  return testApis.find((testApi) =>
    relative
      ? testApi.absoluteStem === stem
      : testApi.packageName && `${testApi.packageName}/test-api` === stem,
  )?.pluginId;
}

function orphanTestApis(): string[] {
  const testApis = listExtensionTestApis();
  const consumed = new Set(
    testApis.filter((testApi) => testApi.packageExportsTestApi).map((testApi) => testApi.pluginId),
  );
  const testApiFiles = new Set(testApis.map((testApi) => testApi.repoPath));
  const pendingSources: Array<{ fileName: string; text: string }> = [];

  function consumePendingSources(): void {
    if (pendingSources.length === 0) {
      return;
    }
    for (const sourceFile of parser.parseSourceFiles(pendingSources.splice(0))) {
      const references = collectReferences(sourceFile);
      const pluginIds = [
        ...references.pluginIds,
        ...references.moduleSpecifiers.map((specifier) =>
          resolveTestApiPluginId(specifier, sourceFile.fileName, testApis),
        ),
      ];
      for (const pluginId of pluginIds) {
        if (pluginId && testApis.some((testApi) => testApi.pluginId === pluginId)) {
          consumed.add(pluginId);
        }
      }
    }
  }

  for (const repoPath of listTrackedFiles(["src", "test", "extensions", "packages", "scripts"])) {
    if (
      repoPath === THIS_TEST_FILE ||
      testApiFiles.has(repoPath) ||
      !/\.(?:[cm]?[jt]sx?)$/u.test(repoPath)
    ) {
      continue;
    }
    const absolutePath = resolve(REPO_ROOT, repoPath);
    let source: string;
    try {
      source = fs.readFileSync(absolutePath, "utf8");
    } catch (error) {
      // Preserve earlier parse failures before reporting a later unreadable file.
      consumePendingSources();
      throw error;
    }
    if (!source.includes("test-api") && !source.includes("loadQaRunnerBundledPluginTestApi")) {
      continue;
    }
    pendingSources.push({ fileName: absolutePath, text: source });
    if (pendingSources.length === 32) {
      consumePendingSources();
    }
  }
  consumePendingSources();

  return testApis
    .filter((testApi) => !consumed.has(testApi.pluginId))
    .map((testApi) => testApi.repoPath)
    .toSorted();
}

describe("extension test API consumption", () => {
  it("ignores identifier text and generic loader implementations", () => {
    expect(
      collectReferences(`
        const testing = {};
        function loadQaRunnerBundledPluginTestApi(pluginId: string) {
          return load({ pluginId, artifactBasename: "test-api.js" });
        }
      `),
    ).toStrictEqual({ moduleSpecifiers: [], pluginIds: [] });
  });

  it("collects real module edges and literal plugin loaders", () => {
    expect(
      collectReferences(`
        import { testing } from "@openclaw/example/test-api.js";
        export { helper } from "../test-api.js";
        type TestApi = typeof import("./test-api.js");
        loadQaRunnerBundledPluginTestApi("matrix");
        loadBundledPluginFacade({ pluginId: "codex", artifactBasename: "test-api.js" });
      `),
    ).toStrictEqual({
      moduleSpecifiers: ["../test-api.js", "./test-api.js", "@openclaw/example/test-api.js"],
      pluginIds: ["codex", "matrix"],
    });
  });

  it(
    "keeps only consumed extension test APIs",
    () => expect(orphanTestApis()).toStrictEqual([]),
    240_000,
  );
});
