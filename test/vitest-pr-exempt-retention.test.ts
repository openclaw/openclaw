import { execFileSync } from "node:child_process";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  createNodeTestShardBundles,
  createUiTestShardGroups,
  resolveCanonicalNodeTestConfig,
} from "../scripts/lib/ci-node-test-plan.mts";
import {
  listPrExemptRuntimeTestFiles,
  RELEASE_ONLY_UI_TEST_FILES,
} from "../scripts/lib/ci-proof-test-inventory.mts";
import {
  createExtensionTestShards,
  DEFAULT_EXTENSION_TEST_SHARD_COUNT,
} from "../scripts/lib/extension-test-plan.mts";
import { buildVitestRunPlans } from "../scripts/test-projects.test-support.mts";
import { createNodeEvalArgs } from "../src/test-utils/node-process.js";
import { isUiTestTarget } from "./vitest/vitest.ui-paths.mjs";

type PlannedTestOwner = {
  configs: readonly string[];
  includePatterns?: readonly string[];
};
type UiOwners = Record<"ui" | "e2e", Array<{ includePatterns: string[] }>>;
const uiConfig = "ui/vitest.config.ts";
const browserConfig = "test/vitest/vitest.ui-browser.config.ts";
const e2eConfig = "test/vitest/vitest.ui-e2e.config.ts";

function expectUiOwnerCount(owners: UiOwners, file: string, count: number) {
  const kind = isUiTestTarget(file) ? "ui" : "e2e";
  expect(
    owners[kind].filter((group) => group.includePatterns.includes(file)),
    file,
  ).toHaveLength(count);
}

function fallbackGroups(shards: ReturnType<typeof createNodeTestShardBundles>) {
  return shards.flatMap((shard) => shard.groups ?? [{ ...shard, shard_name: shard.shardName }]);
}

function createPrExemptCensus() {
  const prExemptFiles = listPrExemptRuntimeTestFiles();
  expect(prExemptFiles.length).toBeGreaterThan(0);
  const extensionGroups = createExtensionTestShards({
    shardCount: DEFAULT_EXTENSION_TEST_SHARD_COUNT,
  }).flatMap((shard) => shard.planGroups);
  const configs = [
    ...new Set([
      ...extensionGroups.map((group) => group.config),
      uiConfig,
      browserConfig,
      e2eConfig,
    ]),
  ];
  // Discover in the same Node context as the prerelease planner, without the
  // parent Vitest invocation's file filter or transformed config module graph.
  const discovery = execFileSync(
    process.execPath,
    createNodeEvalArgs(
      `
      import { globSync } from "node:fs";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const projects = {};
      for (const config of ${JSON.stringify(configs)}) {
        const module = await import(pathToFileURL(path.resolve(config)).href);
        const root = config === "test/vitest/vitest.ui-e2e.config.ts"
          ? module.createUiE2eVitestConfig({ ...process.env, OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "0" }, [])
          : module.default;
        projects[config] = (root.test.projects ?? [root]).map(project => {
          if (!project || typeof project !== "object" || !project.test) {
            throw new Error("Unsupported inline test project in " + config);
          }
          const test = project.test;
          const cwd = test.dir ?? test.root ?? project.root ?? root.test.dir ?? root.test.root ?? root.root ?? process.cwd();
          const exclude = (test.exclude ?? []).map(pattern => path.isAbsolute(pattern) ? path.relative(cwd, pattern).split(path.sep).join("/") : pattern);
          return {
            name: test.name,
            files: globSync(test.include ?? [], { cwd, exclude }).map(file => path.relative(process.cwd(), path.resolve(cwd, file)).split(path.sep).join("/")),
          };
        });
      }
      process.stdout.write(JSON.stringify(projects));
    `,
      { imports: ["./scripts/tsx.mjs"] },
    ),
    {
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_VITEST_INCLUDE_FILE: undefined },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const discovered: Record<string, Array<{ name: string; files: string[] }>> = JSON.parse(
    discovery,
  );
  const projectsFor = (config: string) => expectDefined(discovered[config], config);
  const filesFor = (config: string) => [
    ...new Set(projectsFor(config).flatMap((project) => project.files)),
  ];
  const retainedExtensionGroups = extensionGroups.map((group) => ({
    configs: [group.config],
    includePatterns: filesFor(group.config).filter((file) =>
      group.roots.some((root) => file === root || file.startsWith(`${root}/`)),
    ),
  }));
  const uiProjects = projectsFor(uiConfig);
  const browserFiles = filesFor(browserConfig);
  expect(uiProjects.find((project) => project.name === "browser")?.files.toSorted()).toEqual(
    browserFiles.toSorted(),
  );
  const dedicatedGroups = (plan: ReturnType<typeof createUiTestShardGroups>) => {
    const select = (files: string[], groups: typeof plan.ui) =>
      files.filter((file) =>
        groups.some((group) => !group.includePatterns || group.includePatterns.includes(file)),
      );
    const projectGroups = (config: string, groups: typeof plan.ui) =>
      projectsFor(config).map((project) => ({
        configs: [config],
        includePatterns: select(project.files, groups),
      }));
    const ui = projectGroups(uiConfig, plan.ui);
    const e2e = projectGroups(e2eConfig, plan.e2e);
    const browser = { configs: [browserConfig], includePatterns: select(browserFiles, plan.ui) };
    return { ui, e2e, canonical: [browser, ...e2e] };
  };
  const configsByFile = new Map(
    prExemptFiles.map((file) => {
      const rawConfig = expectDefined(buildVitestRunPlans([file])[0]?.config, file);
      return [file, resolveCanonicalNodeTestConfig(file, rawConfig) ?? rawConfig];
    }),
  );
  // Census entries are concrete files, so check their membership independently of the planner.
  const ownersFor = (file: string, groups: readonly PlannedTestOwner[]) =>
    groups.filter(
      (group) =>
        group.configs.includes(expectDefined(configsByFile.get(file), file)) &&
        (!group.includePatterns ||
          group.includePatterns.some((pattern) => path.matchesGlob(file, pattern))),
    );
  return { prExemptFiles, retainedExtensionGroups, dedicatedGroups, ownersFor };
}

let prExemptCensus: ReturnType<typeof createPrExemptCensus> | undefined;

const getPrExemptCensus = () => (prExemptCensus ??= createPrExemptCensus());

it.each(["hourly", "release"] as const)(
  "retains one canonical owner for every PR-exempt file in %s plans",
  (mode) => {
    const { prExemptFiles, retainedExtensionGroups, dedicatedGroups, ownersFor } =
      getPrExemptCensus();
    const periodic = createNodeTestShardBundles({
      runnerBackend: "github",
      includeReleaseOnlyPluginShards: false,
      includeReleaseOnlyRuntimeTests: mode === "release",
      includePrExemptRuntimeTests: true,
      includeReleaseOnlyToolingShards: true,
      ...(mode === "hourly"
        ? {
            compactMode: "pull-request",
            includeProofTests: true,
            compactNodeJobCap: 77,
          }
        : {}),
    });
    const uiOwners = dedicatedGroups(
      createUiTestShardGroups({ includeReleaseOnlyTests: mode === "release" }),
    );
    if (mode === "hourly") {
      expect(periodic.filter((job) => !job.requiresDist).length).toBeLessThanOrEqual(77);
      expect(periodic.length).toBeLessThanOrEqual(79);
    }
    const groups = [...fallbackGroups(periodic), ...retainedExtensionGroups, ...uiOwners.canonical];
    for (const file of prExemptFiles) {
      expect(ownersFor(file, groups), file).toHaveLength(1);
      if (file.startsWith("ui/")) {
        expectUiOwnerCount(uiOwners, file, 1);
      }
    }
    for (const file of RELEASE_ONLY_UI_TEST_FILES) {
      expect(prExemptFiles, file).not.toContain(file);
      expectUiOwnerCount(uiOwners, file, mode === "release" ? 1 : 0);
    }
  },
);

it("keeps release-only UI files out of ordinary owner-selected plans", () => {
  const { dedicatedGroups } = getPrExemptCensus();
  const owners = dedicatedGroups(
    createUiTestShardGroups({
      includeReleaseOnlyTests: false,
      includePrExemptRuntimeTests: false,
      changedPaths: ["ui/vite.config.ts"],
      uiE2eFiles: [...RELEASE_ONLY_UI_TEST_FILES].filter((file) => !isUiTestTarget(file)),
    }),
  );
  for (const file of RELEASE_ONLY_UI_TEST_FILES) {
    expectUiOwnerCount(owners, file, 0);
  }
});
