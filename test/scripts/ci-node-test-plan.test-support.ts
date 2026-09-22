import { existsSync, globSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expect } from "vitest";
import { listGitTrackedFiles, sortRepoPaths, toRepoPath } from "../../src/test-utils/repo-files.js";

type VitestTestConfig = {
  dir?: string;
  exclude?: string[];
  include?: string[];
};

type VitestConfig = {
  test?: VitestTestConfig;
};

export function listTestFiles(rootDir: string): string[] {
  const gitFiles = listGitTrackedFiles({ pathspecs: rootDir });
  expect(gitFiles).not.toBeNull();
  if (gitFiles) {
    return gitFiles.filter((line) => line.endsWith(".test.ts"));
  }

  if (!existsSync(rootDir)) {
    return [];
  }

  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        files.push(toRepoPath(path));
      }
    }
  };

  visit(rootDir);
  return sortRepoPaths(files);
}

export function listMatchedTestFiles(config: VitestConfig): string[] {
  const testConfig = config.test ?? {};
  const cwd = testConfig.dir ? resolve(testConfig.dir) : process.cwd();
  const exclude = (testConfig.exclude ?? []).map((pattern) =>
    isAbsolute(pattern) ? toRepoPath(relative(cwd, pattern)) : toRepoPath(pattern),
  );
  return globSync(testConfig.include ?? [], {
    cwd,
    exclude,
  })
    .map((file) => toRepoPath(relative(process.cwd(), resolve(cwd, file))))
    .toSorted((a, b) => a.localeCompare(b));
}
