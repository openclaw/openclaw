import { spawnSync } from "node:child_process";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  createNodeTestShardBundles,
  createUiTestShardGroups,
  resolveCanonicalNodeTestConfig,
} from "../scripts/lib/ci-node-test-plan.mts";
import { listPrExemptRuntimeTestFiles } from "../scripts/lib/ci-proof-test-inventory.mts";
import {
  createExtensionTestShards,
  DEFAULT_EXTENSION_TEST_SHARD_COUNT,
} from "../scripts/lib/extension-test-plan.mts";
import { buildVitestRunPlans } from "../scripts/test-projects.test-support.mts";
import { intersectIncludePatterns } from "./vitest/vitest.include-patterns.js";
import { isUiTestTarget } from "./vitest/vitest.ui-paths.mjs";

type PlannedTestOwner = {
  configs: readonly string[];
  includePatterns?: readonly string[];
};

// Whole-inventory proof runs periodically; the policy watch owns PR opt-in.
function fallbackGroups(shards: ReturnType<typeof createNodeTestShardBundles>) {
  return shards.flatMap((shard) => shard.groups ?? [{ ...shard, shard_name: shard.shardName }]);
}

function createPrExemptCensus() {
  const prExemptFiles = listPrExemptRuntimeTestFiles();
  expect(prExemptFiles.length).toBeGreaterThan(0);
  // Plugin Prerelease owns the same full extension inventory on its hourly
  // schedule and as Full Release Validation's exact-target child, including
  // manifest-only plugins through the same discovery owner.
  const extensionGroups = createExtensionTestShards({
    shardCount: DEFAULT_EXTENSION_TEST_SHARD_COUNT,
  }).flatMap((shard) => shard.planGroups);
  // Discover in the same Node context as the prerelease planner, without the
  // parent Vitest invocation's file filter or transformed config module graph.
  const discovery = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "--input-type=module",
      "-e",
      `
      import { globSync } from "node:fs";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const files = {};
      const projects = {};
      for (const config of JSON.parse(process.argv[1])) {
        const module = await import(pathToFileURL(path.resolve(config)).href);
        const root = config === "test/vitest/vitest.ui-e2e.config.ts"
          ? module.createUiE2eVitestConfig({ ...process.env, OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1" }, [])
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
        files[config] = [...new Set(projects[config].flatMap(project => project.files))];
      }
      process.stdout.write(JSON.stringify({ files, projects }));
    `,
      JSON.stringify([
        ...new Set([
          ...extensionGroups.map((group) => group.config),
          "ui/vitest.config.ts",
          "test/vitest/vitest.ui-browser.config.ts",
          "test/vitest/vitest.ui-e2e.config.ts",
        ]),
      ]),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_VITEST_INCLUDE_FILE: undefined },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  expect(discovery.status, discovery.stderr).toBe(0);
  const discovered: {
    files: Record<string, string[]>;
    projects: Record<string, Array<{ name: string; files: string[] }>>;
  } = JSON.parse(discovery.stdout);
  const configFiles = discovered.files;
  const retainedExtensionGroups = extensionGroups.map((group) => ({
    configs: [group.config],
    includePatterns: expectDefined(configFiles[group.config], group.config).filter((file) =>
      group.roots.some((root) => file === root || file.startsWith(`${root}/`)),
    ),
  }));
  const uiProjects = expectDefined(
    discovered.projects["ui/vitest.config.ts"],
    "UI package projects",
  );
  const browserFiles = expectDefined(
    configFiles["test/vitest/vitest.ui-browser.config.ts"],
    "native Chromium config inventory",
  );
  expect(uiProjects.find((project) => project.name === "browser")?.files.toSorted()).toEqual(
    browserFiles.toSorted(),
  );
  const dedicatedGroups = (plan: ReturnType<typeof createUiTestShardGroups>) => {
    const projectGroups = (config: string, groups: typeof plan.ui) =>
      expectDefined(discovered.projects[config], config).map((project) => ({
        configs: [config],
        includePatterns: project.files.filter((file) =>
          groups.some((group) => !group.includePatterns || group.includePatterns.includes(file)),
        ),
      }));
    const ui = projectGroups("ui/vitest.config.ts", plan.ui);
    const e2e = projectGroups("test/vitest/vitest.ui-e2e.config.ts", plan.e2e);
    const browser = {
      configs: ["test/vitest/vitest.ui-browser.config.ts"],
      includePatterns: browserFiles.filter((file) =>
        plan.ui.some((group) => !group.includePatterns || group.includePatterns.includes(file)),
      ),
    };
    return { ui, e2e, canonical: [browser, ...e2e] };
  };
  const configsByFile = new Map(
    prExemptFiles.map((file) => {
      const rawConfig = expectDefined(buildVitestRunPlans([file])[0]?.config, file);
      return [file, resolveCanonicalNodeTestConfig(file, rawConfig) ?? rawConfig];
    }),
  );
  const indexOwners = (groups: readonly PlannedTestOwner[]) => {
    const owners = new Map<string, PlannedTestOwner[]>();
    for (const group of groups) {
      const candidates = prExemptFiles.filter((file) =>
        group.configs.includes(expectDefined(configsByFile.get(file), file)),
      );
      const files = group.includePatterns
        ? expectDefined(
            intersectIncludePatterns([...group.includePatterns], candidates, path.matchesGlob),
            group.configs.join(", "),
          )
        : candidates;
      for (const file of files) {
        const entries = owners.get(file) ?? [];
        entries.push(group);
        owners.set(file, entries);
      }
    }
    return owners;
  };
  return {
    prExemptFiles,
    retainedExtensionGroups,
    dedicatedGroups,
    indexOwners,
  };
}

let prExemptCensus: ReturnType<typeof createPrExemptCensus> | undefined;

function getPrExemptCensus() {
  return (prExemptCensus ??= createPrExemptCensus());
}

const prExemptPlanOptions = {
  runnerBackend: "github",
  includeReleaseOnlyPluginShards: false,
  includeReleaseOnlyRuntimeTests: false,
};

it.each(["hourly", "release"] as const)(
  "retains one canonical owner for every PR-exempt file in %s plans",
  (mode) => {
    const { prExemptFiles, retainedExtensionGroups, dedicatedGroups, indexOwners } =
      getPrExemptCensus();
    const periodic = createNodeTestShardBundles({
      ...prExemptPlanOptions,
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
    const owners = indexOwners([
      ...fallbackGroups(periodic),
      ...retainedExtensionGroups,
      ...uiOwners.canonical,
    ]);
    for (const file of prExemptFiles) {
      expect(owners.get(file) ?? [], file).toHaveLength(1);
      if (file.startsWith("ui/")) {
        const kind = isUiTestTarget(file) ? "ui" : "e2e";
        expect(
          uiOwners[kind].filter((group) => group.includePatterns.includes(file)),
          file,
        ).toHaveLength(1);
      }
    }
  },
);
