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

type Owner = { configs: readonly string[]; includePatterns?: readonly string[] };
const uiConfig = "ui/vitest.config.ts";
const browserConfig = "test/vitest/vitest.ui-browser.config.ts";
const e2eConfig = "test/vitest/vitest.ui-e2e.config.ts";
const includes = (file: string, group: Pick<Owner, "includePatterns">) =>
  !group.includePatterns ||
  group.includePatterns.some((pattern) => path.matchesGlob(file, pattern));

function createPrExemptCensus() {
  const files = listPrExemptRuntimeTestFiles();
  expect(files.length).toBeGreaterThan(0);
  const extensions = createExtensionTestShards({
    shardCount: DEFAULT_EXTENSION_TEST_SHARD_COUNT,
  }).flatMap((shard) => shard.planGroups);
  const configs = [
    ...new Set([...extensions.map((group) => group.config), uiConfig, browserConfig, e2eConfig]),
  ];
  // Use an independent Node config graph, without the parent Vitest file filter.
  const discovered: Record<string, Array<{ name: string; files: string[] }>> = JSON.parse(
    execFileSync(
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
    ),
  );
  const projects = (config: string) => expectDefined(discovered[config], config);
  const allFiles = (config: string) => [
    ...new Set(projects(config).flatMap((project) => project.files)),
  ];
  const browserFiles = allFiles(browserConfig);
  expect(
    projects(uiConfig)
      .find((project) => project.name === "browser")
      ?.files.toSorted(),
  ).toEqual(browserFiles.toSorted());
  const extensionOwners = extensions.map((group) => ({
    config: group.config,
    paths: allFiles(group.config).filter((file) =>
      group.roots.some((root) => file === root || file.startsWith(`${root}/`)),
    ),
  }));
  const configsByFile = new Map(
    files.map((file) => {
      const raw = expectDefined(buildVitestRunPlans([file])[0]?.config, file);
      return [file, resolveCanonicalNodeTestConfig(file, raw) ?? raw];
    }),
  );
  return (mode: "hourly" | "release") => {
    const release = mode === "release";
    const periodic = createNodeTestShardBundles({
      runnerBackend: "github",
      includeReleaseOnlyPluginShards: false,
      includeReleaseOnlyRuntimeTests: release,
      includePrExemptRuntimeTests: true,
      includeReleaseOnlyToolingShards: true,
      ...(!release
        ? { compactMode: "pull-request", includeProofTests: true, compactNodeJobCap: 77 }
        : {}),
    });
    const ui = createUiTestShardGroups({ includeReleaseOnlyTests: release });
    const selected = (file: string, groups: typeof ui.ui) =>
      groups.some((group) => !group.includePatterns || group.includePatterns.includes(file));
    const projectCount = (file: string, config: string) =>
      projects(config).filter((project) => project.files.includes(file)).length;
    const uiCount = (file: string) =>
      isUiTestTarget(file)
        ? Number(selected(file, ui.ui)) * projectCount(file, uiConfig)
        : Number(selected(file, ui.e2e)) * projectCount(file, e2eConfig);
    if (!release) {
      expect(periodic.filter((job) => !job.requiresDist).length).toBeLessThanOrEqual(77);
      expect(periodic.length).toBeLessThanOrEqual(79);
    }
    const owners = periodic.flatMap(
      (shard) => shard.groups ?? [{ ...shard, shard_name: shard.shardName }],
    );
    for (const file of files) {
      const config = expectDefined(configsByFile.get(file), file);
      const shared =
        owners.filter((owner) => owner.configs.includes(config) && includes(file, owner)).length +
        extensionOwners.filter(({ config: key, paths }) => key === config && paths.includes(file))
          .length;
      const dedicated =
        config === browserConfig
          ? Number(browserFiles.includes(file) && selected(file, ui.ui))
          : config === e2eConfig
            ? Number(selected(file, ui.e2e)) * projectCount(file, e2eConfig)
            : 0;
      expect(shared + dedicated, file).toBe(1);
      if (file.startsWith("ui/")) {
        expect(uiCount(file), file).toBe(1);
      }
    }
    for (const file of RELEASE_ONLY_UI_TEST_FILES) {
      expect(files, file).not.toContain(file);
      expect(uiCount(file), file).toBe(release ? 1 : 0);
    }
  };
}

let census: ReturnType<typeof createPrExemptCensus> | undefined;
it.each(["hourly", "release"] as const)(
  "retains one canonical owner for every PR-exempt file in %s plans",
  (mode) => {
    (census ??= createPrExemptCensus())(mode);
  },
);
