import { execFileSync, spawnSync, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  BUILD_ALL_STEPS,
  formatBuildAllDuration,
  formatBuildAllTimingSummary,
  parseBuildAllArgs,
  resolveBuildAllEnvironment,
  resolveBuildAllStep,
  resolveBuildAllSteps,
  runBuildAllSteps,
} from "../../scripts/build-all.mts";
import {
  assertBuiltArtifactPermissions,
  normalizeBuildArtifactPermissions,
} from "../../scripts/check-artifact-permissions.mts";
import {
  resolveBuildStepCacheState,
  writeBuildStepCacheStamp,
  resolveBuildStepCacheStampState,
  restoreBuildStepCacheOutputs,
  finalizeBuildStepCache,
  type BuildCache,
} from "../../scripts/lib/build-artifact-cache.mts";
import { listBundledPluginBuildEntries } from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import * as liveGatewayDistFence from "../../scripts/lib/live-gateway-dist-fence.mts";
import { createManagedCommandInvocation } from "../../scripts/lib/managed-child-process.mts";
import {
  copyStaticExtensionAssets,
  copyStaticExtensionAssetsToRuntimeOverlay,
} from "../../scripts/lib/static-extension-assets.mts";
import { TSDOWN_UNIFIED_CONFIG_GROUP } from "../../scripts/lib/tsdown-config-groups.mts";
import { stageBundledPluginRuntime } from "../../scripts/stage-bundled-plugin-runtime.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runNodeMain } from "./run-node-boundary.test-support.js";
import { toolingProbeRuntimeEntrypoints } from "./tooling-probe-runtime.test-support.mts";

beforeEach(() => {
  const fence = vi
    .spyOn(liveGatewayDistFence, "resolveLiveManagedGatewayDistFence")
    .mockResolvedValue({ refuse: false });
  onTestFinished(() => fence.mockRestore());
});

vi.mock("../../src/cli/update-cli/update-command-service-publication.js", () => ({
  withGatewayRuntimeArtifactPublication: async (
    _params: unknown,
    publish: () => Promise<unknown>,
  ) => publish(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
const buildArtifactCacheUrl = resolveRuntimeWorkerUrl(
  toolingProbeRuntimeEntrypoints.buildArtifactCache,
);

function getBuildAllStep(label: string) {
  const step = BUILD_ALL_STEPS.find((entry) => entry.label === label);
  if (!step) {
    throw new Error(`Missing build-all step ${label}`);
  }
  return step;
}

function buildMemoryLimit(cgroupGiB: number) {
  // A cgroup-only fixture still reads Linux MemAvailable. Pin the host facts so
  // concurrent CI work cannot change the admission this scenario exercises.
  return {
    platform: "linux",
    availableMemoryBytes: 16 * 1024 ** 3,
    procMemTotalBytes: 16 * 1024 ** 3,
    cgroupMemoryLimitBytes: cgroupGiB * 1024 ** 3,
  };
}

function buildRunner() {
  return {
    env: {},
    logger: { error: vi.fn(), warn: vi.fn() },
    memoryLimit: buildMemoryLimit(5),
    resolveCacheState: vi.fn(() => ({ cacheable: false, fresh: false, reason: "no-cache" })),
    runStep: vi.fn<(invocation: ReturnType<typeof resolveBuildAllStep>) => { status: number }>(
      () => ({ status: 0 }),
    ),
  };
}

function writeFixture(root: string, file: string, contents: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

function buildCacheFixture(cache: Partial<BuildCache> = {}, label = "cached") {
  const rootDir = tempDirs.make("openclaw-build-cache-");
  const inputPath = writeFixture(rootDir, "src/input.ts", "input");
  const outputPath = writeFixture(rootDir, "dist/output.js", "output");
  const step = { label, cache: { inputs: ["src"], outputs: ["dist"], ...cache } };
  const params = { rootDir };
  const lookup = () => resolveBuildStepCacheState(step, params);
  const publish = () => {
    const state = lookup();
    writeBuildStepCacheStamp(step, state, params);
    return state;
  };
  return { rootDir, inputPath, outputPath, step, params, lookup, publish };
}

describe("resolveBuildAllStep", () => {
  it("pins one generated timestamp across every child build", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const buildEnv = resolveBuildAllEnvironment(
      { FOO: "bar" },
      () => new Date("2026-07-10T12:34:56.789Z"),
      () => commit,
    );
    const uiInvocation = resolveBuildAllStep(getBuildAllStep("ui:build"), {
      env: buildEnv,
    });
    const buildInfoInvocation = resolveBuildAllStep(getBuildAllStep("write-build-info"), {
      env: buildEnv,
    });
    expect(uiInvocation.options.env).toMatchObject({
      FOO: "bar",
      GIT_COMMIT: commit,
      OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T12:34:56.789Z",
    });
    expect(buildInfoInvocation.options.env.OPENCLAW_BUILD_TIMESTAMP).toBe(
      uiInvocation.options.env.OPENCLAW_BUILD_TIMESTAMP,
    );
  });

  it("pins the first explicit full commit alias and rejects malformed values", () => {
    const gitSha = "A".repeat(40);
    expect(
      resolveBuildAllEnvironment(
        { GIT_SHA: gitSha, GITHUB_SHA: "b".repeat(40) },
        () => new Date("2026-07-10T12:34:56.000Z"),
        () => "c".repeat(40),
      ).GIT_COMMIT,
    ).toBe(gitSha.toLowerCase());
    expect(() =>
      resolveBuildAllEnvironment({ GIT_COMMIT: "deadbeef" }, undefined, () => null),
    ).toThrow("full 40-character hexadecimal SHA");
  });

  it("passes encoded import URLs literally to managed Node on Windows", () => {
    const importUrl = "file:///C:/Users/RUNNER%7E1/Project/scripts/tsx.mjs";
    const result = resolveBuildAllStep(
      { label: "tsdown-unified", args: ["--import", importUrl, "scripts/tsdown-build.mts"] },
      { nodeExecPath: "C:\\Program Files\\nodejs\\node.exe", env: {} },
    );

    expect(
      createManagedCommandInvocation({
        bin: result.command,
        args: result.args,
        ...result.options,
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["--import", importUrl, "scripts/tsdown-build.mts"],
      shell: false,
      windowsVerbatimArguments: undefined,
    });
  });

  it.each([false, true])(
    "runs plugin builds through managed Node on Windows (defer isolated: %s)",
    (deferIsolatedAssets) => {
      const args = [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/bundled-plugin-assets.mts",
        "--phase",
        "build",
        ...(deferIsolatedAssets ? ["--defer-isolated"] : []),
      ];
      const result = resolveBuildAllStep(getBuildAllStep("plugins:assets:build"), {
        nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
        env: { OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
        deferIsolatedAssets,
      });
      expect(
        createManagedCommandInvocation({
          bin: result.command,
          args: result.args,
          ...result.options,
          platform: "win32",
        }),
      ).toEqual({
        command: "C:\\Program Files\\nodejs\\node.exe",
        args,
        shell: false,
        windowsVerbatimArguments: undefined,
      });
      expect(result.options).toEqual({
        stdio: "inherit",
        env: { OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
        shell: false,
      });
    },
  );
});

describe("resolveBuildAllSteps", () => {
  it.each([
    ["full", "0"],
    ["full", "1"],
    ["package", "0"],
    ["package", "1"],
    ["ciArtifacts", "0"],
  ])(
    "generates native protocol models before compiling %s with skip-dts=%s",
    async (profile, skipDts) => {
      const runner = buildRunner();
      const result = await runBuildAllSteps(profile, {
        ...runner,
        cacheEnabled: false,
        env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: skipDts },
      });
      expect(result.exitCode).toBe(0);
      const invocations = runner.runStep.mock.calls.map(([invocation]) => invocation);
      const generation = invocations.findIndex(({ args }) =>
        args.includes("scripts/prepare-native-protocol.mjs"),
      );
      const compilation = invocations.findIndex(({ args }) =>
        args.includes("scripts/tsdown-build.mts"),
      );
      expect(generation).toBeGreaterThanOrEqual(0);
      expect(compilation).toBeGreaterThan(generation);
    },
  );

  it("rebuilds UI after runtime cleanup without reusing stale build metadata", () => {
    const steps = resolveBuildAllSteps("full");
    const labels = steps.map(({ label }) => label);
    const ui = expectDefined(
      steps.find(({ label }) => label === "ui:build"),
      "UI build",
    );
    expect(ui.cache).toBeUndefined();
    expect(labels.indexOf("ui:build")).toBeGreaterThan(labels.indexOf("runtime-postbuild-stamp"));
    expect(labels.indexOf("ui:build")).toBeLessThan(labels.indexOf("write-build-info"));
  });

  it("parses build-all CLI args before any build work", () => {
    expect(parseBuildAllArgs([])).toEqual({ help: false, profile: "full" });
    expect(parseBuildAllArgs(["cliStartup"])).toEqual({ help: false, profile: "cliStartup" });
    expect(parseBuildAllArgs(["cliStartup", "--help"])).toEqual({
      help: true,
      profile: "cliStartup",
    });
    expect(() => parseBuildAllArgs(["cliStartup", "--bogus"])).toThrow("unknown argument: --bogus");
    expect(() => parseBuildAllArgs(["wat"])).toThrow("Unknown build profile: wat");
  });

  it("refuses package before build or cache work when memory is insufficient", async () => {
    const runner = buildRunner();
    const restoreCache = vi.fn(() => true);
    const finalizeCache = vi.fn(() => true);
    const result = await runBuildAllSteps("package", {
      ...runner,
      restoreCache,
      finalizeCache,
      memoryLimit: buildMemoryLimit(4),
    });
    expect(result).toEqual({ exitCode: 1, timings: [] });
    for (const operation of [
      runner.runStep,
      runner.resolveCacheState,
      restoreCache,
      finalizeCache,
    ]) {
      expect(operation).not.toHaveBeenCalled();
    }
    expect(runner.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Stopping before any build output is removed"),
    );
    expect(runner.logger.warn).not.toHaveBeenCalled();
  });

  it("returns admissionRefused when the live Gateway fence refuses before any step", async () => {
    const message = "[openclaw] Refusing to rebuild dist while a managed Gateway is still running.";
    vi.spyOn(liveGatewayDistFence, "resolveLiveManagedGatewayDistFence").mockResolvedValue({
      refuse: true,
      message,
    });
    const runner = { ...buildRunner(), memoryLimit: undefined };
    expect(await runBuildAllSteps("full", runner)).toEqual({
      exitCode: 1,
      timings: [],
      admissionRefused: true,
    });
    expect(runner.runStep).not.toHaveBeenCalled();
    expect(runner.resolveCacheState).not.toHaveBeenCalled();
    expect(runner.logger.error).toHaveBeenCalledWith(message);
  });

  it.each([
    { profile: "gatewayWatch", restore: false },
    { profile: "cliStartup", restore: false },
    { profile: "gatewayWatch", restore: true },
    { profile: "cliStartup", restore: true },
  ])(
    "records $profile runtime phase and selected UI plugin completeness (restore=$restore)",
    async ({ profile, restore }) => {
      const cwd = tempDirs.make("openclaw-phase-stamp-");
      fs.mkdirSync(path.join(cwd, "extensions"));
      writeFixture(cwd, "package.json", '{"name":"openclaw","type":"module"}');
      writeFixture(
        cwd,
        "tsdown.config.ts",
        'export default {entry:{entry:"src/entry.ts"},outDir:"dist",outExtensions:()=>({js:".js"})};',
      );
      writeFixture(cwd, "dist/entry.js", "export {};\n");
      const manifest = JSON.stringify({
        id: "demo",
        controlUi: { entry: "dist/control-ui/index.js" },
      });
      writeFixture(cwd, "extensions/demo/index.ts", "export {};\n");
      writeFixture(cwd, "extensions/demo/openclaw.plugin.json", manifest);
      writeFixture(
        cwd,
        "extensions/demo/package.json",
        JSON.stringify({
          name: "@openclaw/demo",
          openclaw: {
            extensions: ["./index.ts"],
            build: { staticAssets: [{ source: "assets/help.txt", output: "assets/help.txt" }] },
          },
        }),
      );
      for (const prefix of ["dist/extensions", "dist-runtime/extensions"]) {
        writeFixture(cwd, `${prefix}/demo/index.js`, "export {};\n");
        writeFixture(cwd, `${prefix}/demo/openclaw.plugin.json`, manifest);
        writeFixture(cwd, `${prefix}/demo/package.json`, '{"name":"@openclaw/demo"}');
      }
      const steps = resolveBuildAllSteps(profile, {})
        .filter((step) => ["runtime-postbuild", "runtime-postbuild-stamp"].includes(step.label))
        .map((step) =>
          step.label === "runtime-postbuild"
            ? Object.assign({}, step, { args: ["-e", "process.exit(0)"] })
            : step,
        );
      const cachedStep = {
        label: "restored-artifacts",
        args: ["-e", "process.exit(0)"],
        cache: {
          inputs: ["package.json"],
          outputs: ["dist", "dist-runtime"],
          restore: "always" as const,
        },
      };
      if (restore) {
        // A previous/full plan restored by a cache is not the current profile's authority.
        writeFixture(cwd, "dist/runtime-artifact-plan.json", '{"staticAssets":true}');
        const cacheParams = { rootDir: cwd };
        writeBuildStepCacheStamp(
          cachedStep,
          resolveBuildStepCacheState(cachedStep, cacheParams),
          cacheParams,
        );
        fs.rmSync(path.join(cwd, "dist"), { recursive: true });
        fs.rmSync(path.join(cwd, "dist-runtime"), { recursive: true });
        steps.unshift(cachedStep);
      }
      const result = await runBuildAllSteps(profile, {
        cwd,
        env: {},
        steps,
        resolveCacheState: (step) => resolveBuildStepCacheState(step, { rootDir: cwd, env: {} }),
        restoreCache: (state) => restoreBuildStepCacheOutputs(state, { rootDir: cwd }),
        logger: { error() {}, warn() {} },
        memoryLimit: buildMemoryLimit(16),
      });
      expect(result.exitCode).toBe(0);
      expect(
        JSON.parse(fs.readFileSync(path.join(cwd, "dist/.runtime-postbuildstamp"), "utf8"))
          .staticAssets,
      ).toBe(false);
      const plan = JSON.parse(
        fs.readFileSync(path.join(cwd, "dist/runtime-artifact-plan.json"), "utf8"),
      );
      expect(plan.staticAssets).toBe(false);
      expect(plan.plugins).toMatchObject([
        { id: "demo", controlUi: { entry: "dist/control-ui/index.js" } },
      ]);
      expect(plan.requiredFiles).not.toContain("dist/extensions/demo/dist/control-ui/index.js");
      expect(plan.requiredFiles).not.toContain("dist/extensions/demo/assets/help.txt");
      expect(result.timings.at(-1)?.label).toBe("artifact-permissions");
      if (restore) {
        expect(result.timings[0]).toMatchObject({ label: "restored-artifacts", status: "cached" });
      }
    },
  );

  it("copies selected Docker plugin UI assets before runtime overlay publication and acceptance", async () => {
    const cwd = tempDirs.make("openclaw-docker-plugin-ui-order-");
    const uiRoot = `dist/control-ui/${"a".repeat(64)}`;
    const controlUi = { entry: `${uiRoot}/index.js`, styles: [`${uiRoot}/index.css`] };
    writeFixture(cwd, "package.json", '{"name":"openclaw","type":"module"}');
    writeFixture(cwd, "pnpm-workspace.yaml", "packages:\n  - extensions/*\n");
    writeFixture(
      cwd,
      "tsdown.config.ts",
      'export default {entry:{entry:"src/entry.ts"},outDir:"dist",outExtensions:()=>({js:".js"})};',
    );
    writeFixture(cwd, "dist/entry.js", "export {};\n");
    for (const id of ["demo", "sibling"]) {
      const manifest = JSON.stringify({ id, ...(id === "demo" ? { controlUi } : {}) });
      const pkg = JSON.stringify({
        name: `@openclaw/${id}`,
        type: "module",
        openclaw: {
          extensions: ["./index.ts"],
          build: { staticAssets: [{ source: "assets/help.txt", output: "assets/help.txt" }] },
        },
      });
      writeFixture(cwd, `extensions/${id}/index.ts`, "export {};\n");
      writeFixture(cwd, `extensions/${id}/package.json`, pkg);
      writeFixture(cwd, `extensions/${id}/openclaw.plugin.json`, manifest);
      writeFixture(cwd, `extensions/${id}/assets/help.txt`, `${id} help\n`);
      writeFixture(cwd, `dist/extensions/${id}/index.js`, "export {};\n");
      writeFixture(cwd, `dist/extensions/${id}/package.json`, pkg);
      writeFixture(cwd, `dist/extensions/${id}/openclaw.plugin.json`, manifest);
    }
    writeFixture(cwd, `extensions/demo/${controlUi.entry}`, "export const browserAsset = true;\n");
    writeFixture(cwd, `extensions/demo/${controlUi.styles[0]}`, ".demo { color: red; }\n");
    // Run the real --copy entrypoint in an owned checkout while borrowing only
    // its source/dependency imports, never the serving checkout's output roots.
    fs.mkdirSync(path.join(cwd, "scripts"));
    fs.copyFileSync(
      path.resolve("scripts/build-plugin-control-ui.mts"),
      path.join(cwd, "scripts/build-plugin-control-ui.mts"),
    );
    for (const [source, destination] of [
      ["src", "src"],
      ["node_modules", "node_modules"],
      ["scripts/lib", "scripts/lib"],
    ]) {
      fs.symlinkSync(path.resolve(source!), path.join(cwd, destination!), "junction");
    }
    const env = {
      ...process.env,
      GIT_COMMIT: "b".repeat(40),
      OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: undefined,
      OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: undefined,
      OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: undefined,
    };
    const copyUi = () =>
      execFileSync(
        testNodeExecPath,
        [
          "--import",
          path.resolve("scripts/tsx.mjs"),
          "scripts/build-plugin-control-ui.mts",
          "extensions/demo",
          "--copy",
        ],
        { cwd, env, stdio: "pipe" },
      );
    const postbuildOverlay = () => {
      stageBundledPluginRuntime({ repoRoot: cwd });
      copyStaticExtensionAssets({ rootDir: cwd, env });
      copyStaticExtensionAssetsToRuntimeOverlay({ rootDir: cwd, env });
    };
    const params = { rootDir: cwd, env, readFiles: true };

    // The real native Docker failure: postbuild cannot stage UI files that the
    // package's copy hook has not installed yet. Root assets alone are insufficient.
    postbuildOverlay();
    copyUi();
    await normalizeBuildArtifactPermissions(params);
    expect(() => assertBuiltArtifactPermissions(params)).toThrow(
      `dist-runtime/extensions/demo/${controlUi.styles[0]}`,
    );
    fs.rmSync(path.join(cwd, "dist/extensions/demo/dist"), { recursive: true });

    const dockerScript: string = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts[
      "build:docker"
    ];
    const phases = dockerScript
      .split(" && ")
      .filter(
        (command) =>
          command === "pnpm plugins:assets:copy" ||
          command === "node scripts/runtime-postbuild.mjs",
      );
    expect(phases).toHaveLength(2);
    for (const phase of phases) {
      if (phase === "pnpm plugins:assets:copy") {
        copyUi();
      } else {
        postbuildOverlay();
      }
    }
    await normalizeBuildArtifactPermissions(params);
    expect(assertBuiltArtifactPermissions(params)).toMatchObject({ plugins: 2, readFiles: true });
    expect(fs.readFileSync(path.join(cwd, "dist/extensions/demo", controlUi.entry), "utf8")).toBe(
      "export const browserAsset = true;\n",
    );
    expect(
      fs.statSync(path.join(cwd, "dist-runtime/extensions/demo", controlUi.entry)).isFile(),
    ).toBe(true);
    for (const prefix of ["dist/extensions", "dist-runtime/extensions"]) {
      expect(fs.readFileSync(path.join(cwd, prefix, "demo", controlUi.styles[0]!), "utf8")).toBe(
        ".demo { color: red; }\n",
      );
      expect(fs.readFileSync(path.join(cwd, prefix, "sibling/assets/help.txt"), "utf8")).toBe(
        "sibling help\n",
      );
      expect(fs.statSync(path.join(cwd, prefix, "sibling/index.js")).isFile()).toBe(true);
    }
  });

  it("invalidates old runtime stamps before a failed declaration-cache restoration", async () => {
    const cwd = tempDirs.make("openclaw-restore-stamps-");
    fs.mkdirSync(path.join(cwd, "dist"));
    const stamps = [".buildstamp", ".runtime-postbuildstamp"].map((name) =>
      path.join(cwd, "dist", name),
    );
    for (const stamp of stamps) {
      fs.writeFileSync(stamp, "previous valid generation");
    }
    await expect(
      runBuildAllSteps("pluginSdkStrictSmoke", {
        cwd,
        env: {},
        memoryLimit: buildMemoryLimit(16),
        logger: { error() {}, warn() {} },
        steps: [getBuildAllStep("tsdown-ai"), getBuildAllStep("build-stamp")],
        resolveCacheState: () => ({
          cacheable: true,
          fresh: true,
          restorable: true,
          reason: "fresh-cache",
          signature: "fixture",
          outputRoot: cwd,
          stampPath: path.join(cwd, "cache.json"),
          inputFiles: 1,
          outputFiles: 1,
          relativeOutputFiles: ["dist/entry.js"],
          stampedOutputs: ["dist/entry.js"],
          record: undefined,
        }),
        restoreCache() {
          expect(stamps.some((file) => fs.existsSync(file))).toBe(false);
          fs.writeFileSync(path.join(cwd, "dist/entry.js"), "partial restoration");
          return false;
        },
      }),
    ).rejects.toThrow("Build cache changed before restoration");
    expect(stamps.some((file) => fs.existsSync(file))).toBe(false);
  });

  it("admits package once and freezes its heap for every child", async () => {
    const profile = "package";
    const tsdownSteps = resolveBuildAllSteps(profile).filter(
      (step) => step.label.startsWith("tsdown-") || step.label === "write-unified-entry-dts",
    );
    const tsdownInvocations: ReturnType<typeof resolveBuildAllStep>[] = [];
    const executionOrder: string[] = [];
    const restoreCache = vi.fn(() => true);
    const result = await runBuildAllSteps(profile, {
      cacheEnabled: true,
      env: {},
      finalizeCache: vi.fn(() => true),
      logger: { error: vi.fn(), warn: vi.fn() },
      memoryLimit: buildMemoryLimit(5),
      now: () => 0,
      resolveCacheState(step) {
        executionOrder.push(`cache:${step.label}`);
        return step.label === "tsdown-packages"
          ? {
              cacheable: true,
              fresh: true,
              restorable: true,
              reason: "fresh-cache",
            }
          : { cacheable: false, fresh: false, reason: "no-cache" };
      },
      restoreCache,
      runStep(invocation) {
        executionOrder.push(
          `run:${expectDefined(tsdownSteps[tsdownInvocations.length], "next tsdown step").label}`,
        );
        tsdownInvocations.push(invocation);
        return { status: 0 };
      },
      steps: tsdownSteps,
    });

    expect(result.exitCode).toBe(0);
    expect(tsdownInvocations).toHaveLength(4);
    for (const invocation of tsdownInvocations) {
      expect(invocation.options.env.OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB).toBe("4352");
      expect(invocation.options.env.NODE_OPTIONS).toBe("--max-old-space-size=4352");
    }
    expect(restoreCache).toHaveBeenCalledOnce();
    expect(executionOrder).toEqual([
      "cache:tsdown-ai",
      "run:tsdown-ai",
      "cache:tsdown-packages",
      "run:tsdown-packages",
      "cache:tsdown-unified",
      "run:tsdown-unified",
      "cache:write-unified-entry-dts",
      "run:write-unified-entry-dts",
    ]);
  });

  it.each([
    {
      label: "CI ambient heap above the cgroup budget",
      env: { NODE_OPTIONS: "--max-old-space-size=8192" },
      cgroupGiB: 7,
      heapMb: 6400,
      nodeOptions: "--max-old-space-size=6400",
      warns: false,
    },
    {
      label: "explicit override",
      env: {
        NODE_OPTIONS: "--trace-warnings --max-old-space-size=8192",
        OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: "4096",
      },
      cgroupGiB: 4,
      heapMb: 4096,
      nodeOptions: "--trace-warnings --max-old-space-size=4096",
      warns: true,
    },
  ])(
    "hands the cold ciArtifacts writer an effective child heap from $label",
    async ({ env, cgroupGiB, heapMb, nodeOptions, warns }) => {
      const runner = buildRunner();
      const { logger } = runner;
      const result = await runBuildAllSteps("ciArtifacts", {
        ...runner,
        env,
        memoryLimit: buildMemoryLimit(cgroupGiB),
        resolveCacheState: () => ({ cacheable: true, fresh: false, reason: "missing-inputs" }),
      });
      const invocations = runner.runStep.mock.calls.map(([invocation]) => invocation);
      expect(result.exitCode).toBe(0);
      const writer = expectDefined(
        invocations.find((invocation) =>
          invocation.args.includes("scripts/write-plugin-sdk-entry-dts.ts"),
        ),
        "SDK declaration writer invocation",
      );
      expect(writer.options.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe("0");

      // Probe the writer's actual launch environment without compiling the declaration graph.
      // A CLI flag supplies an independent reference across Node versions' V8 overheads.
      const probeArgs = ["-p", 'require("node:v8").getHeapStatistics().heap_size_limit'];
      const probeOptions = {
        ...writer.options,
        stdio: "pipe" as const,
        encoding: "utf8" as const,
        timeout: 10_000,
      };
      const actual = spawnSync(writer.command, probeArgs, probeOptions);
      const expected = spawnSync(
        writer.command,
        [`--max-old-space-size=${heapMb}`, ...probeArgs],
        probeOptions,
      );
      expect(actual.status, actual.stderr).toBe(0);
      expect(expected.status, expected.stderr).toBe(0);
      expect(Number(actual.stdout)).toBe(Number(expected.stdout));
      for (const invocation of invocations) {
        expect(invocation.options.env.NODE_OPTIONS).toBe(nodeOptions);
        expect(invocation.options.env.OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB).toBe(String(heapMb));
      }
      expect(logger.warn).toHaveBeenCalledTimes(warns ? 1 : 0);
    },
  );
  it.each(["strictSmoke"])(
    "does not validate %s after declaration publication fails",
    async (profile) => {
      const result = await runBuildAllSteps(profile, {
        env: {},
        logger: { error: vi.fn(), warn: vi.fn() },
        memoryLimit: buildMemoryLimit(5),
        resolveCacheState: () => ({ cacheable: false, fresh: false, reason: "no-cache" }),
        runStep: (invocation) => ({
          status: invocation.args.includes("scripts/write-unified-entry-dts.ts") ? 23 : 0,
        }),
      });
      const labels = result.timings.map((timing) => timing.label);

      expect(result.exitCode).toBe(23);
      expect(labels).toEqual(
        expect.arrayContaining([
          "tsdown-ai",
          "tsdown-packages",
          "tsdown-unified",
          "write-unified-entry-dts",
        ]),
      );
      expect(labels.at(-1)).toBe("write-unified-entry-dts");
      expect(labels).not.toContain("check-plugin-sdk-exports");
      for (const step of ["write-build-info", "write-cli-startup-metadata"]) {
        expect(resolveBuildAllSteps(profile).some(({ label }) => label === step)).toBe(false);
      }
    },
  );
  it.each([undefined, "0"])(
    "preserves source-run declaration choice %s through the canonical runtime build",
    async (skipDts) => {
      const cwd = fs.realpathSync(tempDirs.make("openclaw-source-rebuild-"));
      // Artifact ownership must stop at this fixture, even inside another checkout.
      fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "openclaw" }));
      fs.writeFileSync(path.join(cwd, "pnpm-workspace.yaml"), "packages: []\n");
      const childEnv = {
        OPENCLAW_BUILD_PRIVATE_QA: "1",
        OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: skipDts,
      };
      const spawn = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      });
      const postbuild = vi.fn();
      expect(
        await runNodeMain({
          cwd,
          env: childEnv,
          args: ["status"],
          spawn,
          spawnSync: () => ({ status: 1 }),
          stderr: { write: () => true },
          runRuntimePostBuild: postbuild,
        }),
      ).toBe(0);
      expect(spawn.mock.calls.map(([, args]) => args)).toEqual([
        [
          "--import",
          expect.stringMatching(/\/scripts\/tsx\.mjs$/),
          expect.stringMatching(/[\\/]scripts[\\/]lib[\\/]dist-artifact-ownership\.mts$/),
          expect.stringMatching(/\/scripts\/build-all\.mts$/),
          "qaRuntime",
        ],
        ["openclaw.mjs", "status"],
      ]);
      const env = spawn.mock.calls[0]![2].env!;
      const runner = buildRunner();
      const result = await runBuildAllSteps("qaRuntime", { ...runner, env });
      const invocations = runner.runStep.mock.calls.map(([invocation]) => invocation);
      expect(result.exitCode).toBe(0);
      const compiler = invocations.find((call) => call.args.includes("scripts/tsdown-build.mts"))!;
      expect(compiler.options.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe(skipDts ?? "1");
      expect(invocations.every((call) => call.options.env.OPENCLAW_BUILD_PRIVATE_QA === "1")).toBe(
        true,
      );
      expect(result.timings.map(({ label }) => label)).toEqual([
        "plugins:assets:build",
        "tsdown",
        "external-plugins:local-dist",
        "check-cli-bootstrap-imports",
        "plugins:assets:copy",
        "runtime-postbuild",
        "build-stamp",
        "runtime-postbuild-stamp",
      ]);
      expect(postbuild).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(cwd, ".artifacts/run-node-build.lock"))).toBe(false);
      expect(fs.existsSync(path.join(cwd, ".artifacts/dist-artifacts.lock/owner.json"))).toBe(
        false,
      );
    },
  );
  it.each([
    { name: "ordinary build", profile: "full", env: {}, runtimeOnly: false, skipDts: undefined },
    {
      name: "runtime override",
      profile: "package",
      env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
      runtimeOnly: true,
      skipDts: "1",
    },
    {
      name: "legacy updater marker",
      profile: "full",
      env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      runtimeOnly: true,
      skipDts: "1",
    },
    {
      name: "explicit declarations during update",
      profile: "package",
      env: { OPENCLAW_UPDATE_IN_PROGRESS: "1", OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" },
      runtimeOnly: false,
      skipDts: "0",
    },
  ])(
    "honors $name in selected steps and compiler children",
    async ({ profile, env: overrides, runtimeOnly, skipDts }) => {
      const env = { OPENCLAW_DEV_SOURCE_ROOT: "/serving-checkout", ...overrides };
      const originalEnv = { ...env };
      const runner = buildRunner();
      const result = await runBuildAllSteps(profile, { ...runner, cacheEnabled: false, env });
      const invocations = runner.runStep.mock.calls.map(([invocation]) => invocation);

      expect(result.exitCode).toBe(0);
      const labels = result.timings.map((timing) => timing.label);
      expect(labels).toEqual(
        resolveBuildAllSteps(profile, {
          OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: runtimeOnly ? "1" : "0",
        }).map((step) => step.label),
      );
      expect(labels).not.toContain("write-plugin-sdk-entry-dts");
      expect(labels.includes("write-unified-entry-dts")).toBe(!runtimeOnly);
      expect(labels.includes("check-plugin-sdk-exports")).toBe(!runtimeOnly);
      expect(labels.includes("clean:dist")).toBe(profile === "package");
      const compilers = invocations.filter((call) =>
        call.args.includes("scripts/tsdown-build.mts"),
      );
      expect(compilers).toHaveLength(runtimeOnly ? 1 : 3);
      for (const compiler of compilers) {
        expect(compiler.options.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe(
          compiler.args.includes(TSDOWN_UNIFIED_CONFIG_GROUP) ? "1" : skipDts,
        );
      }
      for (const invocation of invocations) {
        expect(invocation.options.env.OPENCLAW_DEV_SOURCE_ROOT).toBe(
          env.OPENCLAW_UPDATE_IN_PROGRESS === "1" ? process.cwd() : "/serving-checkout",
        );
      }
      expect(env).toEqual(originalEnv);
    },
  );
  it("rejects unknown build profiles", () => {
    expect(() => resolveBuildAllSteps("wat")).toThrow("Unknown build profile: wat");
  });
});
describe("build-all timing output", () => {
  it("formats short and long phase durations compactly", () => {
    expect(formatBuildAllDuration(42.4)).toBe("42ms");
    expect(formatBuildAllDuration(1234)).toBe("1.23s");
    expect(formatBuildAllDuration(12345)).toBe("12.3s");
  });

  it("summarizes phases slowest first with total time and status", () => {
    expect(
      formatBuildAllTimingSummary([
        { label: "tsdown", status: "ran", durationMs: 99000 },
        { label: "plugins:assets:copy", status: "cached", durationMs: 12 },
        { label: "write-plugin-sdk-entry-dts", status: "ran", durationMs: 34567 },
      ]),
    ).toBe(
      "[build-all] phase timings: total 2m 13.6s; slowest tsdown 1m 39s; write-plugin-sdk-entry-dts 34.6s; plugins:assets:copy (cached) 12ms",
    );
  });
});

describe("resolveBuildStepCacheState", () => {
  it("lists large nested inventories without an argument-count limit", () => {
    const { rootDir } = buildCacheFixture();
    // Builds run on the main Node thread; Vitest workers have a different stack budget.
    const result = spawnSync(
      testNodeExecPath,
      [
        ...resolveRuntimeWorkerArgv(buildArtifactCacheUrl, testNodeExecPath).slice(0, -1),
        "--input-type=module",
        "-e",
        `
            import assert from "node:assert/strict";
            import fs from "node:fs";
            import path from "node:path";
            import { listCacheFiles } from ${JSON.stringify(buildArtifactCacheUrl.href)};
            const root = process.argv[1];
            const directory = path.join(root, "src");
            const [template] = fs.readdirSync(directory, { withFileTypes: true });
            const entries = Array.from({ length: 200_000 }, (_, index) =>
              new Proxy(template, {
                get(target, key, receiver) {
                  return key === "name" ? index + ".ts" : Reflect.get(target, key, receiver);
                },
              }),
            );
            const wideFs = new Proxy(fs, {
              get(target, key, receiver) {
                return key === "readdirSync"
                  ? (file, options) => file === directory ? entries : fs.readdirSync(file, options)
                  : Reflect.get(target, key, receiver);
              },
            });
            assert.deepEqual(
              listCacheFiles(root, [{ path: ".", extensions: [".ts"] }], wideFs),
              entries.map((entry) => path.join(directory, entry.name)).toSorted(),
            );
          `,
        rootDir,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a snapshot replaced after lookup without changing live outputs", () => {
    const f = buildCacheFixture();
    f.publish();
    fs.rmSync(f.outputPath);
    const pending = f.lookup();
    expect(pending.restorable).toBe(true);
    fs.writeFileSync(f.outputPath, "next complete generation");
    f.publish();
    expect(restoreBuildStepCacheOutputs(pending, f.params)).toBe(false);
    expect(fs.readFileSync(f.outputPath, "utf8")).toBe("next complete generation");
  });

  it("invalidates publication before copying and never accepts a partial cached tree", () => {
    const f = buildCacheFixture();
    const state = f.publish();
    fs.writeFileSync(f.outputPath, "changed bytes");
    const rename = fs.renameSync.bind(fs);
    const fail = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (String(target).startsWith(state.outputRoot!)) {
        expect(fs.existsSync(state.stampPath!)).toBe(false);
        throw new Error("fixture copy failure");
      }
      return rename(source, target);
    });
    try {
      expect(() => f.publish()).toThrow("fixture copy failure");
    } finally {
      fail.mockRestore();
    }
    expect(fs.existsSync(state.stampPath!)).toBe(false);
    expect(f.lookup()).toMatchObject({ fresh: false, restorable: false });
  });

  it("restores exact declaration snapshots across checkout roots", () => {
    const cacheRoot = tempDirs.make("openclaw-shared-build-cache-");
    const source = buildCacheFixture(
      {
        outputs: [{ path: "dist", extensions: [".d.ts", ".d.mts", ".d.cts"] }],
        restore: "always",
      },
      "tsdown-unified",
    );
    const target = buildCacheFixture();
    const env = { BUILD_ALL_CACHE_ROOT: cacheRoot };
    writeFixture(
      source.rootDir,
      "dist/plugin-sdk/current.d.ts",
      "export declare const current: true;",
    );
    const removedDts = writeFixture(target.rootDir, "dist/plugin-sdk/removed.d.ts", "obsolete");
    const removedJs = writeFixture(target.rootDir, "dist/plugin-sdk/removed.js", "runtime");
    const sourceParams = { ...source.params, env };
    const targetParams = { ...target.params, env };
    const state = resolveBuildStepCacheState(source.step, sourceParams);
    writeBuildStepCacheStamp(
      source.step,
      resolveBuildStepCacheStampState(source.step, state, sourceParams),
      sourceParams,
    );
    const restore = resolveBuildStepCacheState(source.step, targetParams);
    expect(restore).toMatchObject({ fresh: true, restorable: true });
    expect(restore.outputRoot).toBe(path.join(cacheRoot, "tsdown-unified", "outputs"));
    expect(restoreBuildStepCacheOutputs(restore, targetParams)).toBe(true);
    expect(fs.readFileSync(path.join(target.rootDir, "dist/plugin-sdk/current.d.ts"), "utf8")).toBe(
      "export declare const current: true;",
    );
    expect(fs.existsSync(removedDts)).toBe(false);
    expect(fs.readFileSync(removedJs, "utf8")).toBe("runtime");
  });

  it("keeps workspace declaration caches independent of core inputs", () => {
    const rootDir = tempDirs.make("openclaw-tsdown-group-cache-");
    const steps = [getBuildAllStep("tsdown-ai"), getBuildAllStep("tsdown-packages")];
    for (const [file, contents] of [
      ["package.json", "{}"],
      ["src/index.ts", "export const core = 1;"],
      ["extensions/example/index.ts", "export const extension = 1;"],
      ["packages/ai/src/index.ts", "export const ai = 1;"],
      ["packages/net-policy/src/index.ts", "export const net = 1;"],
      ["packages/ai/dist/index.d.ts", "export declare const ai = 1;"],
      ["packages/net-policy/dist/index.d.ts", "export declare const net = 1;"],
    ] as const) {
      writeFixture(rootDir, file, contents);
    }
    for (const step of steps) {
      const state = resolveBuildStepCacheState(step, { rootDir });
      writeBuildStepCacheStamp(step, resolveBuildStepCacheStampState(step, state, { rootDir }), {
        rootDir,
      });
    }
    writeFixture(rootDir, "src/index.ts", "export const core = 2;");
    expect(steps.map((step) => resolveBuildStepCacheState(step, { rootDir }).fresh)).toEqual([
      true,
      true,
    ]);
    writeFixture(rootDir, "packages/net-policy/src/index.ts", "export const net = 2;");
    expect(steps.map((step) => resolveBuildStepCacheState(step, { rootDir }).fresh)).toEqual([
      false,
      false,
    ]);
  });

  it.each<{ name: string; before: NodeJS.ProcessEnv; after: NodeJS.ProcessEnv }>([
    { name: "bounded plugins", before: { OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "plain" }, after: {} },
    { name: "optional plugins", before: { OPENCLAW_INCLUDE_OPTIONAL_BUNDLED: "0" }, after: {} },
    {
      name: "Docker plugins",
      before: {},
      after: { OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: "external" },
    },
  ])("keeps workspace declaration signatures independent of $name", ({ before, after }) => {
    const { rootDir } = buildCacheFixture();
    for (const id of ["plain", "acpx", "external"]) {
      writeFixture(rootDir, `extensions/${id}/openclaw.plugin.json`, JSON.stringify({ id }));
      writeFixture(rootDir, `extensions/${id}/index.ts`, "export {};\n");
      writeFixture(
        rootDir,
        `extensions/${id}/package.json`,
        JSON.stringify({
          name: `@openclaw/${id}`,
          openclaw: { build: { bundledDist: id !== "external" } },
        }),
      );
    }
    expect(listBundledPluginBuildEntries({ cwd: rootDir, env: after })).not.toEqual(
      listBundledPluginBuildEntries({ cwd: rootDir, env: before }),
    );
    for (const label of ["tsdown-ai", "tsdown-packages"]) {
      const step = getBuildAllStep(label);
      expect(resolveBuildStepCacheState(step, { rootDir, env: after }).signature).toBe(
        resolveBuildStepCacheState(step, { rootDir, env: before }).signature,
      );
    }
  });

  it("rejects a matching legacy stamp that omits a required output", () => {
    const f = buildCacheFixture();
    const legacy = f.publish();
    expect(JSON.parse(fs.readFileSync(legacy.stampPath!, "utf8"))).toMatchObject({
      version: 6,
      signature: legacy.signature,
      outputs: { "dist/output.js": expect.any(String) },
    });
    fs.rmSync(path.join(f.rootDir, "dist"), { recursive: true, force: true });
    const step = {
      ...f.step,
      cache: {
        ...f.step.cache,
        requiredOutputs: ["dist/output.js", "dist/plugin-sdk/core.d.ts"],
        restore: "always" as const,
      },
    };
    const stale = resolveBuildStepCacheState(step, f.params);
    expect(stale).toMatchObject({
      fresh: false,
      reason: "required-output-unrecorded",
      restorable: false,
      signature: legacy.signature,
      stampedOutputs: ["dist/output.js"],
    });
    expect(restoreBuildStepCacheOutputs(stale, f.params)).toBe(false);
  });

  it("does not replace a cache stamp from incomplete current outputs", () => {
    const f = buildCacheFixture();
    const state = f.publish();
    const stamp = fs.readFileSync(state.stampPath!, "utf8");
    const cachedOutput = path.join(state.outputRoot!, "dist/output.js");
    expect(fs.readFileSync(cachedOutput, "utf8")).toBe("output");
    fs.writeFileSync(f.outputPath, "incomplete refresh");
    const step = {
      ...f.step,
      cache: { ...f.step.cache, requiredOutputs: ["dist/output.js", "dist/plugin-sdk/core.d.ts"] },
    };
    expect(finalizeBuildStepCache(step, resolveBuildStepCacheState(step, f.params), f.params)).toBe(
      true,
    );
    expect(fs.readFileSync(state.stampPath!, "utf8")).toBe(stamp);
    expect(fs.readFileSync(cachedOutput, "utf8")).toBe("output");
    expect(resolveBuildStepCacheState(step, f.params)).toMatchObject({
      fresh: false,
      reason: "required-output-unrecorded",
    });
  });

  it("replaces obsolete cached outputs when the previous stamp is incompatible", () => {
    const f = buildCacheFixture();
    const obsolete = writeFixture(f.rootDir, "dist/obsolete.js", "obsolete output");
    const initial = f.publish();
    const record = JSON.parse(fs.readFileSync(initial.stampPath!, "utf8"));
    fs.writeFileSync(initial.stampPath!, JSON.stringify({ ...record, version: 5 }));
    fs.rmSync(obsolete);
    fs.writeFileSync(f.inputPath, "changed input");
    expect(f.lookup().reason).toBe("record-unavailable");
    const refreshed = f.publish();
    expect(fs.readdirSync(path.join(refreshed.outputRoot!, "dist"))).toEqual(["output.js"]);
    expect(f.lookup().fresh).toBe(true);
  });

  it.each([
    { change: "input changed", reason: "signature-mismatch" },
    { change: "cached output changed", reason: "output-digest-mismatch" },
    { change: "cached output removed", reason: "output-missing-or-unreadable" },
  ])("reports stale cache state after $change", ({ change, reason }) => {
    const f = buildCacheFixture({ restore: "always" });
    const state = f.publish();
    const cachedOutput = path.join(state.outputRoot!, "dist/output.js");
    if (change === "input changed") {
      fs.writeFileSync(f.inputPath, "changed");
    } else if (change === "cached output changed") {
      fs.writeFileSync(cachedOutput, "changed");
    } else {
      fs.rmSync(cachedOutput);
    }
    const stale = f.lookup();
    expect(stale).toMatchObject({ cacheable: true, fresh: false, reason, restorable: false });
    expect(restoreBuildStepCacheOutputs(stale, f.params)).toBe(false);
  });

  it("ignores generated and installed directories in broad cache inputs", () => {
    const f = buildCacheFixture({
      inputs: [{ path: "src", excludeDirectories: ["dist", "node_modules"], extensions: [".ts"] }],
    });
    const ignored = [
      writeFixture(f.rootDir, "src/nested/dist/generated.ts", "generated"),
      writeFixture(f.rootDir, "src/node_modules/dependency.ts", "dependency"),
    ];
    f.publish();
    for (const file of ignored) {
      fs.writeFileSync(file, "changed");
    }
    expect(f.lookup()).toMatchObject({ fresh: true, inputFiles: 1 });
  });

  it("separates cache generations by output-affecting environment", () => {
    const f = buildCacheFixture({ env: ["OPENCLAW_BUILD_PRIVATE_QA"], restore: "always" });
    const params = { ...f.params, env: { OPENCLAW_BUILD_PRIVATE_QA: "1" } };
    const state = resolveBuildStepCacheState(f.step, params);
    writeBuildStepCacheStamp(f.step, state, params);
    const stale = resolveBuildStepCacheState(f.step, { ...f.params, env: {} });
    expect(stale).toMatchObject({
      cacheable: true,
      fresh: false,
      restorable: false,
      reason: "signature-mismatch",
    });
  });

  it("restores cached outputs over existing outputs for always-restore steps", () => {
    const f = buildCacheFixture({ restore: "always" });
    f.publish();
    fs.writeFileSync(f.outputPath, "overwritten by earlier build step");
    const obsolete = writeFixture(f.rootDir, "dist/obsolete.js", "obsolete output");
    const readSpy = vi.spyOn(fs, "readFileSync");
    let restore: ReturnType<typeof resolveBuildStepCacheState>;
    try {
      restore = f.lookup();
      expect(readSpy.mock.calls.map(([file]) => file)).not.toContain(f.outputPath);
    } finally {
      readSpy.mockRestore();
    }
    expect(restore).toMatchObject({
      cacheable: true,
      fresh: true,
      reason: "fresh-cache",
      outputFiles: 2,
      restorable: true,
      relativeOutputFiles: ["dist/obsolete.js", "dist/output.js"],
      stampedOutputs: ["dist/output.js"],
    });
    expect(restoreBuildStepCacheOutputs(restore, f.params)).toBe(true);
    expect(fs.readFileSync(f.outputPath, "utf8")).toBe("output");
    expect(fs.existsSync(obsolete)).toBe(false);
  });

  it("restores always-restore outputs after a cache-hit command cleans them", () => {
    const f = buildCacheFixture({ restore: "always" });
    f.publish();
    const restore = f.lookup();
    fs.rmSync(f.outputPath);
    expect(finalizeBuildStepCache(f.step, restore, { ...f.params, reusedCache: true })).toBe(true);
    expect(fs.readFileSync(f.outputPath, "utf8")).toBe("output");
  });

  it("refreshes validator cache outputs after a cache-hit command updates them", () => {
    const f = buildCacheFixture({ restore: "always", runOnHit: { finalize: "refresh" } });
    f.publish();
    expect(restoreBuildStepCacheOutputs(f.lookup(), f.params)).toBe(true);
    const restore = f.lookup();
    fs.writeFileSync(f.outputPath, "validated refresh");
    expect(finalizeBuildStepCache(f.step, restore, { ...f.params, reusedCache: true })).toBe(true);
    fs.rmSync(f.outputPath);
    expect(restoreBuildStepCacheOutputs(f.lookup(), f.params)).toBe(true);
    expect(fs.readFileSync(f.outputPath, "utf8")).toBe("validated refresh");
  });

  it("can cache only direct directory files for generated flat outputs", () => {
    const f = buildCacheFixture({
      outputs: [{ path: "dist", extensions: [".d.ts"], recursive: false }],
    });
    writeFixture(f.rootDir, "dist/output.d.ts", "flat");
    writeFixture(f.rootDir, "dist/nested/output.d.ts", "nested");
    expect(f.lookup().relativeOutputFiles).toEqual(["dist/output.d.ts"]);
  });
});
