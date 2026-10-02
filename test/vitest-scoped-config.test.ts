import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import { BUNDLED_PLUGIN_TEST_GLOB } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "vitest/node";
import { normalizeConfigPath } from "./helpers/vitest-config-paths.js";
import { createAgentsCoreIsolatedVitestConfig } from "./vitest/vitest.agents-core-isolated.config.ts";
import { createAgentsCoreVitestConfig } from "./vitest/vitest.agents-core.config.ts";
import { agentVitestProjectOwners } from "./vitest/vitest.agents-paths.mjs";
import { createAgentsSpawnProductionBoundaryVitestConfig } from "./vitest/vitest.agents-spawn-production-boundary.config.ts";
import { createAgentsVitestConfig } from "./vitest/vitest.agents.config.ts";
import { cliProcessTestFiles } from "./vitest/vitest.cli-process-paths.mjs";
import { createCliProcessVitestConfig } from "./vitest/vitest.cli-process.config.ts";
import { createCliVitestConfig } from "./vitest/vitest.cli.config.ts";
import { createCronVitestConfig } from "./vitest/vitest.cron.config.ts";
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
import { createInfraVitestConfig } from "./vitest/vitest.infra.config.ts";
import { createPluginsVitestConfig } from "./vitest/vitest.plugins.config.ts";
import { createRuntimeConfigVitestConfig } from "./vitest/vitest.runtime-config.config.ts";
import { createScopedVitestConfig } from "./vitest/vitest.scoped-config.ts";
import { sharedVitestConfig } from "./vitest/vitest.shared.config.ts";
import { toolingIsolatedTestFiles } from "./vitest/vitest.tooling-isolated-paths.mjs";
import { createToolingIsolatedVitestConfig } from "./vitest/vitest.tooling-isolated.config.ts";
import { createUiVitestConfig } from "./vitest/vitest.ui.config.ts";
import { isUnitFastTestFile } from "./vitest/vitest.unit-fast-paths.mjs";
import { createWizardVitestConfig } from "./vitest/vitest.wizard.config.ts";

const EXTENSIONS_CHANNEL_GLOB = ["extensions", "channel", "**"].join("/");

function matchingExcludePatterns(patterns: string[], file: string): string[] {
  return patterns.filter((pattern) => path.matchesGlob(file, pattern));
}

function requireTestConfig<T extends { test?: unknown }>(config: T): NonNullable<T["test"]> {
  if (!config.test) {
    throw new Error("expected scoped vitest test config");
  }
  return config.test as NonNullable<T["test"]>;
}

function expectDefaultIsolatedRunner(config: {
  test?: { pool?: unknown; isolate?: unknown; runner?: unknown };
}) {
  const testConfig = requireTestConfig(config);
  expect(testConfig.pool).toBe(process.platform === "win32" ? "forks" : "threads");
  expect(testConfig.isolate).toBe(true);
  expect(testConfig.runner).toBeUndefined();
}
function expectForkedNonIsolatedRunner(
  config: { test?: { pool?: unknown; isolate?: unknown; runner?: unknown } },
  pool: "forks" | typeof diagnosticForksPool = "forks",
) {
  const testConfig = requireTestConfig(config);
  expect(testConfig.pool).toBe(pool);
  expect(testConfig.isolate).toBe(false);
  expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
}

describe("createScopedVitestConfig", () => {
  it("narrows package CLI directories within their owner", () => {
    const config = createScopedVitestConfig(["packages/**/*.test.ts"], {
      argv: ["vitest", "run", "packages/normalization-core"],
      dir: "packages",
      env: {},
      passWithNoTests: true,
    });

    expect(requireTestConfig(config).include).toEqual(["normalization-core/**/*.test.ts"]);
  });

  it("relativizes scoped include and exclude patterns to the configured dir", () => {
    const config = createScopedVitestConfig([BUNDLED_PLUGIN_TEST_GLOB], {
      dir: "extensions",
      env: {},
      exclude: [EXTENSIONS_CHANNEL_GLOB, "dist/**"],
    });
    const testConfig = requireTestConfig(config);

    expect(testConfig.include).toEqual(["**/*.test.ts"]);
    expect(testConfig.exclude).toContain("channel/**");
    expect(testConfig.exclude).toContain("dist/**");
  });

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
  ])("$title", ({ includePattern, target, expectedInclude }) => {
    const config = createScopedVitestConfig([includePattern], {
      argv: ["node", "vitest", "run", target],
      dir: "extensions",
      env: {},
    });
    const testConfig = requireTestConfig(config);

    expect(testConfig.include).toEqual([expectedInclude]);
    expect(testConfig.passWithNoTests).toBeUndefined();
  });

  it("does not narrow scoped includes for coverage option values", () => {
    const config = createScopedVitestConfig(["extensions/codex/**/*.test.ts"], {
      argv: ["node", "vitest", "run", "--coverage.include", "codex/src/app-server/client.ts"],
      dir: "extensions",
      env: {},
    });
    const testConfig = requireTestConfig(config);

    expect(testConfig.include).toEqual(["codex/**/*.test.ts"]);
    expect(testConfig.passWithNoTests).toBeUndefined();
  });

  it("does not narrow scoped includes for exclude option values", () => {
    const config = createScopedVitestConfig(["extensions/codex/**/*.test.ts"], {
      argv: ["node", "vitest", "run", "--exclude", "codex/src/app-server/run-attempt.test.ts"],
      dir: "extensions",
      env: {},
    });
    const testConfig = requireTestConfig(config);

    expect(testConfig.include).toEqual(["codex/**/*.test.ts"]);
    expect(testConfig.passWithNoTests).toBeUndefined();
  });

  it("lets root Vitest project runs skip scoped files owned by unit-fast", () => {
    const config = createScopedVitestConfig(["src/acp/**/*.test.ts"], {
      argv: ["node", "vitest", "run", "src/acp/client.test.ts"],
      dir: "src/acp",
      env: {},
    });
    const testConfig = requireTestConfig(config);

    expect(testConfig.include).toEqual(["client.test.ts"]);
    expect(testConfig.passWithNoTests).toBe(true);
  });

  it("lets unrelated root Vitest projects skip when CLI filters match no scoped files", () => {
    const config = createScopedVitestConfig(["extensions/**/*.test.ts"], {
      argv: ["node", "vitest", "run", "src/config/channel-configured.test.ts"],
      dir: "extensions",
      env: {},
    });
    const testConfig = requireTestConfig(config);

    expect(testConfig.include).toEqual([]);
    expect(testConfig.passWithNoTests).toBe(true);
  });

  it("intersects a watch-mode directory target with project ownership", () => {
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

      expect(requireTestConfig(config).include).toEqual(["**/*server*.test.ts"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps shared gateway include files inside their actual child projects", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vitest-scoped-"));
    try {
      const includeFile = path.join(tempDir, "include.json");
      fs.writeFileSync(
        includeFile,
        JSON.stringify(["src/gateway/server.node-pairing-ssh-verify.test.ts"]),
        "utf8",
      );
      const env = { OPENCLAW_VITEST_INCLUDE_FILE: includeFile };

      expect(requireTestConfig(createGatewayServerVitestConfig(env)).include).toEqual([
        "server.node-pairing-ssh-verify.test.ts",
      ]);
      const coreConfig = requireTestConfig(createGatewayCoreVitestConfig(env));
      expect(coreConfig.include).toEqual(["server.node-pairing-ssh-verify.test.ts"]);
      expect(coreConfig.passWithNoTests).toBe(true);
      const clientConfig = requireTestConfig(createGatewayClientVitestConfig(env));
      expect(clientConfig.include).toEqual([]);
      expect(clientConfig.passWithNoTests).toBe(true);
      const methodsConfig = requireTestConfig(createGatewayMethodsVitestConfig(env));
      expect(methodsConfig.include).toEqual([]);
      expect(methodsConfig.passWithNoTests).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("scoped vitest configs", () => {
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

  it("keeps source-child process tests in the isolated process project", () => {
    const cliProcessFiles = cliProcessTestFiles.filter((file) => file.startsWith("src/cli/"));
    expect(requireTestConfig(defaultCliConfig).exclude).toEqual(
      expect.arrayContaining(cliProcessFiles.map((file) => file.replace("src/cli/", ""))),
    );
    const processTestConfig = requireTestConfig(defaultCliProcessConfig);
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

  it("keeps native SQLite runtime config tests in forked workers", () => {
    expectForkedNonIsolatedRunner(defaultRuntimeConfig);
  });

  it("keeps agents lanes on the shared worker schedule", () => {
    const maxWorkers = 8;
    const original = sharedVitestConfig.test;
    try {
      sharedVitestConfig.test = { ...original, maxWorkers, fileParallelism: maxWorkers > 1 };
      for (const createConfig of [createAgentsVitestConfig, createAgentsCoreVitestConfig]) {
        expect(requireTestConfig(createConfig({}))).toMatchObject({
          maxWorkers,
          fileParallelism: maxWorkers > 1,
        });
      }
    } finally {
      sharedVitestConfig.test = original;
    }
  });

  it("isolates agent suites with conflicting shared-module mocks", () => {
    const sharedConfig = requireTestConfig(defaultAgentsCoreConfig);
    const isolatedConfig = requireTestConfig(defaultAgentsCoreIsolatedConfig);
    const productionBoundaryConfig = requireTestConfig(defaultAgentsSpawnProductionBoundaryConfig);

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

  it("isolates Telegram extension mocks while inheriting file scheduling", () => {
    expectDefaultIsolatedRunner(defaultExtensionTelegramConfig);
    expect(requireTestConfig(defaultExtensionTelegramConfig).fileParallelism).toBe(
      sharedVitestConfig.test.fileParallelism,
    );
  });

  it("keeps infra and database worker consumers rooted at the repository", () => {
    const testConfig = requireTestConfig(defaultInfraConfig);
    expect(testConfig.pool).toBe(diagnosticForksPool);
    expect(testConfig.isolate).toBe(true);
    expect(testConfig.runner).toBeUndefined();
    expect(testConfig.dir).toBe(process.cwd());
    expect(testConfig.include).toEqual(["src/infra/**/*.test.ts", ...databaseWorkerCoreTestFiles]);
    const recoveryFile = "src/wizard/setup.inference-recovery.integration.test.ts";
    expect(testConfig.include?.filter((file) => file === recoveryFile)).toEqual([recoveryFile]);
    expect(requireTestConfig(defaultWizardConfig).exclude).toContain(
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
      existing: "src/agents/memory-write-provenance.test.ts",
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

        fs.writeFileSync(includeFile, JSON.stringify([existing]));
        const narrowed = createDatabaseWorkerWatchVitestConfig(
          createOwner(env),
          workerFiles.filter((file) => file.startsWith(`${root}/`)),
          env,
        );
        const narrowedConfig = await resolveConfig({ config: false }, narrowed);
        const workerProject = narrowedConfig.test.resolvedProjects[1]?.projectConfig;
        expect(workerProject?.include).toEqual([
          path.relative(workerProject!.dir, path.resolve(existing)),
        ]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps cron scoped while honoring shared workers", () => {
    const maxWorkers = 8;
    const original = sharedVitestConfig.test;
    try {
      sharedVitestConfig.test = {
        ...original,
        maxWorkers,
        fileParallelism: maxWorkers > 1,
      };
      const config = createCronVitestConfig({});
      const testConfig = requireTestConfig(config);
      expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
      expect(testConfig.include).toEqual(["cron/**/*.test.ts"]);
      expectForkedNonIsolatedRunner(config);
      expect(testConfig.maxWorkers).toBe(maxWorkers);
      expect(testConfig.fileParallelism).toBe(maxWorkers > 1);
    } finally {
      sharedVitestConfig.test = original;
    }
  });

  it("runs state-sensitive tooling tests isolated from shared mocks", () => {
    const testConfig = requireTestConfig(createToolingIsolatedVitestConfig({}));
    expect(testConfig.include).toEqual(toolingIsolatedTestFiles);
    expect(testConfig.isolate).toBe(true);
    expect(testConfig.runner).toBeUndefined();
  });

  it("keeps plugin source forks and native-loader forks on their own loaders", async () => {
    const testConfig = requireTestConfig(defaultPluginsConfig);
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
          `--import=${new URL("./vitest/vitest.jsdom-preload.mts", import.meta.url).href}`,
        ],
      },
      {
        name: "plugins-native-loader",
        pool: "forks",
        execArgv: process.versions.bun ? ["--no-install"] : [],
      },
    ]);
    for (const file of ["loader.lazy-alias.test.ts", "plugin-sdk-native-resolver.test.ts"]) {
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

  it("normalizes ui include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultUiConfig);
    expect(testConfig.dir).toBe(process.cwd());
    for (const [file, included] of [
      ["ui/src/pages/chat/chat-view.test.ts", true],
      ["ui/src/components/form-controls.browser.test.ts", true],
      ["ui/src/components/markdown-mermaid.runtime.browser.test.ts", false],
      ["extensions/workboard/browser/catalog.test.ts", true],
      ["extensions/workboard/browser/native.browser.test.ts", false],
    ] as const) {
      expect(
        testConfig.include?.some((pattern) => minimatch(file, pattern)),
        file,
      ).toBe(included);
    }
    expect(testConfig.exclude).toContain("ui/src/**/*.e2e.test.ts");
    expect(testConfig.exclude).toContain("extensions/*/browser/**/*.e2e.test.ts");
  });
});
