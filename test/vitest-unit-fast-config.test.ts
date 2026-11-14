import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnNodeEvalSync } from "../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { normalizeConfigPath } from "./helpers/vitest-config-paths.js";
import { createContractsPluginVitestConfig } from "./vitest/vitest.contracts-plugin.config.ts";
import { pluginContractPatterns } from "./vitest/vitest.contracts-shared.ts";
import { createUnitFastFakeTimersVitestConfig } from "./vitest/vitest.unit-fast-fake-timers.config.ts";
import { createUnitFastIsolatedVitestConfig } from "./vitest/vitest.unit-fast-isolated.config.ts";
import * as paths from "./vitest/vitest.unit-fast-paths.mjs";
import { createUnitFastVitestConfig } from "./vitest/vitest.unit-fast.config.ts";

const ENV_ISOLATION_SETUP_PATH = /[\\/]test[\\/]setup\.env\.ts$/u;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const envSetup = [expect.stringMatching(ENV_ISOLATION_SETUP_PATH)];
const cli = (...filters: string[]) => ["node", "vitest", "run", ...filters];
const pureTest = 'import { it } from "vitest"; it("pure", () => {});';

describe("unit-fast vitest lane", () => {
  let unitFastTestFiles: ReturnType<typeof paths.getUnitFastTestFiles>;
  let unitFastIsolatedTestFiles: ReturnType<typeof paths.getUnitFastIsolatedTestFiles>;
  let unitFastTimerTestFiles: ReturnType<typeof paths.getUnitFastTimerTestFiles>;
  let unitFastAnalysis: ReturnType<typeof paths.collectUnitFastTestFileAnalysis>;

  beforeAll(() => {
    unitFastTestFiles = paths.getUnitFastTestFiles();
    unitFastIsolatedTestFiles = paths.getUnitFastIsolatedTestFiles();
    unitFastTimerTestFiles = paths.getUnitFastTimerTestFiles();
    unitFastAnalysis = paths.collectUnitFastTestFileAnalysis();
  });

  it("classifies selected sources without truncating full ownership or lifecycle drains", () => {
    const script = `
      import assert from "node:assert/strict";
      import childProcess from "node:child_process";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import os from "node:os";
      import path from "node:path";
      const selectedTests = [
        "src/agents/agent-tools.deferred-followup-guidance.test.ts",
        "src/test-utils/temp-home.test.ts",
        "src/utils.test.ts",
        "src/media-generation/runtime-shared.test.ts",
      ];
      let gitLsFilesCalls = 0;
      const originalSpawnSync = childProcess.spawnSync;
      childProcess.spawnSync = function patchedSpawnSync(...args) {
        const [command, commandArgs] = args;
        if (command === "git" && commandArgs?.[0] === "ls-files") {
          gitLsFilesCalls += Number(!commandArgs.includes("--"));
          const stdout = [
            "src/agents/agent-tools.deferred-followup-guidance.test.ts",
            "src/agents/session-maintenance/coordinator.test.ts",
            "src/hooks/frontmatter.test.ts",
            "src/media-generation/runtime-shared.test.ts",
            "src/routing/account-lookup.test.ts",
          ].map((file) => "H " + file).join("\\0") + "\\0";
          return { stdout, status: 0 };
        }
        return originalSpawnSync.apply(this, args);
      };
      syncBuiltinESMExports();
      let readdirSyncCalls = 0;
      const reads = { hook: 0, outside: 0, unselected: 0 };
      const originalReaddirSync = fs.readdirSync;
      const originalReadFileSync = fs.readFileSync;
      fs.readdirSync = function patchedReaddirSync(...args) {
        readdirSyncCalls += 1;
        return originalReaddirSync.apply(this, args);
      };
      fs.readFileSync = function patchedReadFileSync(...args) {
        const file = String(args[0]).replaceAll("\\\\", "/");
        reads.hook += Number(file.endsWith("/src/hooks/frontmatter.test.ts"));
        reads.outside += Number(file.endsWith("/src/agents/agent-tools.deferred-followup-guidance.test.ts"));
        reads.unselected += Number(file.endsWith(".test.ts") && !selectedTests.some((selected) => file.endsWith("/" + selected)));
        return originalReadFileSync.apply(this, args);
      };
      const paths = await import("./test/vitest/vitest.unit-fast-paths.mjs");
      const membership = selectedTests.map((file) => [
        paths.isUnitFastTestFile(file),
        paths.isUnitFastIsolatedTestFile(file),
        paths.isUnitFastTimerTestFile(file),
      ]);
      assert.deepEqual(membership, [[true, false, false], [true, true, false], [true, false, true], [false, false, false]]);
      assert.equal(reads.unselected, 0);
      assert.equal(gitLsFilesCalls, 0);
      const { resolveCiTestRuntimeSelections } = await import("./scripts/lib/ci-test-runtime.mts");
      for (const [index, name] of ["unit-fast", "unit-fast-isolated"].entries()) {
        assert.deepEqual(resolveCiTestRuntimeSelections({ targets: [selectedTests[index]] }, "bun-all"), [{ runtime: "bun" }]);
        assert.deepEqual(resolveCiTestRuntimeSelections({
          configs: ["test/vitest/vitest." + name + ".config.ts"],
          includePatterns: selectedTests,
        }, "bun-all"), [{ runtime: "bun" }]);
      }
      assert.equal(reads.unselected, 0);
      reads.hook = reads.outside = reads.unselected = 0;
      await import("./test/vitest/vitest.hooks.config.ts?scope-probe=" + Date.now());
      const scoped = { ...reads };
      reads.unselected = 0;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fast-selection-"));
      try {
        const includeFile = path.join(directory, "include.json");
        fs.writeFileSync(includeFile, JSON.stringify(selectedTests));
        for (const mode of ["cli", "env"]) {
          if (mode === "cli") {
            delete process.env.OPENCLAW_VITEST_INCLUDE_FILE;
            process.argv = ["node", "vitest", "run", ...selectedTests];
          } else {
            process.env.OPENCLAW_VITEST_INCLUDE_FILE = includeFile;
            process.argv = ["node", "vitest", "run"];
          }
          for (const [index, name] of ["unit-fast", "unit-fast-isolated", "unit-fast-fake-timers"].entries()) {
            const { default: config } = await import("./test/vitest/vitest." + name + ".config.ts?io-probe=" + mode);
            assert.deepEqual(config.test.include, [selectedTests[index]]);
          }
        }
        const { default: unitConfig, createUnitVitestConfigWithOptions } = await import("./test/vitest/vitest.unit.config.ts?io-probe=" + Date.now());
        const cliUnitConfig = createUnitVitestConfigWithOptions({}, {
          argv: ["node", "vitest", "run", ...selectedTests],
        });
        for (const { test } of [unitConfig, cliUnitConfig]) {
          assert.deepEqual(test.include, selectedTests);
          assert.deepEqual(test.exclude.filter((file) => selectedTests.includes(file)), selectedTests.slice(0, 3));
        }
        assert.deepEqual([gitLsFilesCalls, scoped.hook, scoped.outside, reads.unselected], [0, 1, 0, 0]);
        assert.ok(readdirSyncCalls >= 0 && readdirSyncCalls < 20);
        const fullUnitConfig = createUnitVitestConfigWithOptions({}, { argv: ["node", "vitest", "run"] });
        assert.ok(fullUnitConfig.test.exclude.includes("src/hooks/frontmatter.test.ts"));
        assert.equal(gitLsFilesCalls, 0);
        delete process.env.OPENCLAW_VITEST_INCLUDE_FILE;
        process.argv = ["node", "vitest", "run"];
        const { createVitestRunSpecs } = await import("./scripts/test-projects.test-support.mts");
        const lifecycleFiles = ["src/agents/session-maintenance/coordinator.test.ts", "src/routing/account-lookup.test.ts"];
        const lifecycleRuns = [];
        for (const [index, spec] of createVitestRunSpecs(lifecycleFiles, { baseEnv: {} }).entries()) {
          const selectedFile = path.join(directory, "lifecycle-" + index + ".json");
          fs.writeFileSync(selectedFile, JSON.stringify(spec.includePatterns));
          process.env.OPENCLAW_VITEST_INCLUDE_FILE = selectedFile;
          const { default: { test } } = await import("./" + spec.config + "?lifecycle-probe=" + index);
          const directoryPrefix = path.relative(process.cwd(), test.dir ?? process.cwd());
          const admitted = lifecycleFiles.filter((file) => {
            const relative = path.relative(directoryPrefix || ".", file).replaceAll("\\\\", "/");
            return test.include.some((pattern) => path.matchesGlob(relative, pattern))
              && !test.exclude.some((pattern) => path.matchesGlob(relative, pattern));
          });
          lifecycleRuns.push({ config: spec.config, admitted, runner: test.runner ? path.basename(test.runner) : null });
        }
        assert.deepEqual(lifecycleRuns.sort((a, b) => a.config.localeCompare(b.config)), [
          { config: "test/vitest/vitest.agents-support.config.ts", admitted: [lifecycleFiles[0]], runner: "non-isolated-runner.ts" },
          { config: "test/vitest/vitest.unit-fast.config.ts", admitted: [lifecycleFiles[1]], runner: null },
        ]);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    `;
    const result = spawnNodeEvalSync(script, {
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        OPENCLAW_VITEST_INCLUDE_FILE: undefined,
      },
      evalFlag: "-e",
      imports: ["tsx"],
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("keeps untracked tests in their planned fast lane and execution include list", () => {
    const cwd = fs.realpathSync(tempDirs.make("openclaw-untracked-"));
    const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
    const result = spawnNodeEvalSync(
      `
        import assert from "node:assert/strict";
        import { spawnSync } from "node:child_process";
        import fs from "node:fs";
        import path from "node:path";
        process.chdir(${JSON.stringify(cwd)});
        const [mockHelper, harness, pure, stateful, quoted, ignored] =
          ["mock-helper", "harness", "pure", "stateful", "quoted-[é]", "ignored"].map(name => "src/hooks/" + name + ".test.ts");
        const otherRoots = ["packages/memory-host-sdk/src/pure.test.ts", "test/pure.test.ts"];
        const write = (file, source) => {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, source);
        };
        write(".gitignore", ignored + "\\n");
        for (const file of [pure, quoted, ignored, ...otherRoots]) write(file, ${JSON.stringify(pureTest)});
        for (const [file, helper] of [[stateful, "stateful.test-support"], [mockHelper, "mock-helper.test-mocks"], [harness, "shared.test-harness"]]) {
          write(file, 'import { it } from "vitest"; import { check } from "./' + helper + '.js"; it("helper", check);');
          write("src/hooks/" + helper + ".ts", 'import { vi } from "vitest"; export const check = vi.fn();');
        }
        assert.equal(spawnSync("git", ["init"]).status, 0);
        assert.equal(spawnSync("git", ["ls-files", "--error-unmatch", "--", mockHelper, pure, stateful]).status, 1);
        // Discovery snapshots must be taken after the fixture exists.
        const paths = await import(${moduleUrl("test/vitest/vitest.unit-fast-paths.mjs")});
        const { createVitestRunSpecs, writeVitestIncludeFile } = await import(${moduleUrl("scripts/test-projects.test-support.mts")});
        const { createUnitFastVitestConfig } = await import(${moduleUrl("test/vitest/vitest.unit-fast.config.ts")});
        const { createUnitFastIsolatedVitestConfig } = await import(${moduleUrl("test/vitest/vitest.unit-fast-isolated.config.ts")});
        const { createScopedVitestConfig } = await import(${moduleUrl("test/vitest/vitest.scoped-config.ts")});
        const specs = createVitestRunSpecs([harness, mockHelper, pure, stateful], { baseEnv: {} });
        const factories = {
          "test/vitest/vitest.unit-fast.config.ts": createUnitFastVitestConfig,
          "test/vitest/vitest.unit-fast-isolated.config.ts": createUnitFastIsolatedVitestConfig,
        };
        try {
          const runs = specs.map((spec) => {
            writeVitestIncludeFile(spec.includeFilePath, spec.includePatterns);
            return { config: spec.config, include: factories[spec.config](spec.env).test.include };
          });
          assert.deepEqual(paths.getUnitFastTestFiles(), [...otherRoots, harness, mockHelper, pure, quoted, stateful].toSorted());
          assert.deepEqual(paths.getUnitFastIsolatedTestFiles(), [harness, mockHelper, stateful]);
          assert.deepEqual(runs, [
            { config: "test/vitest/vitest.unit-fast.config.ts", include: [pure] },
            { config: "test/vitest/vitest.unit-fast-isolated.config.ts", include: [harness, mockHelper, stateful] },
          ]);
          assert.deepEqual(createScopedVitestConfig(["src/hooks/**/*.test.ts"], { env: {} }).test.exclude
            .filter((file) => file.startsWith("src/hooks/")), [harness, mockHelper, pure, quoted, stateful]);
          assert.equal(paths.resolveUnitFastTestIncludePattern(ignored), null);
          assert.equal(paths.isUnitFastTestFile(quoted), true);
        } finally {
          for (const spec of specs) fs.rmSync(spec.includeFilePath, { force: true });
        }
      `,
      { imports: ["tsx"] },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["large", "incomplete", "unavailable"] as const)(
    "keeps complete test inventory when Git output is %s",
    (mode) => {
      const cwd = tempDirs.make("openclaw-git-inventory-");
      const files = ["src/hooks/first.test.ts", "src/hooks/last.test.ts"];
      fs.mkdirSync(path.join(cwd, "src/hooks"), { recursive: true });
      for (const file of files) {
        fs.writeFileSync(path.join(cwd, file), pureTest);
      }
      const moduleUrl = pathToFileURL(path.resolve("test/vitest/vitest.unit-fast-paths.mjs")).href;
      const result = spawnNodeEvalSync(`
        import assert from "node:assert/strict";
        import childProcess from "node:child_process";
        import fs from "node:fs";
        import path from "node:path";
        import { syncBuiltinESMExports } from "node:module";
        process.chdir(${JSON.stringify(cwd)});
        const mode = ${JSON.stringify(mode)};
        const files = ${JSON.stringify(files)};
        const spawn = childProcess.spawnSync;
        childProcess.spawnSync = function(command, args, options) {
          if (command !== "git" || args[0] !== "ls-files") {
            return spawn.call(this, command, args, options);
          }
          if (mode === "incomplete") {
            return { status: 0, stdout: "H " + files[0] + "\\0",
              error: Object.assign(new Error("incomplete output"), { code: "ENOBUFS" }) };
          }
          if (mode === "unavailable") {
            return spawn(path.join(process.cwd(), "missing-git"), args, options);
          }
          const script = "process.stdout.write(" + JSON.stringify("H src/filler.ts\\0") +
            ".repeat(90_000) + " + JSON.stringify(files.map((file) => "H " + file).join("\\0") + "\\0") + ")";
          return spawn(process.execPath, ["-e", script], options);
        };
        syncBuiltinESMExports();
        let walks = 0;
        const readdir = fs.readdirSync;
        fs.readdirSync = function(...args) {
          walks++;
          return readdir.apply(this, args);
        };
        const paths = await import(${JSON.stringify(moduleUrl)});
        const scoped = paths.getUnitFastTestFilesForIncludePatterns(["src/hooks/**/*.test.ts"]);
        assert.deepEqual(paths.getUnitFastTestFiles(), files);
        assert.deepEqual(scoped, files);
        assert.ok(mode === "large" ? walks === 0 : walks > 0);
      `);
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it.each([undefined, cli("--config", "test/vitest/vitest.unit-fast.config.ts")])(
    "keeps cache-friendly defaults with CLI arguments %j",
    (argv) => {
      const testConfig = createUnitFastVitestConfig({}, { argv }).test!;
      expect(testConfig).toMatchObject({
        isolate: false,
        runner: undefined,
        setupFiles: envSetup,
        include: unitFastTestFiles.filter(
          (file) =>
            !unitFastTimerTestFiles.includes(file) && !unitFastIsolatedTestFiles.includes(file),
        ),
      });
    },
  );

  it("keeps excluded stateful files out of directory-scoped CLI runs", () => {
    // Directory filters must not admit stateful siblings into the shared worker.
    const otherLaneFiles = new Set([
      ...paths.getUnitFastTimerTestFiles(),
      ...paths.getUnitFastIsolatedTestFiles(),
    ]);
    for (const dir of ["src/plugins", "src/agents", "src/commands"]) {
      const testConfig = createUnitFastVitestConfig({}, { argv: cli(dir) }).test!;
      const include = testConfig.include as string[];
      const expected = unitFastTestFiles.filter(
        (file) => file.startsWith(`${dir}/`) && !otherLaneFiles.has(file),
      );

      expect(include, dir).toEqual(expected);
    }

    expect(paths.isUnitFastTestFile("src/plugins/install-persistence.test.ts")).toBe(false);

    const contractsInclude = createContractsPluginVitestConfig({}, cli("src/plugins")).test!
      .include;
    expect(contractsInclude).toEqual(pluginContractPatterns);
  });

  it("routes light siblings but not stateful owner suites", () => {
    for (const [file, expected] of [
      ["src/plugin-sdk/text-chunking.ts", "src/plugin-sdk/text-chunking.test.ts"],
      ["src/commands/text-format.ts", "src/commands/text-format.test.ts"],
      ["src/cron/service.restart-session-event.test.ts", null],
    ] as const) {
      expect(paths.resolveUnitFastTestIncludePattern(file)).toBe(expected);
    }
  });

  it("routes audited stateful-looking tests through the isolated fast lane", () => {
    const forcedFileSet = new Set(paths.forcedUnitFastTestFiles);
    const forcedAnalysis = unitFastAnalysis.filter((entry) => forcedFileSet.has(entry.file));
    expect(forcedAnalysis).toHaveLength(paths.forcedUnitFastTestFiles.length);
    for (const entry of forcedAnalysis) {
      expect(entry).toMatchObject({ forced: true, unitFast: true });
    }
    for (const file of paths.forcedUnitFastTestFiles) {
      expect(unitFastTestFiles).toContain(file);
      expect(paths.isUnitFastTestFile(file)).toBe(true);
      if (unitFastTimerTestFiles.includes(file)) {
        expect(unitFastIsolatedTestFiles).not.toContain(file);
      } else {
        expect(unitFastIsolatedTestFiles).toContain(file);
        expect(paths.isUnitFastIsolatedTestFile(file)).toBe(true);
        expect(paths.resolveUnitFastTestIncludePattern(file)).toBeNull();
        expect(paths.resolveUnitFastIsolatedTestIncludePattern(file)).toBe(file);
      }
    }
    expect(createUnitFastIsolatedVitestConfig({}).test).toMatchObject({
      isolate: true,
      runner: undefined,
      include: unitFastIsolatedTestFiles,
      setupFiles: envSetup,
    });
  });

  it("routes fake-timer unit-fast tests through the serial fake-timer lane", () => {
    const fakeTimerFiles = unitFastAnalysis
      .filter((entry) => entry.unitFast && entry.reasons.includes("fake-timers"))
      .map((entry) => entry.file);
    expect(unitFastTimerTestFiles.length).toBeGreaterThan(0);
    expect(unitFastTimerTestFiles).toEqual(fakeTimerFiles);
    for (const file of unitFastTimerTestFiles) {
      expect(paths.isUnitFastTimerTestFile(file)).toBe(true);
      expect(paths.resolveUnitFastTestIncludePattern(file)).toBeNull();
      expect(paths.resolveUnitFastTimerTestIncludePattern(file)).toBe(file);
    }

    const timerConfig = createUnitFastFakeTimersVitestConfig({}).test!;
    expect(timerConfig).toMatchObject({
      include: unitFastTimerTestFiles,
      isolate: false,
      fileParallelism: false,
      maxWorkers: 1,
      sequence: { groupOrder: 1 },
      setupFiles: envSetup,
    });
    expect(normalizeConfigPath(timerConfig.runner)).toBe("test/non-isolated-runner.ts");
  });

  it("keeps broad audit candidates separate from automatically routed unit-fast tests", () => {
    expect(paths.collectBroadUnitFastTestCandidates().length).toBeGreaterThan(
      paths.collectUnitFastTestCandidates().length,
    );
    const broad = paths.collectUnitFastTestFileAnalysis(process.cwd(), { scope: "broad" });
    expect(broad.filter((entry) => entry.unitFast).length).toBeGreaterThan(
      unitFastTestFiles.length,
    );
  });

  it("keeps scoped unit-fast exclusions equivalent to the full inventory", () => {
    const cases = [
      { dir: "src/hooks", patterns: ["src/hooks/**/*.test.ts"] },
      { dir: "src", patterns: ["src/agents/*/**/*.test.ts"] },
      { dir: "src/acp", patterns: ["src/acp/client.test.ts"] },
      { dir: "extensions", patterns: ["extensions/**/*.test.ts"] },
      { dir: undefined, patterns: ["test/**/*.test.ts"] },
      { dir: undefined, patterns: ["src/{hooks,infra}/**/*.test.ts"] },
      { dir: "src", patterns: [] },
    ];

    for (const { dir, patterns } of cases) {
      const prefix = dir ? `${dir}/` : "";
      const expected = unitFastTestFiles.filter(
        (file) =>
          file.startsWith(prefix) && patterns.some((pattern) => path.matchesGlob(file, pattern)),
      );
      expect(paths.getUnitFastTestFilesForIncludePatterns(patterns, { dir })).toEqual(expected);
      for (const files of [
        paths.getUnitFastTestFiles,
        paths.getUnitFastTimerTestFiles,
        paths.getUnitFastIsolatedTestFiles,
      ]) {
        expect(files(patterns)).toEqual(
          files().filter((file) => patterns.some((pattern) => path.matchesGlob(file, pattern))),
        );
      }
    }

    const extensionUnitFastFiles = paths.getUnitFastTestFilesForIncludePatterns(
      ["extensions/**/*.test.ts"],
      { dir: "extensions" },
    );
    expect(
      paths.getUnitFastTestFilesForIncludePatterns(["**/*.test.ts"], { dir: "extensions" }),
    ).toEqual(extensionUnitFastFiles);
    expect(paths.getUnitFastTestFilesForIncludePatterns(["!src/**/*.test.ts"])).toEqual(
      unitFastTestFiles,
    );
  });
});
