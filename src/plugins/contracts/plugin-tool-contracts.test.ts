// Plugin tool contract tests cover bundled plugin tool schemas and invocation contracts.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
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

function walkFiles(dir: string): string[] {
  const gitFiles = listGitFiles(dir);
  if (gitFiles) {
    return gitFiles;
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    files.push(...(entry.isDirectory() ? walkFiles(entryPath) : [entryPath]));
  }
  return files;
}

function isSkippedRepoPath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some((part) => part === "node_modules" || part === "dist" || part.startsWith("."));
}

function listGitFiles(
  dir: string,
  include: (relativePath: string) => boolean = (line) => !isSkippedRepoPath(line),
): string[] | null {
  const relativeDir = toRepoRelativePath(process.cwd(), dir);
  if (!relativeDir || relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
    return null;
  }
  const files = listGitTrackedFiles({ pathspecs: relativeDir });
  if (!files) {
    return null;
  }
  return files
    .filter(include)
    .map((line) => path.join(process.cwd(), ...line.split("/")))
    .filter((filePath) => fs.existsSync(filePath))
    .toSorted();
}

function listPluginManifestPaths(extensionsDir: string): string[] {
  const gitPaths = listGitFiles(extensionsDir, (line) =>
    /^extensions\/[^/]+\/openclaw\.plugin\.json$/u.test(line),
  );
  if (gitPaths) {
    return gitPaths;
  }

  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(extensionsDir, entry.name, "openclaw.plugin.json"))
    .filter((manifestPath) => fs.existsSync(manifestPath));
}

function isProductionSource(filePath: string): boolean {
  if (!/\.(?:cjs|mjs|js|ts|tsx)$/.test(filePath)) {
    return false;
  }
  const normalized = toRepoPath(filePath);
  return !/(\.test\.|\.spec\.|\/__tests__\/|\/test-support\/)/.test(normalized);
}

function* topLevelTokens(source: string, start = 0): Generator<[string, number]> {
  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (!char) {
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
    }
    if (depth === 0 && (char === ")" || char === ",")) {
      yield [char, index];
    }
  }
}

function readBalancedCallArguments(source: string, openParenIndex: number): string | undefined {
  for (const [char, index] of topLevelTokens(source, openParenIndex)) {
    if (char === ")") {
      return source.slice(openParenIndex + 1, index);
    }
  }
  return undefined;
}

function listRegisterToolCalls(source: string): string[] {
  const calls: string[] = [];
  const pattern = /\bregisterTool\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const openParenIndex = source.indexOf("(", match.index);
    const args = readBalancedCallArguments(source, openParenIndex);
    if (args !== undefined) {
      calls.push(args);
    }
  }
  return calls;
}

function splitTopLevelArgs(args: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const [char, index] of topLevelTokens(args)) {
    if (char === ",") {
      parts.push(args.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(args.slice(start).trim());
  return parts.filter(Boolean);
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

function extractStaticRegisteredToolNames(callArgs: string): string[] {
  return [
    ...new Set(
      splitTopLevelArgs(callArgs)
        .slice(0, 2)
        .filter((arg) => arg.startsWith("{"))
        .flatMap(extractStaticRegisteredToolNamesFromObject),
    ),
  ];
}

function normalizeManifestTools(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

describe("bundled plugin tool manifest contracts", () => {
  let toolContractFailures: string[] = [];

  beforeAll(() => {
    listGitTrackedFiles({ pathspecs: "extensions" });
    toolContractFailures = collectToolContractFailures(path.join(process.cwd(), "extensions"));
  });

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
    expect(toolContractFailures).toStrictEqual([]);
  });
});

function collectToolContractFailures(extensionsDir: string): string[] {
  const failures: string[] = [];

  for (const manifestPath of listPluginManifestPaths(extensionsDir)) {
    const pluginDir = path.dirname(manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as PluginManifestFile;
    const pluginId = typeof manifest.id === "string" ? manifest.id : path.basename(pluginDir);
    const declaredTools = new Set(normalizeManifestTools(manifest.contracts?.tools));
    const registeredNames = new Set<string>();
    let registerCallCount = 0;

    for (const filePath of walkFiles(pluginDir).filter(isProductionSource)) {
      const source = fs.readFileSync(filePath, "utf-8");
      for (const call of listRegisterToolCalls(source)) {
        registerCallCount += 1;
        for (const name of extractStaticRegisteredToolNames(call)) {
          registeredNames.add(name);
        }
      }
    }

    if (registerCallCount === 0) {
      continue;
    }
    if (declaredTools.size === 0) {
      failures.push(`${pluginId}: registers agent tools but has no contracts.tools`);
      continue;
    }

    const missing = [...registeredNames].filter((name) => !declaredTools.has(name)).toSorted();
    if (missing.length > 0) {
      failures.push(`${pluginId}: missing contracts.tools for ${missing.join(", ")}`);
    }
  }

  return failures;
}
