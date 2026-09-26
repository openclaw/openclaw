// Vitest UI package config tests validate UI package test project settings.
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserProviderOption } from "vitest/node";
import { resolveCiTestRuntimeSelections } from "../scripts/lib/ci-test-runtime.mts";
import { buildVitestRunPlans } from "../scripts/test-projects.test-support.mts";
import uiConfig from "../ui/vitest.config.ts";
import uiNodeConfig from "../ui/vitest.node.config.ts";
import { createFixtureLifetime } from "./helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { normalizeConfigPath } from "./helpers/vitest-config-paths.js";
import { runVitestShutdownCommand } from "./helpers/vitest-shutdown-command.js";
import { loadVitestPerformanceConfig } from "./vitest/vitest.performance-config.ts";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "./vitest/vitest.timeouts.ts";
import { createUiIsolatedVitestConfig } from "./vitest/vitest.ui-isolated.config.ts";
import { uiTimingTestFiles } from "./vitest/vitest.ui-paths.mjs";
import { createUiTimingVitestConfig } from "./vitest/vitest.ui-timing.config.ts";
import { createUiVitestConfig } from "./vitest/vitest.ui.config.ts";

type ExpectedTestConfig = ReturnType<typeof loadVitestPerformanceConfig> & {
  include?: string[];
  exclude?: string[];
  browser?: { enabled?: boolean; provider?: BrowserProviderOption };
  clearMocks?: boolean;
  isolate?: boolean;
  name?: string;
  maxWorkers?: number;
  pool?: string;
  projects?: unknown[];
  runner?: string;
  setupFiles?: string[];
  sequence?: { groupOrder?: number };
};

function requireTestConfig(config: unknown): ExpectedTestConfig {
  if (!config || typeof config !== "object" || !("test" in config) || !config.test) {
    throw new Error("expected ui package vitest test config");
  }
  return config.test as ExpectedTestConfig;
}

function requireAlias(config: unknown, specifier: string): { find: string; replacement: string } {
  const aliases = (config as { resolve?: { alias?: unknown } }).resolve?.alias;
  if (!Array.isArray(aliases)) {
    throw new Error("expected ui package vitest aliases");
  }
  const alias = aliases.find((candidate): candidate is { find: string; replacement: string } =>
    Boolean(
      candidate &&
      typeof candidate === "object" &&
      "find" in candidate &&
      candidate.find === specifier &&
      "replacement" in candidate &&
      typeof candidate.replacement === "string",
    ),
  );
  if (!alias) {
    throw new Error(`missing ui package vitest alias ${specifier}`);
  }
  return alias;
}

describe("ui package vitest config", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const fixture = createFixtureLifetime();
  afterEach(async () => {
    await fixture.cleanup();
    vi.unstubAllEnvs();
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("routes the standalone UI config through the canonical group executor", () => {
    expect(buildVitestRunPlans(["ui/vitest.config.ts"])).toEqual([
      {
        config: "ui/vitest.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("partitions runtimes after native UI sharding without changing ownership or dropping files", ({
    signal,
  }) =>
    fixture.run(async () => {
      signal.throwIfAborted();
      const root = fixture.createTempDir("ui-runtime-partition-");
      const output = path.join(root, "report.json");
      const selectionsPath = path.join(root, "selections.json");
      const selections = Object.fromEntries(
        (["bun-compatible", "dual"] as const).map((policy) => [
          policy,
          resolveCiTestRuntimeSelections({ configs: ["ui/vitest.config.ts"] }, policy),
        ]),
      );
      writeFileSync(selectionsPath, JSON.stringify(selections));
      const result = await runVitestShutdownCommand({
        args: [
          fileURLToPath(new URL("./fixtures/vitest-ui-runtime-partition.mjs", import.meta.url)),
          output,
          selectionsPath,
          path.join(root, "include.json"),
        ],
        signal,
        timeoutMs: DEFAULT_VITEST_TEST_TIMEOUT_MS,
        env: {
          PATH: process.env.PATH,
          CI: "1",
          OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(root, "transforms"),
        },
      });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("[ui-runtime] file shuffle seed: 37");
      const report = JSON.parse(readFileSync(output, "utf8")) as {
        discovered: string[];
        rows: Array<{
          original: string[];
          selected: Record<string, Array<{ runtime: string; files: string[] }>>;
          receipts: Array<{
            requestId: string;
            value: {
              version: number;
              requestId: string;
              config: string;
              root: string;
              files: string[];
            };
          }>;
        }>;
        empty: { modules: number; errors: number };
        emptyDiscoveryAllowed: boolean;
        scheduling: {
          native: string[];
          cold: string[];
          bounded: { native: string[]; actual: string[] };
          cached: Array<{ native: string[]; actual: string[] }>;
          preserved: Array<{ native: string[]; actual: string[] }>;
          shuffled: Array<{ native: string[]; actual: string[] }>;
          partitionedShuffled: Array<{
            native: string[];
            actual: string[];
            shardNative: string[];
            shardActual: string[];
          }>;
          projectOrder: { native: string[]; actual: string[] };
        };
      };
      const nodeFiles = new Set(["ui/src/pages/usage/usage-page-details.test.ts"]);
      expect(report.discovered.length).toBeGreaterThan(1000);
      expect(report.rows).toHaveLength(4);
      expect(report.empty).toEqual({ modules: 0, errors: 0 });
      expect(report.emptyDiscoveryAllowed).toBe(false);
      expect(report.scheduling.native).toEqual([
        "default-a",
        "node-a",
        "url-a",
        "default-b",
        "node-b",
        "url-b",
        "default-false",
        "other-url",
      ]);
      expect(report.scheduling.cold).toEqual([
        "default-a",
        "default-b",
        "default-false",
        "node-a",
        "node-b",
        "url-a",
        "url-b",
        "other-url",
      ]);
      const { bounded } = report.scheduling;
      expect(bounded.actual).toHaveLength(405);
      expect(bounded.actual.toSorted()).toEqual(bounded.native.toSorted());
      for (const prefix of ["default-", "node-"]) {
        expect(bounded.actual.filter((selection) => selection.startsWith(prefix))).toEqual(
          bounded.native.filter((selection) => selection.startsWith(prefix)),
        );
      }
      let previousEnvironment: "node" | "jsdom" | undefined;
      let consecutive = 0;
      let longestRun = 0;
      for (const selection of bounded.actual) {
        const environment = selection.startsWith("node-") ? "node" : "jsdom";
        consecutive = environment === previousEnvironment ? consecutive + 1 : 1;
        longestRun = Math.max(longestRun, consecutive);
        previousEnvironment = environment;
      }
      // This balanced inventory must not collapse into one long run. This is
      // not a general worker-lifetime or memory bound for arbitrary inventories.
      expect(longestRun).toBeLessThanOrEqual(128);
      for (const preserved of [...report.scheduling.cached, ...report.scheduling.preserved]) {
        expect(preserved.actual).toEqual(preserved.native);
      }
      expect(report.scheduling.projectOrder.actual).toEqual(report.scheduling.projectOrder.native);
      for (const shuffled of report.scheduling.shuffled) {
        expect(shuffled.actual).toEqual(shuffled.native);
        expect(shuffled.actual).not.toEqual(report.scheduling.native);
      }
      for (const shuffled of report.scheduling.partitionedShuffled) {
        expect(shuffled.actual).toEqual(shuffled.native);
        expect(shuffled.shardActual).toEqual(shuffled.shardNative);
      }
      expect(
        report.rows
          .slice(1)
          .flatMap((row) => row.original)
          .toSorted(),
      ).toEqual(report.discovered);
      for (const row of report.rows) {
        expect(row.receipts).toHaveLength(4);
        for (const { requestId, value } of row.receipts) {
          expect(value).toEqual({
            version: 1,
            requestId,
            config: path.join(process.cwd(), "ui/vitest.config.ts").replaceAll("\\", "/"),
            root: path.join(process.cwd(), "ui").replaceAll("\\", "/"),
            files: expect.any(Array),
          });
          // The producer must retain the native shard, including the other runtime's files.
          expect(value.files.toSorted()).toEqual(row.original);
        }
        const compatible = row.selected["bun-compatible"]!;
        expect(compatible.map((selection) => selection.runtime)).toEqual(["node", "bun"]);
        expect(compatible[0]!.files).toEqual(row.original.filter((file) => nodeFiles.has(file)));
        expect(compatible[1]!.files).toEqual(row.original.filter((file) => !nodeFiles.has(file)));
        expect(compatible.flatMap((selection) => selection.files).toSorted()).toEqual(row.original);
        expect(row.selected.dual).toEqual([
          { runtime: "node", files: row.original },
          compatible[1],
        ]);
      }
    }));

  it("gives module-mock fixtures the same isolated ownership in both entry points", async () => {
    vi.stubEnv("OPENCLAW_VITEST_INCLUDE_FILE", "");
    vi.resetModules();
    const config = (await import("../ui/vitest.config.ts")).default;
    const projects = (requireTestConfig(config).projects ?? []).map(requireTestConfig);
    const packageIsolated = projects.find((project) => project.name === "unit-mock-registry");
    const rootIsolated = requireTestConfig(createUiIsolatedVitestConfig({}));
    expect(packageIsolated?.isolate).toBe(true);
    expect(rootIsolated.isolate).toBe(true);
    const packageFiles = globSync(packageIsolated?.include ?? [], {
      cwd: path.join(process.cwd(), "ui"),
      exclude: packageIsolated?.exclude,
    }).map((file) => path.posix.normalize(`ui/${file.replaceAll("\\", "/")}`));
    expect(packageFiles.length).toBeGreaterThan(0);
    const rootFiles = globSync(rootIsolated.include ?? [], { exclude: rootIsolated.exclude }).map(
      (file) => file.replaceAll("\\", "/"),
    );
    expect(rootFiles.toSorted()).toEqual(packageFiles.toSorted());
    const rootShared = requireTestConfig(createUiVitestConfig({}));
    expect(
      globSync(rootShared.include ?? [], { exclude: rootShared.exclude }).filter((file) =>
        packageFiles.includes(file.replaceAll("\\", "/")),
      ),
    ).toEqual([]);
  });

  it("preserves native Chromium discovery when loaded as a file project", ({ signal }) =>
    fixture.run(async () => {
      signal.throwIfAborted();
      const root = fixture.createTempDir("ui-browser-project-root-");
      const topLevelRoot = fixture.createTempDir("ui-browser-top-level-root-");
      const testRoot = fixture.createTempDir("ui-browser-test-root-");
      const reportPath = path.join(root, "discovery.json");
      const home = path.join(root, "home");
      const tmp = path.join(root, "tmp");
      mkdirSync(home);
      mkdirSync(tmp);
      const fixturePath = fileURLToPath(
        new URL("./fixtures/vitest-browser-project-root.mjs", import.meta.url),
      );
      const result = await runVitestShutdownCommand({
        args: [fixturePath, reportPath, topLevelRoot, testRoot],
        signal,
        timeoutMs: DEFAULT_VITEST_TEST_TIMEOUT_MS,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          TMPDIR: tmp,
          TMP: tmp,
          TEMP: tmp,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local", "share"),
          XDG_CACHE_HOME: path.join(home, ".cache"),
          CI: "1",
          OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(root, "transforms"),
        },
      });
      expect(result.code, result.stderr).toBe(0);
      const reports = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
        projects: Array<{ name: string; root: string; viteRoot: string; setupFiles: string[] }>;
        files: string[];
      }>;
      expect(reports).toHaveLength(4);
      const [standalone, embedded, topLevel, testOption] = reports;
      const uiRoot = path.join(process.cwd(), "ui");
      expect(standalone?.projects).toEqual([
        {
          name: "chromium",
          root: uiRoot,
          viteRoot: uiRoot,
          setupFiles: [path.join(uiRoot, "src/test-helpers/lit-warnings.setup.ts")],
        },
      ]);
      expect(standalone?.files).toContain(
        path.join(uiRoot, "src/components/markdown-mermaid.runtime.browser.test.ts"),
      );
      expect(embedded).toEqual(standalone);
      expect(topLevel?.projects).toEqual([
        {
          name: "chromium",
          root: topLevelRoot,
          viteRoot: topLevelRoot,
          setupFiles: [path.join(topLevelRoot, "src/test-helpers/lit-warnings.setup.ts")],
        },
      ]);
      expect(testOption?.projects).toEqual([
        {
          name: "chromium",
          root: testRoot,
          viteRoot: testRoot,
          setupFiles: [path.join(testRoot, "src/test-helpers/lit-warnings.setup.ts")],
        },
      ]);
    }));

  it("runs full-render timing budgets after ordinary UI work with one owner per entry point", async () => {
    vi.stubEnv("OPENCLAW_VITEST_INCLUDE_FILE", "");
    vi.resetModules();
    const config = (await import("../ui/vitest.config.ts")).default;
    const projects = (requireTestConfig(config).projects ?? []).map(requireTestConfig);
    const timing = projects.find((project) => project.name === "unit-timing");
    expect(timing).toBeDefined();
    expect(timing?.isolate).toBe(true);
    for (const project of projects.filter((candidate) => candidate !== timing)) {
      expect(timing?.sequence?.groupOrder).toBeGreaterThan(project.sequence?.groupOrder ?? 0);
    }
    const selected = projects.flatMap((project) =>
      globSync(project.include ?? [], {
        cwd: path.join(process.cwd(), "ui"),
        exclude: project.exclude,
      }).map((file) => `ui/${file.replaceAll("\\", "/")}`),
    );
    const rootTiming = requireTestConfig(createUiTimingVitestConfig({}));
    const rootShared = requireTestConfig(createUiVitestConfig({}));
    const rootFiles = globSync(rootShared.include ?? [], { exclude: rootShared.exclude });
    for (const project of [rootShared, requireTestConfig(createUiIsolatedVitestConfig({}))]) {
      expect(rootTiming.sequence?.groupOrder).toBeGreaterThan(project.sequence?.groupOrder ?? 0);
    }
    expect(globSync(rootTiming.include ?? [], { exclude: rootTiming.exclude })).toEqual(
      uiTimingTestFiles,
    );
    for (const file of uiTimingTestFiles) {
      expect(selected.filter((candidate) => candidate === file)).toHaveLength(1);
      expect(rootFiles).not.toContain(file);
      for (const target of [file, "ui/src/components"]) {
        const plans = buildVitestRunPlans([target]);
        expect(
          plans.filter((plan) => plan.config === "test/vitest/vitest.ui-timing.config.ts"),
        ).toHaveLength(1);
      }
    }
  });

  it("keeps native Chromium files out of root jsdom without dropping Node-driven Playwright files", async () => {
    const includeFile = path.join(tempDirs.make("ui-node-selection-"), "include.json");
    writeFileSync(includeFile, JSON.stringify(["ui/src/**/*.test.ts"]));
    const runtimeIncludeFile = path.join(path.dirname(includeFile), "runtime-include.json");
    writeFileSync(
      runtimeIncludeFile,
      JSON.stringify(["ui/src/pages/chat/chat-pane-retained-presentation.test.ts"]),
    );
    vi.stubEnv("OPENCLAW_VITEST_INCLUDE_FILE", includeFile);
    vi.stubEnv("OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE", runtimeIncludeFile);
    vi.stubEnv("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", includeFile);
    const probe = vi.fn(() => ({ status: 0 }));
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:child_process")>()),
      spawnSync: probe,
    }));
    vi.resetModules();
    const { default: config, createUiBrowserVitestConfig } = await import("../ui/vitest.config.ts");
    expect(probe).not.toHaveBeenCalled();
    const uiRoot = path.join(process.cwd(), "ui");
    const projects = (requireTestConfig(config).projects ?? []).map(requireTestConfig);
    const browser = projects.find((project) => project.browser?.enabled);
    const node = projects.find((project) => project.name === "unit-node");
    const root = requireTestConfig(createUiVitestConfig());
    const nativeFiles = globSync(browser?.include ?? [], {
      cwd: uiRoot,
      exclude: browser?.exclude,
    }).map((file) => `ui/${file}`);
    const nodeFiles = globSync(node?.include ?? [], {
      cwd: uiRoot,
      exclude: node?.exclude,
    })
      .filter((file) => file.endsWith(".browser.test.ts"))
      .map((file) => `ui/${file}`);
    const rootFiles = globSync(root.include ?? [], { exclude: root.exclude });
    expect(nativeFiles).toContain("ui/src/components/markdown-mermaid.runtime.browser.test.ts");
    expect(nodeFiles).toContain("ui/src/components/form-controls.browser.test.ts");
    expect(rootFiles.filter((file) => nativeFiles.includes(file))).toEqual([]);
    expect(rootFiles).toEqual(expect.arrayContaining(nodeFiles));
    expect([...nativeFiles, ...nodeFiles].toSorted()).toEqual(
      globSync("ui/src/**/*.browser.test.ts").toSorted(),
    );
    const unpartitionedBrowser = requireTestConfig(createUiBrowserVitestConfig({}));
    expect(unpartitionedBrowser.browser?.provider?.prewarm).toEqual(expect.any(Function));
    expect(probe).toHaveBeenCalledWith(includeFile, ["--version"], { stdio: "ignore" });
    expect(unpartitionedBrowser.browser?.provider?.options).toMatchObject({
      launchOptions: {
        executablePath: includeFile,
        args: ["--enable-blink-features=NoIdleEncodingForWebTests"],
      },
    });
    for (const [files, shouldPrewarm] of [
      [[], false],
      [["ui/src/pages/chat/chat-pane-retained-presentation.test.ts"], false],
      [nodeFiles, false],
      [[nativeFiles[0]!], true],
      [["extensions/example/browser/example.browser.test.ts"], true],
    ] as const) {
      writeFileSync(runtimeIncludeFile, JSON.stringify(files));
      const partitionedBrowser = requireTestConfig(
        createUiBrowserVitestConfig({
          OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE: runtimeIncludeFile,
        }),
      );
      expect(partitionedBrowser.include).toEqual(unpartitionedBrowser.include);
      expect(partitionedBrowser.exclude).toEqual(unpartitionedBrowser.exclude);
      expect(partitionedBrowser.browser).toMatchObject({
        enabled: true,
        provider: {
          name: "playwright",
          options: unpartitionedBrowser.browser?.provider?.options,
          providerFactory: expect.any(Function),
          serverFactory: unpartitionedBrowser.browser?.provider?.serverFactory,
        },
      });
      expect(typeof partitionedBrowser.browser?.provider?.prewarm).toBe(
        shouldPrewarm ? "function" : "undefined",
      );
    }
    expect(probe).toHaveBeenCalledTimes(1);
    writeFileSync(includeFile, JSON.stringify([...nativeFiles, ...nodeFiles]));
    const scopedRoot = requireTestConfig(
      createUiVitestConfig({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile }),
    );
    expect(globSync(scopedRoot.include ?? [], { exclude: scopedRoot.exclude }).toSorted()).toEqual(
      nodeFiles.toSorted(),
    );
  });

  it.each([
    [
      ["ui/src/pages/chat/chat-view.test.ts", "ui/src/pages/chat/chat-pane-lifecycle.test.ts"],
      ["ui/src/pages/chat/chat-pane-lifecycle.test.ts", "ui/src/pages/chat/chat-view.test.ts"],
    ],
    [["src/pages/chat/chat-view.test.ts"], []],
    [
      [
        "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
        "ui/src/components/form-controls.browser.test.ts",
      ],
      [
        "ui/src/components/form-controls.browser.test.ts",
        "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
      ],
    ],
    [
      ["extensions/workboard/browser/catalog.test.ts"],
      ["extensions/workboard/browser/catalog.test.ts"],
    ],
    [[], []],
    [
      ["ui/src/components/markdown.progress.node.test.ts"],
      ["ui/src/components/markdown.progress.node.test.ts"],
    ],
  ])("intersects a repository include list with every project: %j", async (requested, expected) => {
    const includeFile = path.join(tempDirs.make("ui-package-selection-"), "include.json");
    writeFileSync(includeFile, JSON.stringify(requested));
    vi.stubEnv("OPENCLAW_VITEST_INCLUDE_FILE", includeFile);
    vi.resetModules();
    const config = (await import("../ui/vitest.config.ts")).default;
    const uiRoot = path.join(process.cwd(), "ui");
    expect(config.root).toBe(uiRoot);
    const selected = (requireTestConfig(config).projects ?? []).flatMap((project) => {
      const test = requireTestConfig(project);
      return globSync(test.include ?? [], { cwd: uiRoot, exclude: test.exclude }).map((file) =>
        path.posix.normalize(`ui/${file.replaceAll("\\", "/")}`),
      );
    });
    expect(new Set(selected).size).toBe(selected.length);
    expect(selected.toSorted()).toEqual(expected);
  });

  it("keeps the standalone ui package on thread workers without broad isolation", () => {
    const testConfig = requireTestConfig(uiConfig);

    expect(testConfig.pool).toBe("threads");
    expect(testConfig.isolate).toBe(false);
    expect(testConfig.projects).toHaveLength(5);
    expect(testConfig.maxWorkers).toBeGreaterThan(0);
    expect(testConfig.clearMocks).toBe(false);

    for (const project of testConfig.projects ?? []) {
      const projectTestConfig = requireTestConfig(project);
      expect((project as { extends?: boolean }).extends).toBe(false);
      expect(projectTestConfig.clearMocks).toBe(false);
      expect(projectTestConfig.pool).toBe("threads");
      // Project overrides would defeat CI's explicit --maxWorkers limit.
      expect(projectTestConfig.maxWorkers).toBeUndefined();
      expect(projectTestConfig.setupFiles).toEqual(["./src/test-helpers/lit-warnings.setup.ts"]);
      expect(projectTestConfig.isolate).toBe(
        projectTestConfig.name === "unit-mock-registry" || projectTestConfig.name === "unit-timing",
      );
    }
  });

  // The invariant, not a snapshot: `unit` shares one module graph and jsdom
  // window across files, so without the cleanup runner the first file to
  // evaluate a component owns it for the whole worker and a later file's
  // vi.mock never reaches production. Two projects are exempt for stated
  // reasons: `browser` runs in browser mode, where the runner's node:fs and
  // server-module imports cannot load, and `unit-node` carries the
  // Playwright-driven layout tests whose browser lives in module scope, which
  // per-file module resets churn.
  it("runs the shared jsdom ui project on the cross-file cleanup runner", () => {
    const projects = requireTestConfig(uiConfig).projects ?? [];
    const wiring = projects.map((project) => {
      const projectTestConfig = requireTestConfig(project);
      return {
        name: projectTestConfig.name,
        runner: projectTestConfig.runner
          ? normalizeConfigPath(projectTestConfig.runner)
          : undefined,
      };
    });

    expect(wiring).toEqual([
      { name: "unit", runner: "test/non-isolated-runner.ts" },
      { name: "unit-mock-registry", runner: undefined },
      { name: "unit-node", runner: undefined },
      { name: "browser", runner: undefined },
      { name: "unit-timing", runner: undefined },
    ]);
  });

  it("uses the repository transform-cache policy at the root and in every UI project", () => {
    const root = requireTestConfig(uiConfig);
    const expected = loadVitestPerformanceConfig(
      process.env,
      process.platform,
      path.join(process.cwd(), "ui"),
    );
    const configs = [root, ...(root.projects ?? []).map(requireTestConfig)];

    for (const config of configs) {
      expect(config.fsModuleCache).toEqual(expected.fsModuleCache);
      expect(config.fsModuleCachePath).toEqual(expected.fsModuleCachePath);
      expect(config.experimental).toEqual(expected.experimental);
    }
  });

  it("keeps the standalone ui node config on thread workers without isolation", () => {
    const testConfig = requireTestConfig(uiNodeConfig);

    expect(testConfig.pool).toBe("threads");
    expect(testConfig.isolate).toBe(false);
    expect(testConfig.runner).toBeUndefined();
    expect(testConfig.clearMocks).toBe(false);
  });

  it.each([
    ["@openclaw/gateway-client/scope-upgrade", "packages/gateway-client/src/scope-upgrade.ts"],
    ["openclaw/plugin-sdk/control-ui", "src/plugin-sdk/control-ui.ts"],
  ])("aliases %s from source in every standalone UI project", (specifier, source) => {
    const projects = requireTestConfig(uiConfig).projects ?? [];
    for (const config of [uiConfig, ...projects]) {
      expect(requireAlias(config, specifier)).toEqual({
        find: specifier,
        replacement: path.join(process.cwd(), source),
      });
    }
  });
});
