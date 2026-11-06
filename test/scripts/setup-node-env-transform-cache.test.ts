import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { globSync } from "tinyglobby";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("retains shared transform inputs while excluding membership inventories and the keyed E2E factory", () => {
  const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
  const step = action.runs.steps.find(
    (candidate: { name: string }) => candidate.name === "Resolve Vitest transform cache generation",
  );
  const patternSource = step.run.match(/hashFiles\(([^)]*)\)/u)?.[1];
  if (!patternSource) {
    throw new Error("Transform cache generation has no hashFiles patterns");
  }
  const patterns = [...patternSource.matchAll(/'([^']+)'/gu)].map((match) => match[1]!);
  const included = [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    "packages/example/package.json",
    "packages/example/tsconfig.json",
    "vitest.config.ts",
    "ui/vitest.config.ts",
    "ui/vitest.node.config.ts",
    "scripts/control-ui-parity/vitest.config.ts",
    "scripts/control-ui-retention/vitest.config.ts",
    "test/vitest/vitest.shared.config.ts",
    "test/vitest/vitest.worker-artifacts.ts",
    "test/vitest/vitest.performance-config.ts",
    "test/vitest/vitest.ui-e2e-prebuilt.config.ts",
    "test/vitest/nested/vitest.ui-e2e.config.ts",
    "test/vitest/vitest.ui-e2e.setup.ts",
    "test/vitest/vitest.ui-e2e.bundled.global-setup.ts",
    "test/vitest/vitest.channel-paths.mjs",
    "test/vitest/nested/vitest.database-worker-core-paths.mjs",
    "test/vitest/nested/vitest.unit-fast-paths.mjs",
    "src/state/schema.sql",
  ];
  const excluded = [
    "test/vitest/vitest.database-worker-core-paths.mjs",
    "test/vitest/vitest.extension-database-workers-paths.mjs",
    "test/vitest/vitest.ui-e2e.config.ts",
    "test/vitest/vitest.unit-fast-paths.mjs",
    "node_modules/example/package.json",
    ".ci-harness/package.json",
    "docs/example.md",
  ];
  const root = tempDirs.make("openclaw-transform-generation-");
  for (const file of [...included, ...excluded]) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "fixture\n");
  }
  expect(globSync(patterns, { cwd: root, dot: true }).toSorted()).toEqual(included.toSorted());
});

it.skipIf(process.platform === "win32")(
  "reports archive restoration separately from local generation retention",
  () => {
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const step = action.runs.steps.find(
      (candidate: { name: string }) => candidate.name === "Configure Vitest transform cache",
    );
    expect(step.env.CACHE_RESTORED).toBe(
      "${{ steps.vitest-cache.outputs['cache-matched-key'] != '' && 'true' || 'false' }}",
    );
    const generation = "a".repeat(64);
    for (const scenario of [
      { restored: "true", marker: generation, entry: true, local: "retained" },
      { restored: "false", marker: generation, entry: true, local: "retained" },
      { restored: "true", marker: "b".repeat(64), entry: true, local: "cleared" },
      { restored: "true", marker: undefined, entry: true, local: "cleared" },
      { restored: "false", marker: undefined, entry: false, local: "empty" },
    ]) {
      const root = tempDirs.make("openclaw-transform-cache-");
      const cache = path.join(root, ".cache/openclaw-vitest-fs-cache");
      const githubEnv = path.join(root, "env");
      const marker = path.join(cache, ".openclaw-transform-generation");
      const entry = path.join(cache, "entry");
      mkdirSync(cache, { recursive: true });
      if (scenario.marker !== undefined) {
        writeFileSync(marker, scenario.marker);
      }
      if (scenario.entry) {
        writeFileSync(entry, "cached transform");
      }
      const result = spawnSync("/bin/bash", ["-c", step.run], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_WORKSPACE: root,
          GITHUB_ENV: githubEnv,
          CACHE_GENERATION: generation,
          CACHE_WRITER: step.env.CACHE_WRITER,
          CACHE_RESTORED: scenario.restored,
          CACHE_RUNNER_ENVIRONMENT: "github-hosted",
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `Vitest transform cache: restored=${scenario.restored} local=${scenario.local} generation=${generation} runner=github-hosted`,
      );
      expect(readFileSync(marker, "utf8")).toBe(`${generation}\n`);
      expect(existsSync(entry)).toBe(scenario.local === "retained");
      if (scenario.local === "retained") {
        expect(readFileSync(entry, "utf8")).toBe("cached transform");
      }
      expect(readFileSync(githubEnv, "utf8")).toBe(
        `OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT=${cache}\nOPENCLAW_VITEST_FS_MODULE_CACHE_WRITER=0\n`,
      );
    }
  },
);

it.skipIf(process.platform === "win32")(
  "restores runtime cache archives across different workspace depths",
  () => {
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const warmer = parse(readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8"));
    for (const [cacheName, envName] of [
      ["Vitest transform cache", "OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT"],
      ["Node compile cache", "NODE_COMPILE_CACHE"],
    ] as const) {
      const reader = action.runs.steps.find(
        (step: { name: string }) => step.name === `Restore ${cacheName}`,
      );
      const configure = action.runs.steps.find(
        (step: { name: string }) => step.name === `Configure ${cacheName}`,
      );
      const writer = warmer.jobs.warm.steps.find(
        (step: { name: string }) => step.name === `Save ${cacheName}`,
      );
      const cachePath = reader.with.path;
      expect(path.isAbsolute(cachePath)).toBe(false);
      expect(writer.with.path).toBe(cachePath);
      const root = tempDirs.make("openclaw-portable-cache-");
      const source = path.join(root, "hosted/work/project/project");
      const target = path.join(root, "boat/actions-runner/_work/project/project");
      const archive = path.join(root, "cache.tar");
      const configureAt = (workspace: string) => {
        mkdirSync(workspace, { recursive: true });
        const result = spawnSync("/bin/bash", ["-c", configure.run], {
          cwd: workspace,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            GITHUB_WORKSPACE: workspace,
            GITHUB_ENV: path.join(workspace, "env"),
            CACHE_GENERATION: "a".repeat(64),
            CACHE_WRITER: "0",
            CACHE_RESTORED: "true",
            CACHE_RUNNER_ENVIRONMENT: "self-hosted",
          },
        });
        expect(result.status, result.stderr).toBe(0);
      };
      configureAt(source);
      writeFileSync(path.join(source, cachePath, "entry"), "cached bytes\n");
      const save = spawnSync("tar", ["-cf", archive, "-C", source, writer.with.path], {
        encoding: "utf8",
      });
      expect(save.status, save.stderr).toBe(0);
      rmSync(path.join(source, cachePath), { recursive: true });
      mkdirSync(target, { recursive: true });
      const restore = spawnSync("tar", ["-xf", archive, "-C", target], { encoding: "utf8" });
      expect(restore.status, restore.stderr).toBe(0);
      configureAt(target);
      expect(readFileSync(path.join(target, cachePath, "entry"), "utf8")).toBe("cached bytes\n");
      expect(readFileSync(path.join(target, "env"), "utf8")).toContain(
        `${envName}=${path.join(target, cachePath)}\n`,
      );
    }
  },
);
