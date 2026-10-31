import { globSync } from "node:fs";
import path from "node:path";
import { afterEach, assert, describe, expect, it } from "vitest";
import { resolveConfig } from "vitest/node";
import { resolveExtensionTestConfig } from "../scripts/lib/extension-test-plan.mts";
import { buildVitestRunPlans } from "../scripts/test-projects.test-support.mts";
import { withEnv } from "../src/test-utils/env.js";
import { spawnNodeEvalSync } from "../src/test-utils/node-process.js";
import { createPatternFileHelper } from "./helpers/pattern-file.js";
import { normalizeConfigPath, normalizeConfigPaths } from "./helpers/vitest-config-paths.js";
import { auditFullSuiteTestFileOwnership } from "./vitest-projects-config.test-support.js";
import { createAgentsSupportVitestConfig } from "./vitest/vitest.agents-support.config.ts";
import bundledConfig from "./vitest/vitest.bundled.config.ts";
import baseConfig from "./vitest/vitest.config.ts";
import contractChannelConfigConfig from "./vitest/vitest.contracts-channel-config.config.ts";
import contractChannelRegistryConfig from "./vitest/vitest.contracts-channel-registry.config.ts";
import contractChannelSessionConfig from "./vitest/vitest.contracts-channel-session.config.ts";
import contractChannelSurfaceConfig from "./vitest/vitest.contracts-channel-surface.config.ts";
import contractPluginConfig from "./vitest/vitest.contracts-plugin.config.ts";
import { createExtensionDatabaseWorkersVitestConfig } from "./vitest/vitest.extension-database-workers.config.ts";
import { createExtensionImessageVitestConfig } from "./vitest/vitest.extension-imessage.config.ts";
import { createExtensionsVitestConfig } from "./vitest/vitest.extensions.config.ts";
import { diagnosticForksPool } from "./vitest/vitest.forks-pool.ts";
import { createGatewayMethodsIsolatedVitestConfig } from "./vitest/vitest.gateway-methods-isolated.config.ts";
import { createGatewayMethodsVitestConfig } from "./vitest/vitest.gateway-methods.config.ts";
import { createGatewayServerIsolatedVitestConfig } from "./vitest/vitest.gateway-server-isolated.config.ts";
import {
  gatewayDatabaseWorkerTestFiles,
  gatewayMethodsIsolatedTestFiles,
  gatewayServerIsolatedTestFiles,
} from "./vitest/vitest.gateway-server-paths.mjs";
import { createGatewayServerVitestConfig } from "./vitest/vitest.gateway-server.config.ts";
import {
  createGatewayProjectShardVitestConfig,
  createGatewayVitestConfig,
} from "./vitest/vitest.gateway.config.ts";
import liveConfig from "./vitest/vitest.live.config.ts";
import { createProjectShardVitestConfig } from "./vitest/vitest.project-shard-config.ts";
import {
  repoRoot,
  resolveSharedVitestWorkerConfig,
  sharedVitestConfig,
} from "./vitest/vitest.shared.config.ts";
import { fullSuiteVitestShards } from "./vitest/vitest.test-shards.mjs";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "./vitest/vitest.timeouts.ts";
import { uiIsolatedTestFiles } from "./vitest/vitest.ui-isolated-paths.mjs";
import { createUiVitestConfig } from "./vitest/vitest.ui.config.ts";
import { createUnitFastFakeTimersVitestConfig } from "./vitest/vitest.unit-fast-fake-timers.config.ts";
import { createUnitFastIsolatedVitestConfig } from "./vitest/vitest.unit-fast-isolated.config.ts";
import unitFastRootConfig from "./vitest/vitest.unit-fast-root.config.ts";
import { createUnitFastVitestConfig } from "./vitest/vitest.unit-fast.config.ts";

const defaultPool = process.platform === "win32" ? "forks" : "threads";
const patternFiles = createPatternFileHelper("openclaw-vitest-projects-config-");
const scopedGatewayMethodsIsolatedTestFiles = `chat-metadata-runtime.cache agent
  agent.followup-owner agent.visitor-access board.runtime-boundaries chat.reset-visible-yield
  environments.pairing-snapshot health.owner-routing sessions.send-yield-resume
  system-agent-nested-inference.integration system-agent-setup-control-ui transcripts
  users-preferences users-role.worker usage usage.sessions-usage`
  .split(/\s+/u)
  .map((name) => `server-methods/${name}.test.ts`);

function requireTestConfig<T extends { test?: unknown }>(config: T): NonNullable<T["test"]> {
  assert(config.test, "expected vitest test config");
  return config.test;
}
const configFor = (
  create: typeof createGatewayMethodsVitestConfig,
  env: Record<string, string | undefined> = {},
) => requireTestConfig(create(env));
const includeEnv = (files: readonly string[]) => ({
  OPENCLAW_VITEST_INCLUDE_FILE: patternFiles.writePatternFile("include.json", files),
});
const ownersFor = (target: string) => buildVitestRunPlans([target]).map((plan) => plan.config);

const rootVitestProjects = requireTestConfig(baseConfig).projects as string[];

afterEach(() => patternFiles.cleanup());

function runConfigScript(source: string) {
  const result = spawnNodeEvalSync(source, {
    imports: ["./scripts/tsx.mjs"],
    env: { ...process.env, GITHUB_ACTIONS: "true", OPENCLAW_VITEST_INCLUDE_FILE: undefined },
    timeout: DEFAULT_VITEST_TEST_TIMEOUT_MS,
  });
  const output = JSON.stringify({ stdout: result.stdout, stderr: result.stderr });
  expect([result.error, result.signal, result.status], output).toEqual([undefined, null, 0]);
}

describe("projects vitest config", () => {
  it("pins an explicit full-suite project worker limit", () => {
    withEnv({ OPENCLAW_VITEST_MAX_WORKERS: "8" }, () => {
      const config = requireTestConfig(
        createProjectShardVitestConfig(["test/vitest/vitest.tooling.config.ts"], { maxWorkers: 1 }),
      );
      expect(config).toMatchObject({ maxWorkers: 1, fileParallelism: false });
      expect(process.env.OPENCLAW_VITEST_MAX_WORKERS).toBe("1");
    });
  });

  it("keeps the resolved root and generated projects in their explicit environments", () => {
    runConfigScript(
      `
        import assert from "node:assert/strict";
        import { resolveConfig } from "vitest/node";
        import rootConfig from "./vitest.config.ts";
        import { sharedVitestConfig } from "./test/vitest/vitest.shared.config.ts";
        // File ownership is audited separately; resolve every project with bounded discovery.
        process.argv = [process.execPath, "vitest", "test/vitest-projects-config.test.ts"];
        const resolved = await resolveConfig({ config: false }, rootConfig);
        const generated = await resolveConfig({ config: false }, {
          plugins: sharedVitestConfig.plugins,
          test: {
            projects: [undefined, "jsdom", "happy-dom"].map(environment => ({
              extends: false,
              plugins: sharedVitestConfig.plugins,
              test: {
                name: environment ? "ui-" + environment : "generated-node",
                ...(environment ? { environment } : {}),
              },
            })),
          },
        });
        const projects = [resolved.test, generated.test].flatMap(test => [
          test,
          ...test.resolvedProjects.map(({ projectConfig }) => projectConfig),
        ]);
        for (const project of projects) {
          if (!/^ui(?:-|$)/u.test(project.name ?? "")) {
            assert.equal(project.environment, "node", project.name || "root");
          }
        }
        assert.deepEqual(
          generated.test.resolvedProjects.map(({ projectConfig }) => projectConfig.environment),
          ["node", "jsdom", "happy-dom"],
        );
        assert.ok(resolved.test.resolvedProjects.length > 0, "root projects must resolve");
      `,
    );
  });

  it.each(["all", "worker", "mixed"] as const)(
    "preserves Gateway fallback coverage for %s selection",
    async (selection) => {
      const [workerFile] = gatewayDatabaseWorkerTestFiles;
      assert(workerFile);
      const ordinaryFile = "src/gateway/config-reload.telegram-policy.test.ts";
      const selected = selection === "worker" ? [workerFile] : [workerFile, ordinaryFile];
      const env = {
        OPENCLAW_GATEWAY_PROJECT_SHARDS: "0",
        OPENCLAW_VITEST_INCLUDE_FILE:
          selection === "all"
            ? undefined
            : patternFiles.writePatternFile("gateway-fallback-include.json", selected),
      };
      const resolved = await resolveConfig(
        { config: false },
        createGatewayProjectShardVitestConfig(env),
      );
      const projects = resolved.test.resolvedProjects.map(({ projectConfig }) => projectConfig);
      expect(projects.map((project) => project.name)).toEqual([
        "gateway",
        "gateway-database-workers",
      ]);
      expect(projects.map((project) => project.pool)).toEqual(["forks", "forks"]);
      const original = configFor(createGatewayVitestConfig, env);
      expect(original.pool).toBe(defaultPool);
      for (const project of projects) {
        expect(project).toMatchObject({ runner: original.runner, setupFiles: original.setupFiles });
      }
      const filesByProject = projects.map((project) => {
        const exclude = project.exclude.map((pattern) =>
          path.isAbsolute(pattern) ? path.relative(project.dir, pattern) : pattern,
        );
        return globSync(project.include, { cwd: project.dir, exclude }).map((file) =>
          path.relative(repoRoot, path.join(project.dir, file)).replaceAll("\\", "/"),
        );
      });
      const files = filesByProject.flat();
      expect(new Set(files).size).toBe(files.length);
      expect(filesByProject[1]?.toSorted()).toEqual(
        (selection === "all" ? gatewayDatabaseWorkerTestFiles : [workerFile]).toSorted(),
      );
      if (selection === "all") {
        expect(filesByProject[0]).toContain(ordinaryFile);
      } else {
        expect(files.toSorted()).toEqual(selected.toSorted());
      }
    },
  );

  it("keeps Gateway tests needing native process state or module isolation in every aggregate", () => {
    const methodsIsolatedProject = "test/vitest/vitest.gateway-methods-isolated.config.ts";
    const serverIsolatedProject = "test/vitest/vitest.gateway-server-isolated.config.ts";
    const agenticShard = fullSuiteVitestShards.find((shard) => shard.name === "agentic");
    const methodsConfig = configFor(createGatewayMethodsVitestConfig);
    const methodsIsolatedConfig = configFor(createGatewayMethodsIsolatedVitestConfig);
    const serverIsolatedConfig = configFor(createGatewayServerIsolatedVitestConfig);
    const serverConfig = configFor(createGatewayServerVitestConfig, {
      OPENCLAW_VITEST_MAX_WORKERS: "2",
    });
    const gatewayFallback = configFor(createGatewayVitestConfig, process.env);

    for (const project of [methodsIsolatedProject, serverIsolatedProject]) {
      expect(rootVitestProjects).toContain(project);
      expect(agenticShard?.projects).toContain(project);
    }
    expect(methodsIsolatedConfig).toMatchObject({ isolate: true, pool: "forks" });
    expect(normalizeConfigPath(methodsIsolatedConfig.runner)).toBe("test/non-isolated-runner.ts");
    expect(methodsIsolatedConfig.include).toEqual(scopedGatewayMethodsIsolatedTestFiles);
    expect(serverConfig).toMatchObject({ pool: "forks", isolate: false, fileParallelism: true });
    expect(
      configFor(createGatewayServerVitestConfig, { OPENCLAW_VITEST_MAX_WORKERS: "1" })
        .fileParallelism,
    ).toBe(false);
    expect(serverIsolatedConfig).toMatchObject({ isolate: true, pool: "forks", runner: undefined });
    expect(serverIsolatedConfig.include).toEqual(gatewayServerIsolatedTestFiles);
    const overrideFixture = "src/gateway/server-plugin-subagent-runtime.overrides.test.ts";
    expect(serverIsolatedConfig.include).toContain(overrideFixture);
    expect(serverConfig.exclude).toContain("server-plugin-subagent-runtime.overrides.test.ts");
    expect(gatewayFallback.exclude).toContain(overrideFixture);
    for (const file of [
      "agent",
      "health.owner-routing",
      "board.runtime-boundaries",
      "chat.reset-visible-yield",
      "system-agent-setup-control-ui",
    ]) {
      const target = `src/gateway/server-methods/${file}.test.ts`;
      expect(methodsConfig.exclude).toContain(target);
      expect(gatewayFallback.exclude).toContain(target);
    }
    expect(gatewayFallback.exclude).toContain(
      "src/gateway/server.sessions.compaction-read-errors.test.ts",
    );
  });

  it.each([
    [
      "Gateway methods",
      createGatewayMethodsIsolatedVitestConfig,
      gatewayMethodsIsolatedTestFiles,
      scopedGatewayMethodsIsolatedTestFiles,
    ],
    ["Gateway server", createGatewayServerIsolatedVitestConfig, gatewayServerIsolatedTestFiles],
    ["ordinary unit-fast", createUnitFastVitestConfig, ["src/plugin-sdk/text-chunking.test.ts"]],
    [
      "isolated unit-fast",
      createUnitFastIsolatedVitestConfig,
      ["src/system-agent/assistant.configured.test.ts"],
    ],
    ["fake-timer unit-fast", createUnitFastFakeTimersVitestConfig, ["src/utils.test.ts"]],
  ] as const)(
    "limits %s include files to the project's owned tests",
    (_, createConfig, owned, expected?: readonly string[]) => {
      const unrelated = "src/gateway/worker-environments/workspace-sync-scripts.test.ts";
      const mixed = includeEnv([
        ...owned,
        "src/plugin-sdk/text-chunking.test.ts",
        "src/system-agent/assistant.configured.test.ts",
        "src/utils.test.ts",
        "src/gateway/openresponses-http.test.ts",
        unrelated,
      ]);
      expect(configFor(createConfig, mixed).include).toEqual(expected ?? owned);
      expect(configFor(createConfig, includeEnv([unrelated])).include).toEqual([]);
    },
  );

  it("covers each normal full-suite test file exactly once after configs cached filtered includes", async () => {
    const contractTestConfigs = [
      contractChannelSurfaceConfig,
      contractChannelConfigConfig,
      contractChannelRegistryConfig,
      contractChannelSessionConfig,
      contractPluginConfig,
    ].map(requireTestConfig);
    const previousIncludes = contractTestConfigs.map((config) => config.include);

    try {
      // A CLI path outside the contract patterns caches these defaults with empty includes.
      for (const config of contractTestConfigs) {
        config.include = [];
      }

      const { missing, duplicated } = await auditFullSuiteTestFileOwnership();

      expect({ missing, duplicated }).toStrictEqual({ missing: [], duplicated: [] });
    } finally {
      contractTestConfigs.forEach((config, index) => {
        const previousInclude = previousIncludes[index];
        if (previousInclude === undefined) {
          delete config.include;
        } else {
          config.include = previousInclude;
        }
      });
    }
  });

  it("keeps shared roots explicit and disables vite env-file loading", () => {
    expect(sharedVitestConfig).toMatchObject({
      root: repoRoot,
      test: { root: repoRoot },
      envDir: false,
    });
    expect(baseConfig.envDir).toBe(false);
  });

  it("uses absolute force-rerun triggers for discovered vitest lane and preload files", () => {
    const triggers = sharedVitestConfig.test.forceRerunTriggers.map(normalizeConfigPath);
    expect(triggers).toEqual(
      expect.arrayContaining(
        ["vitest.config.ts", "vitest.sqlite-preload.mts"].map((file) =>
          normalizeConfigPath(`${process.cwd()}/test/vitest/${file}`),
        ),
      ),
    );
  });

  it.each([
    [false, true, "1", 1, false, 1, false],
    [false, true, undefined, 1, false, 3, true],
    [true, true, "4", 4, true, 4, true],
    [true, true, undefined, 4, true, 2, true],
    [true, false, undefined, 4, true, 4, true],
  ] as const)(
    "preserves worker policy: Windows=%s CI=%s override=%s",
    (isWindows, isCI, override, localWorkers, parallel, expectedWorkers, expectedParallel) => {
      expect(
        resolveSharedVitestWorkerConfig({
          env: { CI: isCI ? "true" : undefined, OPENCLAW_VITEST_MAX_WORKERS: override },
          isCI,
          isWindows,
          localScheduling: {
            fileParallelism: parallel,
            maxWorkers: localWorkers,
            throttledBySystem: false,
          },
        }),
      ).toEqual({
        pool: isWindows ? "forks" : "threads",
        fileParallelism: expectedParallel,
        maxWorkers: expectedWorkers,
      });
    },
  );

  it("preserves public contract command coverage across include filters", () => {
    const scenarios = [
      [
        "channels",
        ["", "session-binding.registry-backed.contract", "session-key-artifact.contract"],
      ],
      ["plugins", ["", "host-hook-state.identity", "host-hooks.contract"]],
    ] as const;
    const selections = scenarios.flatMap(([family, names]) =>
      names.map((name) => ({
        family,
        includeFile: name
          ? includeEnv([
              `src/${family === "channels" ? "channels/plugins" : "plugins"}/contracts/${name}.test.ts`,
            ]).OPENCLAW_VITEST_INCLUDE_FILE
          : undefined,
      })),
    );
    // Keep real CLI/config resolution, but pay for its isolated process only once.
    runConfigScript(
      `
        import assert from "node:assert/strict";
        import { globSync, readFileSync, rmSync } from "node:fs";
        import path from "node:path";
        import { parseCLI, resolveConfig } from "vitest/node";
        import { createVitestRunSpecs, writeVitestIncludeFile } from "./scripts/test-projects.test-support.mts";
        const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
        for (const { family, includeFile } of ${JSON.stringify(selections)}) {
          if (includeFile === undefined) {
            delete process.env.OPENCLAW_VITEST_INCLUDE_FILE;
          } else {
            process.env.OPENCLAW_VITEST_INCLUDE_FILE = includeFile;
          }
          const command = scripts["test:contracts:" + family];
          const argv = command.split(/\\s+/u);
          const wrapper = argv.indexOf("scripts/test-projects.mts");
          assert.notEqual(wrapper, -1);
          const specs = createVitestRunSpecs(argv.slice(wrapper + 1));
          const matches = [];
          for (const spec of specs) {
            try {
              if (spec.includeFilePath) {
                writeVitestIncludeFile(spec.includeFilePath, spec.includePatterns);
              }
              if (spec.env.OPENCLAW_VITEST_INCLUDE_FILE === undefined) {
                delete process.env.OPENCLAW_VITEST_INCLUDE_FILE;
              } else {
                process.env.OPENCLAW_VITEST_INCLUDE_FILE = spec.env.OPENCLAW_VITEST_INCLUDE_FILE;
              }
              const { options } = parseCLI(["vitest", ...spec.pnpmArgs.slice(spec.pnpmArgs.indexOf("run"))]);
              const resolved = await resolveConfig(options);
              for (const { projectConfig } of resolved.test.resolvedProjects) {
                for (const file of globSync(projectConfig.include, { cwd: projectConfig.dir, exclude: projectConfig.exclude })) {
                  const relative = path.relative(process.cwd(), path.resolve(projectConfig.dir, file)).replaceAll("\\\\", "/");
                  matches.push(relative);
                  if (relative.endsWith("/session-binding.registry-backed.contract.test.ts")) {
                    assert.equal(projectConfig.pool, "forks");
                    assert.equal(projectConfig.maxWorkers, 1);
                  }
                  if (relative === "src/plugins/contracts/host-hook-state.identity.test.ts" || relative === "src/plugins/contracts/host-hooks.contract.test.ts") {
                    assert.equal(projectConfig.isolate, true);
                    assert.equal(projectConfig.name, "infra");
                  }
                }
              }
            } finally {
              if (spec.includeFilePath) rmSync(spec.includeFilePath);
            }
          }
          const filters = includeFile ? JSON.parse(readFileSync(includeFile, "utf8")) : null;
          const root = family === "channels" ? "src/channels/plugins/contracts" : "src/plugins/contracts";
          const expected = globSync(root + "/**/*.test.ts")
            .map(file => file.replaceAll("\\\\", "/"))
            .filter(file => !filters || filters.some(filter => path.matchesGlob(file, filter)));
          assert.deepEqual(matches.toSorted(), expected.toSorted(), family + ": " + (includeFile ?? "all"));
          assert.equal(new Set(matches).size, matches.length);
        }
      `,
    );
  });

  it("keeps shared and isolated UI owners together in root and full runtime runs", () => {
    for (const projects of [
      rootVitestProjects,
      fullSuiteVitestShards.find((shard) => shard.name === "core-runtime")?.projects ?? [],
    ]) {
      for (const config of [
        "vitest.ui.config.ts",
        "vitest.ui-isolated.config.ts",
        "vitest.ui-timing.config.ts",
      ]) {
        expect(projects.filter((project) => project === `test/vitest/${config}`)).toHaveLength(1);
      }
    }
    const testConfig = configFor(createUiVitestConfig, process.env);
    expect(testConfig.exclude).toEqual(expect.arrayContaining(uiIsolatedTestFiles));
    expect(testConfig).toMatchObject({ environment: "jsdom", isolate: false });
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
    const setupFiles = normalizeConfigPaths(testConfig.setupFiles);
    expect(setupFiles).not.toContain("test/setup-openclaw-runtime.ts");
    expect(setupFiles).toContain("ui/src/test-helpers/dom.setup.ts");
  });

  it("keeps root-matrix unit-fast files on the cross-file cleanup runner", () => {
    const testConfig = requireTestConfig(unitFastRootConfig);
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
    expect(rootVitestProjects).toContain("test/vitest/vitest.unit-fast-root.config.ts");
    expect(rootVitestProjects).not.toContain("test/vitest/vitest.unit-fast.config.ts");
  });

  it.each(["logbook", "memory-core", "team-reports", "workboard"])(
    "runs %s database owners in main-thread hosts across focused and full suites",
    (pluginId) => {
      const project = "test/vitest/vitest.extension-database-workers.config.ts";
      const testConfig = configFor(createExtensionDatabaseWorkersVitestConfig);
      expect(resolveExtensionTestConfig(`extensions/${pluginId}`)).toBe(project);
      expect(ownersFor(`extensions/${pluginId}/src/store.test.ts`)).toEqual([project]);
      expect(rootVitestProjects).toContain(project);
      expect(
        fullSuiteVitestShards.find((shard) => shard.name === "extensions")?.projects,
      ).toContain(project);
      expect(testConfig.pool).toBe(diagnosticForksPool);
      expect(testConfig.isolate).toBe(true);
      expect(testConfig.include).toContain(`${pluginId}/**/*.test.ts`);
      expect(configFor(createExtensionsVitestConfig).exclude).toContain(`${pluginId}/**`);
    },
  );

  it.each([
    {
      file: "approval-reactions.persistence.test.ts",
      source: "approval-reactions.ts",
      siblings: ["approval-reaction-poller.test.ts"],
    },
    {
      file: "send.sqlite.test.ts",
      source: "send.ts",
      siblings: ["outbound-tool-trace-sanitize.test.ts"],
    },
    { file: "send.test.ts", source: "send.ts", siblings: ["outbound-tool-trace-sanitize.test.ts"] },
  ])(
    "routes iMessage $file through its worker owner without moving sibling tests",
    ({ file: basename, source, siblings }) => {
      const file = `extensions/imessage/src/${basename}`;
      const project = "test/vitest/vitest.extension-database-workers.config.ts";
      const siblingProject = "test/vitest/vitest.extension-imessage.config.ts";
      for (const target of [
        file,
        "extensions/imessage",
        "extensions/imessage/src/*.test.ts",
        `extensions/imessage/src/${source}`,
      ]) {
        const plans = buildVitestRunPlans([target]);
        expect(plans.find((plan) => plan.config === project)?.includePatterns).toContain(file);
      }
      expect(ownersFor(file)).toEqual([project]);
      for (const sibling of siblings) {
        expect(ownersFor(`extensions/imessage/src/${sibling}`)).toEqual([siblingProject]);
      }
      const workerConfig = configFor(createExtensionDatabaseWorkersVitestConfig);
      expect(workerConfig.include).toContain(`imessage/src/${basename}`);
      expect(workerConfig.pool).toBe(diagnosticForksPool);
      expect(workerConfig.isolate).toBe(true);
      expect(configFor(createExtensionImessageVitestConfig).exclude).toContain(
        `imessage/src/${basename}`,
      );
      expect(configFor(createExtensionsVitestConfig).exclude).toContain(`imessage/src/${basename}`);
    },
  );

  it.each([
    ["agents-support cleanup", createAgentsSupportVitestConfig, {}],
    ["live Gateway admission", () => liveConfig, { maxWorkers: 1 }],
    [
      "bundled broker",
      () => bundledConfig,
      {
        isolate: false,
        runner: "test/non-isolated-runner.ts",
      },
    ],
  ] as const)("keeps %s on its fork policy", (_, create, expected) => {
    const config = configFor(create, process.env);
    expect({ ...config, runner: normalizeConfigPath(config.runner) }).toMatchObject({
      pool: "forks",
      ...expected,
    });
  });
});
