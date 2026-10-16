// Vitest UI package config tests validate UI package test project settings.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globSync as nativeGlobSync } from "tinyglobby";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserProviderOption } from "vitest/node";
import { resolveCiTestRuntimeSelections } from "../scripts/lib/ci-test-runtime.mts";
import { buildVitestRunPlans } from "../scripts/test-projects.test-support.mts";
import { createFixtureLifetime } from "./helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { runVitestShutdownCommand } from "./helpers/vitest-shutdown-command.js";
import { loadVitestPerformanceConfig } from "./vitest/vitest.performance-config.ts";
import { sharedVitestConfig } from "./vitest/vitest.shared.config.ts";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "./vitest/vitest.timeouts.ts";
import { createUiIsolatedVitestConfig } from "./vitest/vitest.ui-isolated.config.ts";
import { uiNodeDrivenBrowserTestFiles, uiTimingTestFiles } from "./vitest/vitest.ui-paths.mjs";
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

function globTestFiles(
  patterns: string | string[],
  options: { cwd?: string; exclude?: string[] } = {},
): string[] {
  // Use the same discovery engine and options as Vitest, including for scoped owners.
  return nativeGlobSync(patterns, {
    cwd: options.cwd,
    ignore: options.exclude,
    dot: true,
    expandDirectories: false,
  });
}

function requireTestConfig(config: unknown): ExpectedTestConfig {
  if (!config || typeof config !== "object" || !("test" in config) || !config.test) {
    throw new Error("expected ui package vitest test config");
  }
  return config.test as ExpectedTestConfig;
}

describe("ui package vitest config", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const fixture = createFixtureLifetime();
  afterEach(async () => {
    await fixture.cleanup();
    vi.unstubAllEnvs();
    vi.doUnmock("../ui/src/test-helpers/playwright-chromium.ts");
    vi.resetModules();
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
        packageNodeFiles: string[];
        rootNodeFiles: string[];
        rows: Array<{
          original: string[];
          selected: Record<string, Array<{ runtime: string; files: string[] }>>;
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
      expect(report.discovered.length).toBeGreaterThan(1000);
      expect(report.discovered).toContain("ui/src/solid-smoke/solid-smoke.test.tsx");
      // Package isolated/timing/Chromium projects retain their separate owners.
      expect(report.rootNodeFiles).toEqual(report.packageNodeFiles);
      expect(report.rootNodeFiles).toContain(
        "ui/src/pages/chat/talk/shared.browser-import.test.ts",
      );
      expect(report.rootNodeFiles).toEqual(expect.arrayContaining(uiNodeDrivenBrowserTestFiles));
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
        const compatible = row.selected["bun-compatible"]!;
        expect(compatible).toEqual([{ runtime: "bun", files: row.original }]);
        expect(row.selected.dual).toEqual([
          { runtime: "node", files: row.original },
          { runtime: "bun", files: row.original },
        ]);
      }
    }));

  it("cleans Solid roots per test when a second file reuses the cached mount helper", ({
    signal,
  }) =>
    fixture.run(async () => {
      const artifactRoot = path.join(process.cwd(), ".artifacts");
      mkdirSync(artifactRoot, { recursive: true });
      const root = fixture.createTempDir("ui-solid-cleanup-", artifactRoot);
      const mountPath = JSON.stringify(
        path.join(process.cwd(), "ui/src/test-helpers/mount-solid.ts"),
      );
      writeFileSync(
        path.join(root, "first.test.ts"),
        `
import { it } from "vitest";
import { mountSolid } from ${mountPath};
it("loads the reusable mount helper", () => { globalThis.cachedMount = mountSolid; });
`,
      );
      writeFileSync(
        path.join(root, "second.test.ts"),
        `
import { expect, it } from "vitest";
import { onCleanup } from "solid-js";
import { mountSolid } from ${mountPath};
let disposed = false;
let container;
it("uses the same helper for a later file", () => {
  expect(mountSolid).toBe(globalThis.cachedMount);
  container = mountSolid(() => {
    onCleanup(() => { disposed = true; });
    return document.createElement("output");
  }).container;
  expect(container.isConnected).toBe(true);
});
it("disposes its effects and owned DOM before the next test", () => {
  expect(disposed).toBe(true);
  expect(container.isConnected).toBe(false);
});
`,
      );
      // The native runner keeps helpers cached; the repository's file cleanup would mask this bug.
      const configPath = path.join(root, "vitest.config.mjs");
      writeFileSync(
        configPath,
        `
import { BaseSequencer } from "vitest/node";
import { controlUiSolidPlugin } from ${JSON.stringify(path.join(process.cwd(), "ui/config/control-ui-solid.ts"))};
export default {
  plugins: [controlUiSolidPlugin()],
  test: {
    root: ${JSON.stringify(root)},
    include: ["*.test.ts"],
    setupFiles: [${JSON.stringify(path.join(process.cwd(), "ui/src/test-helpers/lit-warnings.setup.ts"))}],
    environment: "jsdom", isolate: false, pool: "threads", maxWorkers: 1,
    execArgv: ${JSON.stringify(sharedVitestConfig.test.execArgv)},
    sequence: { sequencer: class extends BaseSequencer {
      sort(files) { return files.toSorted((a, b) => a.moduleId.localeCompare(b.moduleId)); }
    } },
  },
};
`,
      );
      const result = await runVitestShutdownCommand({
        args: [
          path.join(process.cwd(), "node_modules/vitest/vitest.mjs"),
          "run",
          "--config",
          configPath,
          "--configLoader",
          "runner",
        ],
        signal,
        timeoutMs: DEFAULT_VITEST_TEST_TIMEOUT_MS,
        env: { PATH: process.env.PATH, CI: "1" },
      });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("3 passed");
    }));

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
      globTestFiles(project.include ?? [], {
        cwd: path.join(process.cwd(), "ui"),
        exclude: project.exclude,
      }).map((file) => `ui/${file.replaceAll("\\", "/")}`),
    );
    const rootTiming = requireTestConfig(createUiTimingVitestConfig({}));
    const rootShared = requireTestConfig(createUiVitestConfig({}));
    const rootFiles = globTestFiles(rootShared.include ?? [], { exclude: rootShared.exclude });
    for (const project of [rootShared, requireTestConfig(createUiIsolatedVitestConfig({}))]) {
      expect(rootTiming.sequence?.groupOrder).toBeGreaterThan(project.sequence?.groupOrder ?? 0);
    }
    expect(globTestFiles(rootTiming.include ?? [], { exclude: rootTiming.exclude })).toEqual(
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

  it.each([
    { patterns: ["ui/src/**/*.test.ts"] },
    { patterns: ["ui/src/**/*.test.ts", "ui/src/**/*.test.tsx"] },
  ])("keeps native Chromium files out of root jsdom for $patterns", async ({ patterns }) => {
    const includeFile = path.join(tempDirs.make("ui-node-selection-"), "include.json");
    writeFileSync(includeFile, JSON.stringify(patterns));
    const runtimeIncludeFile = path.join(path.dirname(includeFile), "runtime-include.json");
    writeFileSync(
      runtimeIncludeFile,
      JSON.stringify(["ui/src/pages/chat/chat-pane-retained-presentation.test.ts"]),
    );
    vi.stubEnv("OPENCLAW_VITEST_INCLUDE_FILE", includeFile);
    vi.stubEnv("OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE", runtimeIncludeFile);
    // Chromium selection (which spawns the browser) must stay lazy and run once per process.
    const resolveChromium = vi.fn((_defaultExecutablePath: string) => includeFile);
    vi.doMock("../ui/src/test-helpers/playwright-chromium.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../ui/src/test-helpers/playwright-chromium.ts")>()),
      resolvePlaywrightChromiumExecutablePath: resolveChromium,
    }));
    vi.resetModules();
    const { default: config, createUiBrowserVitestConfig } = await import("../ui/vitest.config.ts");
    expect(resolveChromium).not.toHaveBeenCalled();
    const uiRoot = path.join(process.cwd(), "ui");
    const projects = (requireTestConfig(config).projects ?? []).map(requireTestConfig);
    const browser = projects.find((project) => project.browser?.enabled);
    const node = projects.find((project) => project.name === "unit-node");
    const root = requireTestConfig(createUiVitestConfig());
    const nativeFiles = globTestFiles(browser?.include ?? [], {
      cwd: uiRoot,
      exclude: browser?.exclude,
    }).map((file) => `ui/${file}`);
    const nodeFiles = globTestFiles(node?.include ?? [], {
      cwd: uiRoot,
      exclude: node?.exclude,
    })
      .filter((file) => /\.browser\.test\.tsx?$/u.test(file))
      .map((file) => `ui/${file}`);
    const rootFiles = globTestFiles(root.include ?? [], { exclude: root.exclude });
    expect(rootFiles.includes("ui/src/solid-smoke/solid-smoke.test.tsx")).toBe(
      patterns.includes("ui/src/**/*.test.tsx"),
    );
    expect(nativeFiles).toContain("ui/src/components/markdown-mermaid.runtime.browser.test.ts");
    expect(nodeFiles).toContain("ui/src/components/form-controls.browser.test.ts");
    expect(rootFiles.filter((file) => nativeFiles.includes(file))).toEqual([]);
    expect(rootFiles).toEqual(expect.arrayContaining(nodeFiles));
    expect([...nativeFiles, ...nodeFiles].toSorted()).toEqual(
      globTestFiles(patterns)
        .filter((file) => /\.browser\.test\.tsx?$/u.test(file))
        .toSorted(),
    );
    const unpartitionedBrowser = requireTestConfig(createUiBrowserVitestConfig({}));
    expect(unpartitionedBrowser.browser?.provider?.prewarm).toEqual(expect.any(Function));
    expect(resolveChromium).toHaveBeenCalledOnce();
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
    expect(resolveChromium).toHaveBeenCalledTimes(1);
    writeFileSync(includeFile, JSON.stringify([...nativeFiles, ...nodeFiles]));
    const scopedRoot = requireTestConfig(
      createUiVitestConfig({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile }),
    );
    expect(
      globTestFiles(scopedRoot.include ?? [], { exclude: scopedRoot.exclude }).toSorted(),
    ).toEqual(nodeFiles.toSorted());
  });
});
