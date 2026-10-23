import { globSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { expect } from "vitest";
import type { CompactNodeTestShard } from "../../scripts/lib/ci-node-test-plan.mts";
import {
  isReleaseOnlyRuntimeTestFile,
  RELEASE_ONLY_RUNTIME_TEST_FILES,
} from "../../scripts/lib/ci-proof-test-inventory.mts";
import { parseCompactSplitTimingKey } from "../../scripts/lib/vitest-shard-metadata.mts";
import { listGitTrackedFiles, toRepoPath } from "../../src/test-utils/repo-files.js";
import { createCliVitestConfig } from "../vitest/vitest.cli.config.ts";

type VitestConfig = {
  test?: { dir?: string; exclude?: string[]; include?: string[] };
};

export function isNumberedToolingGroup(group: { shard_name: string }) {
  return /^core-tooling-\d+(?:-hosted-\d+)?$/u.test(group.shard_name);
}
export function nonToolingPlacement(plan: CompactNodeTestShard[]) {
  return plan
    .flatMap((job) => {
      const groups = job.groups
        .filter((group) => !isNumberedToolingGroup(group))
        .map((group) => group.shard_name)
        .toSorted();
      const { planConcurrency, pretestBuildMode, requiresDist, runner } = job;
      return groups.length
        ? [{ groups, planConcurrency, pretestBuildMode, requiresDist, runner }]
        : [];
    })
    .toSorted((a, b) => a.groups.join("\0").localeCompare(b.groups.join("\0")));
}

export function listTestFiles(rootDir: string): string[] {
  const gitFiles = listGitTrackedFiles({ pathspecs: rootDir });
  expect(gitFiles).not.toBeNull();
  return gitFiles!.filter((line) => line.endsWith(".test.ts"));
}

export function listMatchedTestFiles(config: VitestConfig): string[] {
  const testConfig = config.test ?? {};
  const cwd = testConfig.dir ? resolve(testConfig.dir) : process.cwd();
  const exclude = (testConfig.exclude ?? []).map((pattern) =>
    isAbsolute(pattern) ? toRepoPath(relative(cwd, pattern)) : toRepoPath(pattern),
  );
  // Prune globs during discovery; compare literal unit-fast exclusions afterward.
  const exactFiles = new Set(exclude.filter((pattern) => /^[\w/.-]+\.test\.ts$/u.test(pattern)));
  return globSync(testConfig.include ?? [], {
    cwd,
    exclude: exclude.filter((pattern) => !exactFiles.has(pattern)),
  })
    .filter((file) => !exactFiles.has(toRepoPath(relative(cwd, resolve(cwd, file)))))
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
  const beforeGroups = before.flatMap((shard) => shard.groups);
  const afterGroups = after.flatMap((shard) => shard.groups);
  const beforeFiles = beforeGroups.flatMap(groupFiles);
  const afterFiles = afterGroups.flatMap(groupFiles);
  const timingLineage = (key: string): string[] => {
    const parent = parseCompactSplitTimingKey(key)?.parentShardName;
    return [key, ...(parent ? timingLineage(parent) : [])];
  };
  const fullTimingParents = new Set(
    beforeGroups
      .flatMap((group) => timingLineage(group.timing_key ?? group.shard_name))
      .filter((parent) => !parent.startsWith("changed-")),
  );
  expect(beforeFiles.filter((file) => !afterFiles.includes(file)).toSorted()).toEqual(
    RELEASE_ONLY_RUNTIME_TEST_FILES.filter(
      // Bundled extensions retain their separate canonical extension plans.
      (file) =>
        !file.startsWith("extensions/") &&
        (compactMode === "pull-request" || !file.startsWith("test/scripts/")),
    ).toSorted(),
  );
  expect(afterFiles.filter((file) => !beforeFiles.includes(file))).toEqual([]);
  expect(afterFiles).toContain("src/config/config-startup-corpus.test.ts");
  for (const owner of reducedOwners) {
    const owns = (group: { shard_name: string }) =>
      group.shard_name === owner || group.shard_name.startsWith(`${owner}-hosted-`);
    const reduced = afterGroups.filter(owns);
    const retainedFiles = beforeGroups
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
      const full = beforeGroups.find(owns);
      expect(full, "full CLI owner").toBeDefined();
      for (const group of reduced) {
        expect(group.shard_name).toMatch(/^agentic-cli(?:-hosted-\d+)?$/u);
        expect(group.env).toEqual(full?.env);
        expect(group.fallbackMaxWorkers).toBe(full?.fallbackMaxWorkers);
        const job = after.find((shard) => shard.groups.includes(group));
        expect(job?.planConcurrency).toBe(1);
      }
    }
    for (const group of reduced) {
      expect(group.timing_key, "reduced runtime timing identity").toBeTypeOf("string");
      const lineage = timingLineage(group.timing_key!);
      for (const parent of lineage) {
        expect(fullTimingParents.has(parent), `${owner}: ${parent}`).toBe(false);
      }
      const timingOwner = lineage
        .at(-1)!
        .replace(
          /(?:#workers-4|#file-parallel-(?:2|8)|-parallel(?:-2)?(?:-native-serial)?(?:-stripes)?)$/u,
          "",
        );
      expect(timingOwner).toBe(`changed-${owner}`);
    }
  }
}
