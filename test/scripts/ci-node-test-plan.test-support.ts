import { existsSync, globSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expect } from "vitest";
import type { CompactNodeTestShard } from "../../scripts/lib/ci-node-test-plan.mts";
import {
  isReleaseOnlyRuntimeTestFile,
  RELEASE_ONLY_RUNTIME_TEST_FILES,
} from "../../scripts/lib/ci-proof-test-inventory.mts";
import { parseCompactSplitTimingKey } from "../../scripts/lib/vitest-shard-metadata.mts";
import { listGitTrackedFiles, sortRepoPaths, toRepoPath } from "../../src/test-utils/repo-files.js";
import { createCliVitestConfig } from "../vitest/vitest.cli.config.ts";

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

export function expectRuntimeReleaseInventory({
  before,
  after,
  reducedOwners,
  compactMode,
}: {
  before: CompactNodeTestShard[];
  after: CompactNodeTestShard[];
  reducedOwners: string[];
  compactMode: "push" | "pull-request";
}) {
  const cliFiles = listMatchedTestFiles(createCliVitestConfig({}));
  const groupFiles = (group: CompactNodeTestShard["groups"][number]) =>
    group.includePatterns ?? (group.shard_name === "agentic-cli" ? cliFiles : []);
  const files = (plan: CompactNodeTestShard[]) =>
    plan.flatMap((shard) => shard.groups.flatMap(groupFiles));
  const beforeFiles = files(before);
  const afterFiles = files(after);
  const fullTimingParents = new Set(
    before
      .flatMap((shard) =>
        shard.groups.map((group) => {
          const key = group.timing_key ?? group.shard_name;
          return parseCompactSplitTimingKey(key)?.parentShardName ?? key;
        }),
      )
      // The comparison plan can already omit tooling from mixed owners.
      .filter((parent) => !parent.startsWith("changed-")),
  );
  expect(beforeFiles.filter((file) => !afterFiles.includes(file)).toSorted()).toEqual(
    RELEASE_ONLY_RUNTIME_TEST_FILES.filter(
      (file) => compactMode === "pull-request" || !file.startsWith("test/scripts/"),
    ).toSorted(),
  );
  expect(afterFiles.filter((file) => !beforeFiles.includes(file))).toEqual([]);
  expect(afterFiles).toContain("src/config/config-startup-corpus.test.ts");
  for (const owner of reducedOwners) {
    const owns = (group: { shard_name: string }) =>
      group.shard_name === owner || group.shard_name.startsWith(`${owner}-hosted-`);
    const reduced = after.flatMap((shard) => shard.groups).filter(owns);
    const retainedFiles = before
      .flatMap((shard) => shard.groups)
      .filter(owns)
      .flatMap(groupFiles)
      .filter((file) => !isReleaseOnlyRuntimeTestFile(file));
    expect(reduced.flatMap((group) => group.includePatterns ?? []).toSorted(), owner).toEqual(
      retainedFiles.toSorted(),
    );
    if (retainedFiles.length === 0) {
      expect(reduced, owner).toEqual([]);
    }
    if (owner === "agentic-cli") {
      expect(reduced).toHaveLength(1);
      const full = before.flatMap((shard) => shard.groups).find(owns);
      expect(full, "full CLI owner").toBeDefined();
      expect(reduced[0]!.shard_name).toBe(owner);
      expect(reduced[0]!.env).toEqual(full?.env);
      expect(reduced[0]!.fallbackMaxWorkers).toBe(full?.fallbackMaxWorkers);
      const job = after.find((shard) => shard.groups.includes(reduced[0]!));
      expect(job?.planConcurrency).toBe(1);
    }
    for (const group of reduced) {
      expect(group.timing_key, "reduced runtime timing identity").toBeTypeOf("string");
      const timingKey = group.timing_key!;
      const timingParent = parseCompactSplitTimingKey(timingKey)?.parentShardName ?? timingKey;
      expect(fullTimingParents.has(timingParent), `${owner}: ${timingParent}`).toBe(false);
      expect(
        timingParent.replace(
          /(?:#file-parallel-(?:2|8)|-parallel(?:-2)?(?:-native-serial)?(?:-stripes)?)$/u,
          "",
        ),
      ).toBe(`changed-${owner}`);
    }
  }
}
