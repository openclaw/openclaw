import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import {
  listGitTrackedFiles,
  toRepoPath,
  toRepoRelativePath,
} from "../../test-utils/repo-files.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const extensionsRoot = path.join(repoRoot, "extensions");

function isProductionSourcePath(filePath: string): boolean {
  const normalized = toRepoPath(filePath);
  return (
    /\.(?:ts|tsx|js|mjs|cjs)$/.test(normalized) &&
    !/(^|\/)(?:node_modules|dist|\.[^/]+)(?:\/|$)/.test(normalized) &&
    !/(\.test\.|\.spec\.|\/__tests__\/|\/test-support\/)/.test(normalized)
  );
}

function walkProductionSourceFiles(dir: string): string[] {
  const relativeRoot = toRepoRelativePath(repoRoot, dir);
  const gitFiles =
    relativeRoot && !relativeRoot.startsWith("..") && !path.isAbsolute(relativeRoot)
      ? listGitTrackedFiles({ repoRoot, pathspecs: relativeRoot })
      : null;
  if (gitFiles) {
    return gitFiles
      .filter(isProductionSourcePath)
      .map((line) => path.join(repoRoot, ...line.split("/")))
      .filter((filePath) => fs.existsSync(filePath))
      .toSorted();
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkProductionSourceFiles(entryPath));
      continue;
    }
    if (isProductionSourcePath(entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}

function readBalancedBlock(source: string, openIndex: number): string | undefined {
  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  // The caller's pattern always ends at an opening parenthesis or brace.
  const closer = source[openIndex] === "(" ? ")" : "}";

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
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
      if (depth === 0 && char === closer) {
        return source.slice(openIndex + 1, index);
      }
    }
  }
  return undefined;
}

function listProviderPluginObjects(source: string): string[] {
  const objects: string[] = [];
  const pattern = /\bregisterProvider\s*\(|:\s*[A-Za-z0-9_]*ProviderPlugin\s*=\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    const object = readBalancedBlock(source, match.index + match[0].length - 1);
    if (object !== undefined) {
      objects.push(object);
    }
  }
  return objects;
}

describe("bundled provider catalog deprecation guard", () => {
  it("lists production extension sources from git without walking extension roots", () => {
    expectNoReaddirSyncDuring(() => {
      const files = walkProductionSourceFiles(extensionsRoot);

      expect(files.length).toBeGreaterThan(0);
      expect(files.every((file) => path.relative(repoRoot, file).startsWith("extensions"))).toBe(
        true,
      );
      expect(files.some((file) => file.endsWith(".test.ts"))).toBe(false);
    });
  });

  it("keeps bundled provider plugins off the deprecated discovery hook", () => {
    const offenders: string[] = [];
    for (const filePath of walkProductionSourceFiles(extensionsRoot)) {
      const source = fs.readFileSync(filePath, "utf8");
      for (const candidate of listProviderPluginObjects(source)) {
        const match = /\bdiscovery\s*:/.exec(candidate);
        if (!match) {
          continue;
        }
        const absoluteOffset = source.indexOf(candidate) + match.index;
        offenders.push(
          `${path.relative(repoRoot, filePath)}:${source.slice(0, absoluteOffset).split("\n").length}`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });
});
