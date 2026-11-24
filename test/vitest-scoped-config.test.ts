import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minimatch } from "minimatch";
import { globSync } from "tinyglobby";
import { afterEach, describe, expect, it } from "vitest";
import type { ViteUserConfig } from "vitest/config";
import { parseCLI, resolveConfig } from "vitest/node";
import { createSelectedNodeTestShardBundles } from "../scripts/lib/ci-node-test-plan.mts";
import {
  createVitestRunSpecs,
  writeVitestIncludeFile,
} from "../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { normalizeConfigPath } from "./helpers/vitest-config-paths.js";
import { createAgentsCoreIsolatedVitestConfig } from "./vitest/vitest.agents-core-isolated.config.ts";
import { createAgentsCoreVitestConfig } from "./vitest/vitest.agents-core.config.ts";
import { agentVitestProjectOwners } from "./vitest/vitest.agents-paths.mjs";
import { createAgentsSpawnProductionBoundaryVitestConfig } from "./vitest/vitest.agents-spawn-production-boundary.config.ts";
import { createAgentsVitestConfig } from "./vitest/vitest.agents.config.ts";
import { cliProcessTestFiles } from "./vitest/vitest.cli-process-paths.mjs";
import { createCliProcessVitestConfig } from "./vitest/vitest.cli-process.config.ts";
import { createCliVitestConfig } from "./vitest/vitest.cli.config.ts";
import { databaseWorkerCoreTestFiles } from "./vitest/vitest.database-worker-core-paths.mjs";
import { createDatabaseWorkerWatchVitestConfig } from "./vitest/vitest.database-worker-watch.config.ts";
import { databaseWorkerExtensionTestFiles } from "./vitest/vitest.extension-database-workers-paths.mjs";
import { createExtensionDatabaseWorkersVitestConfig } from "./vitest/vitest.extension-database-workers.config.ts";
import { createExtensionMatrixVitestConfig } from "./vitest/vitest.extension-matrix.config.ts";
import { createExtensionTelegramVitestConfig } from "./vitest/vitest.extension-telegram.config.ts";
import { diagnosticForksPool } from "./vitest/vitest.forks-pool.ts";
import { createGatewayClientVitestConfig } from "./vitest/vitest.gateway-client.config.ts";
import { createGatewayCoreVitestConfig } from "./vitest/vitest.gateway-core.config.ts";
import { createGatewayMethodsVitestConfig } from "./vitest/vitest.gateway-methods.config.ts";
import { createGatewayServerVitestConfig } from "./vitest/vitest.gateway-server.config.ts";
import {
  intersectIncludePatterns,
  serializeIncludePatterns,
} from "./vitest/vitest.include-patterns.ts";
import { createInfraVitestConfig } from "./vitest/vitest.infra.config.ts";
import { createPluginsVitestConfig } from "./vitest/vitest.plugins.config.ts";
import { createRuntimeConfigVitestConfig } from "./vitest/vitest.runtime-config.config.ts";
import { createScopedVitestConfig } from "./vitest/vitest.scoped-config.ts";
import { resolveScopedVitestPatterns } from "./vitest/vitest.scoped-patterns.ts";
import { sharedVitestConfig } from "./vitest/vitest.shared.config.ts";
import { createToolingDockerVitestConfig } from "./vitest/vitest.tooling-docker.config.ts";
import { toolingIsolatedTestFiles } from "./vitest/vitest.tooling-isolated-paths.mjs";
import { createToolingIsolatedVitestConfig } from "./vitest/vitest.tooling-isolated.config.ts";
import { toolingDockerTestFiles } from "./vitest/vitest.tooling-paths.mjs";
import { createToolingVitestConfig } from "./vitest/vitest.tooling.config.ts";
import { createUiVitestConfig } from "./vitest/vitest.ui.config.ts";
import { isUnitFastTestFile } from "./vitest/vitest.unit-fast-paths.mjs";
import { createWizardVitestConfig } from "./vitest/vitest.wizard.config.ts";

function matchingExcludePatterns(patterns: string[], file: string): string[] {
  return patterns.filter((pattern) => path.matchesGlob(file, pattern));
}

async function requireTestConfig<T extends ViteUserConfig>(
  config: T,
): Promise<NonNullable<T["test"]>> {
  if (!config.test) throw new Error("expected scoped vitest test config");
  const resolved = await resolveConfig({ config: false }, config);
  return resolved.test as NonNullable<T["test"]>;
}

async function expectDefaultIsolatedRunner(config: ViteUserConfig) {
  const testConfig = await requireTestConfig(config);
  expect(testConfig.pool).toBe(process.platform === "win32" ? "forks" : "threads");
  expect(testConfig.isolate).toBe(true);
  expect(testConfig.runner).toBeUndefined();
}
async function expectForkedNonIsolatedRunner(
  config: ViteUserConfig,
  pool: "forks" | typeof diagnosticForksPool = "forks",
) {
  const testConfig = await requireTestConfig(config);
  expect(testConfig.pool).toBe(typeof pool === "string" ? pool : pool.name);
  expect(testConfig.isolate).toBe(false);
  expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
}

describe("createScopedVitestConfig", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("distinguishes equal-valued and empty native overrides from owner defaults", async () => {
    const includeFile = path.join(tempDirs.make("native-pattern-overrides-"), "include.json");
    fs.writeFileSync(includeFile, JSON.stringify(["test/one.test.ts"]));
    const config = createScopedVitestConfig(["test/**/*.test.ts"], {
      dir: "test",
      env: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
      argv: ["node", "vitest", "run"],
      intersectIncludeFile: true,
    });
    expect(config.test?.include).toBeUndefined();
    expect(config.test?.exclude).toBeUndefined();
    for (const include of [["**/*.test.ts"], []]) {
      const { test } = await resolveConfig({ config: false, include, exclude: [] }, config);
      expect(test.include).toEqual(include);
      expect(test.exclude).toEqual([]);
    }
  });

  it("retains unit-fast exclusions when a final plugin leaf adds its own exclusions", async () => {
    const config = createPluginsVitestConfig({});
    const ordinary = config.test?.projects?.[0];
    if (!ordinary || typeof ordinary !== "object") throw new Error("missing ordinary plugin leaf");
    const { test } = await resolveConfig({ config: false }, ordinary);
    expect(test.exclude).toContain("min-host-version.test.ts");
  });

  it("intersects inherited paths after programmatic directory overrides and preserves exclusions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-effective-patterns-"));
    try {
      const owner = ["test/scripts/keep.test.ts", "test/scripts/blocked.test.ts"];
      for (const file of owner) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), "");
      }
      const includeFile = path.join(root, "include.json");
      fs.writeFileSync(includeFile, JSON.stringify(["*.test.ts", "!blocked.test.ts"]));
      const config = createScopedVitestConfig(
        owner.map((file) => path.join(root, file)),
        {
          env: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
          argv: ["node", "vitest", "run"],
          intersectIncludeFile: true,
          excludeUnitFastTests: false,
        },
      );
      for (const dir of [path.join(root, "test/scripts"), root, path.join(root, "test/scripts")]) {
        const resolved = await resolveConfig({ config: false, dir }, config);
        const actual = globSync(resolved.test.include, {
          cwd: resolved.test.dir,
          absolute: true,
          ignore: resolved.test.exclude,
        });
        expect(actual).toEqual(dir === root ? [] : [path.join(root, owner[0]!)]);
      }
      const beforeArgv = [...process.argv];
      const native = parseCLI([
        "vitest",
        "run",
        "--dir",
        path.join(root, "test/scripts"),
        "--exclude",
        "keep.test.ts",
      ]);
      const resolved = await resolveConfig({ ...native.options, config: false }, config);
      expect(
        globSync(resolved.test.include, {
          cwd: resolved.test.dir,
          ignore: resolved.test.exclude,
        }),
      ).toEqual([]);
      expect(
        resolved.test.exclude.some((pattern) =>
          path.matchesGlob(path.join(root, "test/scripts/blocked.test.ts"), pattern),
        ),
      ).toBe(true);
      expect(resolved.test.exclude).toContain("keep.test.ts");
      expect(process.argv).toEqual(beforeArgv);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("narrows package CLI directories within their owner", async () => {
    const config = createScopedVitestConfig(["packages/**/*.test.ts"], {
      argv: ["vitest", "run", "packages/normalization-core"],
      dir: "packages",
      env: {},
      passWithNoTests: true,
    });

    expect((await requireTestConfig(config)).include).toEqual(["normalization-core/**/*.test.ts"]);
  });

  it.each([undefined, "test"])(
    "preserves native overrides on their own directory basis (%s)",
    async (dir) => {
      const config = createScopedVitestConfig(["test/**/*.test.ts"], {
        dir,
        env: {},
        argv: ["node", "vitest", "run"],
        excludeUnitFastTests: false,
      });
      const { test } = await resolveConfig(
        {
          config: false,
          include: ["test/selected.test.ts"],
          exclude: ["test/blocked.test.ts"],
        },
        config,
      );
      expect(test.include).toEqual(["test/selected.test.ts"]);
      expect(test.exclude).toEqual(["test/blocked.test.ts"]);
    },
  );

  it.each([
    {
      title: "keeps explicitly selected files owned by negative extglobs",
      includePattern: "extensions/*/browser/**/!(*.browser).test.ts",
      target: "extensions/example/browser/view.test.ts",
      expectedInclude: "example/browser/view.test.ts",
    },
    {
      title: "narrows scoped includes to matching dot-prefixed CLI file filters",
      includePattern: "extensions/codex/**/*.test.ts",
      target: "./extensions/codex/src/app-server/client.test.ts",
      expectedInclude: "codex/src/app-server/client.test.ts",
    },
    {
      title: "narrows scoped includes to matching dir-relative CLI file filters",
      includePattern: "extensions/codex/**/*.test.ts",
      target: "codex/src/app-server/client.test.ts",
      expectedInclude: "codex/src/app-server/client.test.ts",
    },
    {
      title: "does not narrow scoped includes for bare Vitest name filters",
      includePattern: "extensions/codex/**/*.test.ts",
      target: "client",
      expectedInclude: "codex/**/*.test.ts",
    },
  ])("$title", async ({ includePattern, target, expectedInclude }) => {
    const config = createScopedVitestConfig([includePattern], {
      argv: ["node", "vitest", "run", target],
      dir: "extensions",
      env: {},
    });
    const testConfig = await requireTestConfig(config);

    expect(testConfig.include).toEqual([expectedInclude]);
    expect(testConfig.passWithNoTests).toBe(false);
  });

  it("does not narrow scoped includes for coverage option values", async () => {
    const config = createScopedVitestConfig(["extensions/codex/**/*.test.ts"], {
      argv: ["node", "vitest", "run", "--coverage.include", "codex/src/app-server/client.ts"],
      dir: "extensions",
      env: {},
    });
    const testConfig = await requireTestConfig(config);

    expect(testConfig.include).toEqual(["codex/**/*.test.ts"]);
    expect(testConfig.passWithNoTests).toBe(false);
  });

  it("does not narrow scoped includes for exclude option values", async () => {
    const config = createScopedVitestConfig(["extensions/codex/**/*.test.ts"], {
      argv: ["node", "vitest", "run", "--exclude", "codex/src/app-server/run-attempt.test.ts"],
      dir: "extensions",
      env: {},
    });
    const testConfig = await requireTestConfig(config);

    expect(testConfig.include).toEqual(["codex/**/*.test.ts"]);
    expect(testConfig.passWithNoTests).toBe(false);
  });

  it("lets root Vitest project runs skip scoped files owned by unit-fast", async () => {
    const config = createScopedVitestConfig(["src/acp/**/*.test.ts"], {
      argv: ["node", "vitest", "run", "src/acp/client.test.ts"],
      dir: "src/acp",
      env: {},
    });
    const testConfig = await requireTestConfig(config);

    expect(testConfig.include).toEqual(["client.test.ts"]);
    expect(testConfig.passWithNoTests).toBe(true);
  });

  it("lets unrelated root Vitest projects skip when CLI filters match no scoped files", async () => {
    const config = createScopedVitestConfig(["extensions/**/*.test.ts"], {
      argv: ["node", "vitest", "run", "src/config/channel-configured.test.ts"],
      dir: "extensions",
      env: {},
    });
    const testConfig = await requireTestConfig(config);

    expect(testConfig.include).toEqual([]);
    expect(testConfig.passWithNoTests).toBe(true);
  });

  it("intersects a watch-mode directory target with project ownership", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vitest-scoped-"));
    try {
      const includeFile = path.join(tempDir, "include.json");
      fs.writeFileSync(includeFile, JSON.stringify(["src/gateway/**/*.test.ts"]), "utf8");

      const config = createScopedVitestConfig(["src/gateway/**/*server*.test.ts"], {
        dir: "src/gateway",
        env: {
          OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
        },
        intersectIncludeFile: true,
      });

      expect((await requireTestConfig(config)).include).toEqual(["**/*server*.test.ts"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps shared gateway include files inside their actual child projects", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vitest-scoped-"));
    try {
      const includeFile = path.join(tempDir, "include.json");
      fs.writeFileSync(
        includeFile,
        JSON.stringify(["src/gateway/server.node-pairing-ssh-verify.test.ts"]),
        "utf8",
      );
      const env = { OPENCLAW_VITEST_INCLUDE_FILE: includeFile };

      expect((await requireTestConfig(createGatewayServerVitestConfig(env))).include).toEqual([
        "server.node-pairing-ssh-verify.test.ts",
      ]);
      const coreConfig = await requireTestConfig(createGatewayCoreVitestConfig(env));
      expect(coreConfig.include).toEqual(["server.node-pairing-ssh-verify.test.ts"]);
      expect(coreConfig.passWithNoTests).toBe(true);
      const clientConfig = await requireTestConfig(createGatewayClientVitestConfig(env));
      expect(clientConfig.include).toEqual([]);
      expect(clientConfig.passWithNoTests).toBe(true);
      const methodsConfig = await requireTestConfig(createGatewayMethodsVitestConfig(env));
      expect(methodsConfig.include).toEqual([]);
      expect(methodsConfig.passWithNoTests).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("scoped vitest configs", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const defaultCliProcessConfig = createCliProcessVitestConfig({});
  const defaultCliConfig = createCliVitestConfig({});
  const defaultExtensionTelegramConfig = createExtensionTelegramVitestConfig({});
  const defaultInfraConfig = createInfraVitestConfig({});
  const defaultRuntimeConfig = createRuntimeConfigVitestConfig({});
  const defaultAgentsCoreConfig = createAgentsCoreVitestConfig({});
  const defaultAgentsCoreIsolatedConfig = createAgentsCoreIsolatedVitestConfig({});
  const defaultAgentsSpawnProductionBoundaryConfig =
    createAgentsSpawnProductionBoundaryVitestConfig({});
  const defaultPluginsConfig = createPluginsVitestConfig({});
  const defaultUiConfig = createUiVitestConfig({});
  const defaultWizardConfig = createWizardVitestConfig({});

  it("keeps source-child process tests in the isolated process project", async () => {
    const cliProcessFiles = cliProcessTestFiles.filter((file) => file.startsWith("src/cli/"));
    expect((await requireTestConfig(defaultCliConfig)).exclude).toEqual(
      expect.arrayContaining(cliProcessFiles.map((file) => file.replace("src/cli/", ""))),
    );
    const processTestConfig = await requireTestConfig(defaultCliProcessConfig);
    expect(processTestConfig.include).toContain("src/cli/update-dry-run-state.process.test.ts");
    expect(processTestConfig.include).toEqual(cliProcessTestFiles);
    for (const file of cliProcessTestFiles) {
      expect(matchingExcludePatterns(processTestConfig.exclude ?? [], file), file).toEqual([]);
    }
    expect(processTestConfig.fileParallelism).toBe(false);
    expect(processTestConfig.env).toMatchObject({
      ESBUILD_WORKER_THREADS: "0",
    });
  });

  it("keeps native SQLite runtime config tests in forked workers", async () => {
    await expectForkedNonIsolatedRunner(defaultRuntimeConfig);
  });

  it("keeps agents lanes on the shared worker schedule", async () => {
    const maxWorkers = 8;
    const original = sharedVitestConfig.test;
    try {
      sharedVitestConfig.test = { ...original, maxWorkers, fileParallelism: maxWorkers > 1 };
      for (const createConfig of [createAgentsVitestConfig, createAgentsCoreVitestConfig]) {
        expect(await requireTestConfig(createConfig({}))).toMatchObject({
          maxWorkers,
          fileParallelism: maxWorkers > 1,
        });
      }
    } finally {
      sharedVitestConfig.test = original;
    }
  });

  it("isolates agent suites with conflicting shared-module mocks", async () => {
    const sharedConfig = await requireTestConfig(defaultAgentsCoreConfig);
    const isolatedConfig = await requireTestConfig(defaultAgentsCoreIsolatedConfig);
    const productionBoundaryConfig = await requireTestConfig(
      defaultAgentsSpawnProductionBoundaryConfig,
    );

    const scopedIsolatedFiles = agentVitestProjectOwners.coreIsolated.include.map((file) =>
      file.replace("src/agents/", ""),
    );
    expect(sharedConfig.exclude).toEqual(expect.arrayContaining(scopedIsolatedFiles));
    expect(isolatedConfig.include).toEqual(scopedIsolatedFiles);
    for (const file of agentVitestProjectOwners.coreIsolated.include) {
      expect(isUnitFastTestFile(file), file).toBe(false);
      expect(
        matchingExcludePatterns(isolatedConfig.exclude ?? [], file.replace("src/agents/", "")),
        file,
      ).toEqual([]);
    }
    expect(isolatedConfig.isolate).toBe(true);
    expect(isolatedConfig.runner).toBeUndefined();
    expect(productionBoundaryConfig.include).toEqual(
      agentVitestProjectOwners.spawnProductionBoundary.include.map((file) =>
        file.replace("src/agents/", ""),
      ),
    );
    expect(productionBoundaryConfig.fileParallelism).toBe(false);
    expect(productionBoundaryConfig.isolate).toBe(true);
    expect(productionBoundaryConfig.pool).toBe("forks");
    expect(productionBoundaryConfig.runner).toBeUndefined();
  });

  it("isolates Telegram extension mocks while inheriting file scheduling", async () => {
    await expectDefaultIsolatedRunner(defaultExtensionTelegramConfig);
    expect((await requireTestConfig(defaultExtensionTelegramConfig)).fileParallelism).toBe(
      sharedVitestConfig.test.fileParallelism,
    );
  });

  it("keeps infra and database worker consumers rooted at the repository", async () => {
    const testConfig = await requireTestConfig(defaultInfraConfig);
    expect(testConfig.pool).toBe(diagnosticForksPool.name);
    expect(testConfig.isolate).toBe(true);
    expect(testConfig.runner).toBeUndefined();
    expect(testConfig.dir).toBe(process.cwd());
    expect(testConfig.include).toEqual(["src/infra/**/*.test.ts", ...databaseWorkerCoreTestFiles]);
    const imageAuthFile = "src/agents/tools/image-generate-tool.auth.test.ts";
    expect(testConfig.include).toContain(imageAuthFile);
    expect(agentVitestProjectOwners.tools.exclude).toContain(imageAuthFile);
    const recoveryFile = "src/wizard/setup.inference-recovery.integration.test.ts";
    expect(testConfig.include?.filter((file) => file === recoveryFile)).toEqual([recoveryFile]);
    expect((await requireTestConfig(defaultWizardConfig)).exclude).toContain(
      "wizard/setup.inference-recovery.integration.test.ts",
    );
    for (const file of databaseWorkerCoreTestFiles) {
      expect(matchingExcludePatterns(testConfig.exclude ?? [], file), file).toEqual([]);
    }
  });

  it.each([
    {
      root: "src/agents",
      createOwner: createAgentsVitestConfig,
      workerFiles: databaseWorkerCoreTestFiles,
      names: ["agents", "infra"],
      existing: "src/agents/embedded-agent-runner/run.session-permissions.test.ts",
      createWorker: createInfraVitestConfig,
    },
    {
      root: "extensions/matrix",
      createOwner: createExtensionMatrixVitestConfig,
      workerFiles: databaseWorkerExtensionTestFiles,
      names: ["extension-matrix", "extension-database-workers"],
      existing: "extensions/matrix/src/matrix/client/storage.test.ts",
      createWorker: createExtensionDatabaseWorkersVitestConfig,
    },
  ])(
    "discovers current and new $root watch files once across database owners",
    async ({ root, createOwner, workerFiles, names, existing, createWorker }) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worker-watch-"));
      try {
        const includeFile = path.join(tempDir, "include.json");
        fs.writeFileSync(includeFile, JSON.stringify([`${root}/**/*.test.ts`]));
        const env = { OPENCLAW_VITEST_INCLUDE_FILE: includeFile };
        const owner = createOwner(env);
        const aggregate = createDatabaseWorkerWatchVitestConfig(
          owner,
          workerFiles.filter((file) => file.startsWith(`${root}/`)),
          env,
        );
        const resolved = await resolveConfig({ config: false }, aggregate);
        const projects = resolved.test.resolvedProjects.map(({ projectConfig }) => projectConfig);
        const resolvedOwner = await resolveConfig({ config: false }, owner);
        expect(resolved.test.reporters).toEqual(resolvedOwner.test.reporters);
        const { exclude: exclusions, ...coverage } = resolved.test.coverage;
        const { exclude: ownerExclusions, ...ownerCoverage } = resolvedOwner.test.coverage;
        expect(coverage).toEqual(ownerCoverage);
        expect(exclusions).toEqual(expect.arrayContaining(ownerExclusions));
        expect(
          exclusions
            .filter((pattern) => !ownerExclusions.includes(pattern))
            .every((pattern) => /\.test\.[cm]?[jt]sx?$/u.test(pattern)),
        ).toBe(true);
        expect(projects.map((project) => project.name)).toEqual(names);
        expect(projects.map((project) => project.pool)).toEqual([
          process.platform === "win32" ? "forks" : "threads",
          diagnosticForksPool.name,
        ]);
        expect(projects[0]?.setupFiles).toEqual(owner.test?.setupFiles);
        expect(projects[0]?.maxWorkers).toBe(owner.test?.maxWorkers);
        const workerConfig = await resolveConfig(
          { config: false },
          createWorker({ ...env, OPENCLAW_VITEST_INCLUDE_FILE: undefined }),
        );
        expect(projects[1]?.maxWorkers).toBe(workerConfig.test.maxWorkers);

        const discover = (fixtureRoot: string) =>
          projects.flatMap((project) => {
            const scopedDir = path.relative(process.cwd(), project.dir);
            const exclude = project.exclude.map((pattern) =>
              path.isAbsolute(pattern) ? path.relative(project.dir, pattern) : pattern,
            );
            return fs
              .globSync(project.include, {
                cwd: path.join(fixtureRoot, scopedDir),
                exclude,
              })
              .map((file) => path.join(scopedDir, file).replaceAll("\\", "/"));
          });
        const current = discover(process.cwd());
        expect(new Set(current).size).toBe(current.length);
        for (const file of workerFiles.filter((candidate) => candidate.startsWith(`${root}/`))) {
          expect(current).toContain(file);
        }

        const fixtureRoot = path.join(tempDir, "repo");
        fs.mkdirSync(path.dirname(path.join(fixtureRoot, existing)), { recursive: true });
        fs.writeFileSync(path.join(fixtureRoot, existing), "// discovery only\n");
        expect(discover(fixtureRoot)).toEqual([existing]);
        const added = `${root}/new-watch-consumer.test.ts`;
        fs.writeFileSync(path.join(fixtureRoot, added), "// discovery only\n");
        expect(discover(fixtureRoot).toSorted()).toEqual([existing, added].toSorted());

        for (const selection of [existing, path.resolve(existing).replaceAll("\\", "/")]) {
          fs.writeFileSync(includeFile, JSON.stringify([selection]));
          const narrowed = createDatabaseWorkerWatchVitestConfig(
            createOwner(env),
            workerFiles.filter((file) => file.startsWith(`${root}/`)),
            env,
          );
          const narrowedConfig = await resolveConfig({ config: false }, narrowed);
          const workerProject = narrowedConfig.test.resolvedProjects[1]?.projectConfig;
          expect(workerProject?.include).toEqual([
            path.isAbsolute(selection)
              ? selection
              : path.relative(workerProject!.dir, path.resolve(existing)),
          ]);
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("runs state-sensitive tooling tests isolated from shared mocks", async () => {
    const testConfig = await requireTestConfig(createToolingIsolatedVitestConfig({}));
    expect(testConfig.include).toEqual(toolingIsolatedTestFiles);
    expect(testConfig.isolate).toBe(true);
    expect(testConfig.runner).toBeUndefined();
  });

  it("keeps filtered aggregate tooling membership inside each materialized pool", async () => {
    const selected = [
      ...toolingDockerTestFiles,
      ...toolingIsolatedTestFiles.filter((file) => !file.endsWith("/vitest-fork-shutdown.test.ts")),
    ];
    const tempDir = tempDirs.make("openclaw-tooling-aggregate-");
    const includeFile = path.join(tempDir, "include.json");
    fs.writeFileSync(includeFile, JSON.stringify(selected));
    const env = { OPENCLAW_VITEST_INCLUDE_FILE: includeFile };
    const memberships = [];
    for (const [createConfig, owned] of [
      [createToolingDockerVitestConfig, toolingDockerTestFiles],
      [createToolingIsolatedVitestConfig, toolingIsolatedTestFiles],
    ] as const) {
      const resolved = await resolveConfig({ config: false }, createConfig(env));
      const expected = selected.filter(
        (file) =>
          owned.includes(file) && (owned === toolingIsolatedTestFiles || !isUnitFastTestFile(file)),
      );
      const actual = globSync(resolved.test.include, {
        cwd: resolved.test.dir,
        ignore: resolved.test.exclude,
        dot: true,
        expandDirectories: false,
      });
      expect(actual.toSorted()).toEqual(expected.toSorted());
      memberships.push(...actual);
      if (owned === toolingIsolatedTestFiles) {
        expect(resolved.test.pool).toBe("forks");
        expect(resolved.test.isolate).toBe(true);
      }
    }
    const thinDocker = "test/scripts/docker-e2e-update-suppression.test.ts";
    expect(isUnitFastTestFile(thinDocker)).toBe(true);
    expect(memberships).not.toContain(thinDocker);
    expect(memberships.toSorted()).toEqual(
      selected.filter((file) => file !== thinDocker).toSorted(),
    );
    expect(new Set(memberships).size).toBe(memberships.length);
  });

  it.each(["relative", "absolute", "absolute-glob"])(
    "keeps %s include-file selections within each tooling owner",
    async (style) => {
      const docker = "test/scripts/docker-build-helper.test.ts";
      const isolated = "test/scripts/vitest-fork-shutdown.test.ts";
      const foreign = "src/infra/unrelated.test.ts";
      const includeFile = path.join(tempDirs.make("vitest-owner-includes-"), "include.json");
      for (const selected of [[docker, isolated, foreign], [foreign], []]) {
        fs.writeFileSync(
          includeFile,
          JSON.stringify(
            style === "relative"
              ? selected
              : selected.map((file) =>
                  path
                    .resolve(
                      style === "absolute-glob"
                        ? file.replace(/(.)\.test\.ts$/u, "[$1].test.ts")
                        : file,
                    )
                    .replaceAll("\\", "/"),
                ),
          ),
        );
        for (const [createConfig, file] of [
          [createToolingDockerVitestConfig, docker],
          [createToolingIsolatedVitestConfig, isolated],
        ] as const) {
          for (const dir of style !== "relative"
            ? [undefined, path.resolve("test/scripts")]
            : [undefined]) {
            const resolved = await resolveConfig(
              { config: false, ...(dir ? { dir } : {}) },
              createConfig({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile }),
            );
            if (dir) expect(resolved.test.dir).toBe(dir);
            expect(
              globSync(resolved.test.include, {
                cwd: resolved.test.dir,
                ignore: resolved.test.exclude,
                dot: true,
                expandDirectories: false,
                absolute: true,
              }),
            ).toEqual(selected.includes(file) ? [path.resolve(file).replaceAll("\\", "/")] : []);
          }
        }
      }
    },
  );

  it.each([false, true])(
    "retains absolute members beside a relative covering glob under --dir (absolute first: %s)",
    async (absoluteFirst) => {
      const includeFile = path.join(tempDirs.make("vitest-mixed-origin-"), "include.json");
      const relative = "test/scripts/**/*.test.ts";
      for (const [createConfig, file] of [
        [createToolingDockerVitestConfig, "test/scripts/docker-build-helper.test.ts"],
        [createToolingIsolatedVitestConfig, "test/scripts/vitest-fork-shutdown.test.ts"],
      ] as const) {
        const absolute = path.resolve(file).replaceAll("\\", "/");
        const inherited = absoluteFirst ? [absolute, relative] : [relative, absolute];
        fs.writeFileSync(
          includeFile,
          JSON.stringify(
            serializeIncludePatterns(
              intersectIncludePatterns(inherited, [relative], path.matchesGlob, process.cwd())!,
            ),
          ),
        );
        const resolved = await resolveConfig(
          { config: false, dir: path.resolve("test/scripts") },
          createConfig({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile }),
        );
        expect(
          globSync(resolved.test.include, {
            cwd: resolved.test.dir,
            ignore: resolved.test.exclude,
            dot: true,
            expandDirectories: false,
            absolute: true,
          }),
        ).toEqual([absolute]);
      }
    },
  );

  it.each([false, true])(
    "preserves owner and unit-fast exclusions with absolute selections (alternate dir: %s)",
    async (alternateDir) => {
      const ordinary = "test/scripts/upgrade-survivor-native-assignments.test.ts";
      const isolated = "test/scripts/vitest-fork-shutdown.test.ts";
      const docker = "test/scripts/docker-build-helper.test.ts";
      const thin = "test/scripts/docker-e2e-update-suppression.test.ts";
      const absolute = (file: string) => path.resolve(file).replaceAll("\\", "/");
      const includeFile = path.join(tempDirs.make("vitest-absolute-owners-"), "include.json");
      fs.writeFileSync(
        includeFile,
        JSON.stringify([ordinary, isolated, docker, thin].map(absolute)),
      );
      expect(isUnitFastTestFile(ordinary)).toBe(false);
      expect(isUnitFastTestFile(thin)).toBe(true);
      for (const cliExclude of [[], [absolute(docker)]]) {
        const memberships = [];
        for (const [createConfig, owned] of [
          [createToolingVitestConfig, ordinary],
          [createToolingIsolatedVitestConfig, isolated],
          [createToolingDockerVitestConfig, docker],
        ] as const) {
          const resolved = await resolveConfig(
            {
              config: false,
              dir: path.resolve(alternateDir ? "test/scripts" : "."),
              cliExclude,
            },
            createConfig({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile }),
          );
          const files = globSync(resolved.test.include, {
            cwd: resolved.test.dir,
            ignore: resolved.test.exclude,
            dot: true,
            expandDirectories: false,
            absolute: true,
          });
          expect(files).toEqual(cliExclude.includes(absolute(owned)) ? [] : [absolute(owned)]);
          memberships.push(...files);
        }
        expect(memberships).not.toContain(absolute(thin));
        expect(new Set(memberships).size).toBe(memberships.length);
      }
    },
  );

  it("resolves the shared unit-fast exclusions in the invocation checkout", () => {
    const file = "test/scripts/fixture.test.ts";
    const roots = [tempDirs.make("vitest-thin-owner-"), tempDirs.make("vitest-stateful-owner-")];
    for (const [index, root] of roots.entries()) {
      fs.mkdirSync(path.join(root, "test/scripts"), { recursive: true });
      fs.writeFileSync(
        path.join(root, file),
        index === 0 ? "export {};" : "import fs from 'node:fs';",
      );
      const ordinary = resolveScopedVitestPatterns([file], {
        root,
        argv: ["node", "vitest"],
        externalInclude: [file],
      });
      expect(ordinary.scopedInclude).toEqual([file]);
      expect(ordinary.scopedExclude.includes(file)).toBe(index === 0);
      const isolated = resolveScopedVitestPatterns([file], {
        root,
        argv: ["node", "vitest"],
        externalInclude: [file, "test/scripts/other.test.ts"],
        intersectIncludeFile: true,
        excludeUnitFastTests: false,
      });
      expect(isolated.scopedInclude).toEqual([file]);
      expect(isolated.scopedExclude).not.toContain(file);
    }
  });

  it.each([false, true])(
    "applies CLI-process exclusions in the materialized root (explicit dir: %s)",
    async (explicitDir) => {
      const isolated = "src/cli/update-cli/update-command-legacy-finalize.test.ts";
      const processFile = "src/cli/update-cli/update-command-migrated.test.ts";
      const includeFile = path.join(tempDirs.make("vitest-cli-owner-"), "include.json");
      const env = { OPENCLAW_VITEST_INCLUDE_FILE: includeFile };
      for (const excluded of [null, processFile, isolated]) {
        for (const [createConfig, owned] of [
          [createCliProcessVitestConfig, processFile],
          [createToolingIsolatedVitestConfig, isolated],
        ] as const) {
          fs.writeFileSync(includeFile, JSON.stringify([owned]));
          const resolved = await resolveConfig(
            {
              config: false,
              ...(explicitDir ? { dir: process.cwd() } : {}),
              ...(excluded ? { cliExclude: [excluded] } : {}),
            },
            createConfig(env),
          );
          expect(resolved.test.exclude).toEqual(
            expect.arrayContaining((await requireTestConfig(createConfig(env))).exclude ?? []),
          );
          expect(
            globSync(resolved.test.include, {
              cwd: resolved.test.dir,
              ignore: resolved.test.exclude,
              dot: true,
              expandDirectories: false,
            }),
          ).toEqual(excluded === owned ? [] : [owned]);
        }
      }
    },
  );

  it.each(["repository", "native-dir", "absolute"])(
    "retains CLI-process inventory and inherited negatives in %s coordinates",
    async (style) => {
      const base = "src/cli/update-cli/";
      const selected = `${base}update-command{,-candidate-exit,-fresh-preview}.test.ts`;
      const blocked = `${base}update-command-fresh-preview.test.ts`;
      const map = (pattern: string) =>
        style === "absolute"
          ? path.resolve(pattern).split(path.sep).join("/")
          : style === "native-dir"
            ? pattern.slice("src/cli/".length)
            : pattern;
      const includeFile = path.join(tempDirs.make("native-cli-process-"), "include.json");
      for (const include of [[map(selected), `!${map(blocked)}`], []]) {
        fs.writeFileSync(includeFile, JSON.stringify(include));
        const config = createCliProcessVitestConfig({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile });
        const resolved = await resolveConfig(
          {
            config: false,
            ...(style === "repository"
              ? {}
              : { dir: path.resolve(style === "native-dir" ? "src/cli" : "test/helpers") }),
          },
          config,
        );
        const files = globSync(resolved.test.include, {
          cwd: resolved.test.dir || resolved.test.root,
          ignore: resolved.test.exclude,
          absolute: true,
          dot: true,
          expandDirectories: false,
        });
        expect(files).toEqual(
          include.length
            ? [
                path
                  .resolve(`${base}update-command-candidate-exit.test.ts`)
                  .split(path.sep)
                  .join("/"),
              ]
            : [],
        );
        expect(resolved.test.name).toBe("cli-process");
        expect(resolved.test.isolate).toBe(true);
      }
    },
  );

  it("keeps the materialized Infra watch owner inside its admitted inventory", async () => {
    const root = tempDirs.make("native-infra-watch-");
    const worker = "test/scripts/upgrade-survivor-acp-metadata.test.ts";
    const ordinary = "test/scripts/upgrade-survivor-native-assignments.test.ts";
    fs.mkdirSync(path.join(root, "test/scripts"), { recursive: true });
    for (const file of [worker, ordinary]) {
      fs.writeFileSync(path.join(root, file), "import fs from 'node:fs';");
    }
    const target = "test/scripts/upgrade-survivor-*.test.ts";
    const [spec] = createVitestRunSpecs(["--watch", target, "--project=infra"], {
      cwd: root,
      baseEnv: {},
    });
    expect(spec?.config).toBe("test/vitest/vitest.infra.config.ts");
    expect(spec?.includePatterns).toEqual([target]);
    expect(spec?.pnpmArgs.at(-1)).toBe("--project=infra");
    const includeFile = path.join(root, "include.json");
    writeVitestIncludeFile(includeFile, spec!.includePatterns!, { cwd: root, expandGlobs: false });
    fs.unlinkSync(path.join(root, worker));
    const config = createInfraVitestConfig({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile });
    const { test } = await resolveConfig(
      { config: false, root, dir: root, project: ["infra"] },
      { ...config, root, test: { ...config.test, root } },
    );
    expect(test.dir).toBe(root);
    const discovered = () =>
      globSync(test.include, {
        cwd: test.dir || test.root,
        ignore: test.exclude,
        expandDirectories: false,
      });
    expect(discovered()).toEqual([]);
    // Resolve while the owned file is absent: its later arrival must still be
    // admitted without letting ordinary tooling enter this standalone project.
    fs.writeFileSync(path.join(root, worker), "");
    expect(discovered()).toEqual([worker]);
  });

  it.each(["mixed", "docker", "isolated"])(
    "materializes only the exact selected %s tooling files",
    async (selection) => {
      const docker = toolingDockerTestFiles[0]!;
      const isolated = "test/scripts/upgrade-survivor-native-systemd.test.ts";
      const targets =
        selection === "mixed" ? [docker, isolated] : [selection === "docker" ? docker : isolated];
      const jobs = createSelectedNodeTestShardBundles(targets, { runnerBackend: "hybrid" });
      expect(jobs).not.toBeNull();
      const groups = jobs!.flatMap((job) => job.groups);
      expect(groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
        targets.toSorted(),
      );
      const memberships: string[] = [];
      const root = tempDirs.make("openclaw-selected-tooling-");
      for (const [index, group] of groups.entries()) {
        const includeFile = path.join(root, `include-${index}.json`);
        fs.writeFileSync(includeFile, JSON.stringify(group.includePatterns));
        for (const config of group.configs) {
          const createConfig = config.endsWith("/vitest.tooling-docker.config.ts")
            ? createToolingDockerVitestConfig
            : createToolingIsolatedVitestConfig;
          expect(config).toMatch(/\/vitest\.tooling-(?:docker|isolated)\.config\.ts$/u);
          const resolved = await resolveConfig(
            { config: false },
            createConfig({
              ...group.env,
              OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
            }),
          );
          const actual = globSync(resolved.test.include, {
            cwd: resolved.test.dir,
            ignore: resolved.test.exclude,
            dot: true,
            expandDirectories: false,
          });
          expect(actual).toEqual([
            createConfig === createToolingDockerVitestConfig ? docker : isolated,
          ]);
          memberships.push(...actual);
        }
      }
      expect(memberships.toSorted()).toEqual(targets.toSorted());
      expect(new Set(memberships).size).toBe(targets.length);
    },
  );

  it("keeps plugin source forks and native-loader forks on their own loaders", async () => {
    const testConfig = await requireTestConfig(defaultPluginsConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src", "plugins"));
    expect(testConfig.include).toEqual(["**/*.test.ts"]);
    expect(testConfig.exclude).toContain("contracts/**");
    const resolved = await resolveConfig({ config: false }, defaultPluginsConfig);
    const projects = resolved.test.resolvedProjects.map(({ projectConfig }) => projectConfig);
    expect(
      projects.map((project) => ({
        name: project.name,
        pool: project.pool,
        execArgv: project.execArgv,
      })),
    ).toEqual([
      {
        name: "plugins",
        pool: "forks",
        execArgv: [
          ...(process.versions.bun
            ? ["--tsconfig-override", path.join(process.cwd(), "tsconfig.json")]
            : ["--import", expect.any(String)]),
          process.versions.bun
            ? `--preload=${fileURLToPath(new URL("./vitest/vitest.jsdom-preload.mts", import.meta.url))}`
            : `--import=${new URL("./vitest/vitest.jsdom-preload.mts", import.meta.url).href}`,
        ],
      },
      {
        name: "plugins-native-loader",
        pool: "forks",
        execArgv: process.versions.bun ? ["--no-install"] : [],
      },
    ]);
    for (const file of [
      "loader.lazy-alias.test.ts",
      "plugin-module-loader-cache.source-prescan.test.ts",
      "plugin-sdk-native-resolver.test.ts",
      "sdk-alias.test.ts",
    ]) {
      expect(
        projects
          .filter(
            (project) =>
              project.include.some((pattern) => minimatch(file, pattern)) &&
              !project.exclude.some((pattern) => minimatch(file, pattern)),
          )
          .map((project) => project.name),
      ).toEqual(["plugins-native-loader"]);
    }
  });

  it("normalizes ui include patterns relative to the scoped dir", async () => {
    const testConfig = await requireTestConfig(defaultUiConfig);
    expect(testConfig.dir).toBe(process.cwd());
    const files = [
      ["ui/src/pages/chat/chat-view.test.ts", true],
      ["ui/src/components/form-controls.browser.test.ts", true],
      ["ui/src/components/markdown-mermaid.runtime.browser.test.ts", false],
      ["extensions/workboard/browser/catalog.test.ts", true],
      ["extensions/workboard/browser/native.browser.test.ts", false],
    ] as const;
    const tempDir = tempDirs.make("openclaw-ui-scoped-");
    for (const [file] of files) {
      const target = path.join(tempDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "");
    }
    const discovered = new Set(
      globSync(testConfig.include ?? [], {
        cwd: tempDir,
        dot: true,
        expandDirectories: false,
      }),
    );
    for (const [file, included] of files) {
      expect(discovered.has(file), file).toBe(included);
    }
    expect(testConfig.exclude).toContain("ui/src/**/*.e2e.test.ts");
    expect(testConfig.exclude).toContain("extensions/*/browser/**/*.e2e.test.ts");
  });
});
