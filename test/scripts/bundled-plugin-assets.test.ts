import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildDiscordActivitySdk } from "../../scripts/build-discord-activity-sdk.mts";
import * as assets from "../../scripts/bundled-plugin-assets.mts";
import * as managedCommands from "../../scripts/lib/managed-child-process.mts";
import { listGeneratedExtensionAssetSources } from "../../scripts/lib/static-extension-assets.mts";
import * as watch from "../../scripts/run-node-watch-paths.mts";
import { awaitGateBeforeSettlement, createDeferred } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fileWriter(root: string) {
  return (name: string, content: unknown) => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
  };
}

function pluginAssetFixture(initialScripts: Record<string, unknown> = {}) {
  const rootDir = tempDirs.make("openclaw-plugin-assets-");
  const pluginDir = path.join(rootDir, "extensions", "canvas");
  const write = fileWriter(pluginDir);
  const writePackage = (overrides: Record<string, unknown>) => {
    const assetScripts = {
      build: "node scripts/build-runtime.mjs",
      buildOutputs: ["assets/generated-runtime.js"],
      copy: "node scripts/copy-runtime.mjs",
      ...overrides,
    };
    write("package.json", {
      name: "@openclaw/canvas-plugin",
      openclaw: { assetScripts },
    });
  };
  writePackage(initialScripts);
  write("openclaw.plugin.json", { id: "canvas" });
  return { rootDir, pluginDir, writePackage, write: fileWriter(rootDir) };
}

const readHooks = (rootDir = process.cwd(), options = {}) =>
  assets.readBundledPluginAssetHooks({ phase: "build", rootDir, ...options });
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

it("creates a missing Discord SDK bundle without rewriting it when unchanged", async () => {
  const rootDir = tempDirs.make("openclaw-discord-sdk-");
  const outputPath = path.join(rootDir, "embedded-app-sdk.mjs");
  const build = vi.fn(async () => ({ outputFiles: [{ text: "export const sdk = true;\n" }] }));

  await expect(buildDiscordActivitySdk({ build, outputPath })).resolves.toBe(true);
  expect(fs.readFileSync(outputPath, "utf8")).toBe("export const sdk = true;\n");

  const initialTime = new Date("2026-07-16T12:00:00.000Z");
  fs.utimesSync(outputPath, initialTime, initialTime);

  await expect(buildDiscordActivitySdk({ build, outputPath })).resolves.toBe(false);
  expect(fs.statSync(outputPath).mtimeMs).toBe(initialTime.getTime());
  expect(build).toHaveBeenCalledWith(
    expect.objectContaining({
      absWorkingDir: path.join(process.cwd(), "extensions/discord"),
      outfile: outputPath,
      write: false,
    }),
  );
});

it("discovers the Discord SDK hook for standalone asset preparation", async () => {
  const hooks = await readHooks(process.cwd(), { plugins: ["discord"] });
  expect(hooks).toMatchObject([
    {
      command: "node --import ../../scripts/tsx.mjs ../../scripts/build-discord-activity-sdk.mts",
      packageName: "@openclaw/discord",
      phase: "build",
      pluginId: "discord",
    },
  ]);
});

it("keeps build-generated static assets out of the source watcher", async () => {
  const rootDir = process.cwd();
  const hooks = await readHooks(rootDir);
  const generatedAssetSources = listGeneratedExtensionAssetSources({ rootDir });

  for (const hook of hooks) {
    const pluginPath = path.relative(rootDir, hook.pluginDir).replaceAll(path.sep, "/");
    expect(
      generatedAssetSources.some((source) => source.startsWith(`${pluginPath}/`)),
      `${hook.pluginId} generated output`,
    ).toBe(true);
  }

  expect(generatedAssetSources).toContain("extensions/discord/assets/embedded-app-sdk.mjs");
  for (const source of generatedAssetSources) {
    expect(watch.isBuildRelevantRunNodePath(source), source).toBe(false);
    expect(watch.isRestartRelevantRunNodePath(source), source).toBe(false);
  }
  expect(watch.isRestartRelevantRunNodePath("extensions/discord/src/activities/http.ts")).toBe(
    true,
  );
});

it.each(["packages/llm-core/src/types.ts"])("rebuilds the root runtime for %s", (source) => {
  expect(watch.isBuildRelevantRunNodePath(source)).toBe(true);
  expect(watch.isRestartRelevantRunNodePath(source)).toBe(true);
});

it("refreshes generated output metadata without recreating the watcher", async () => {
  const { rootDir, writePackage, write } = pluginAssetFixture({ buildOutputs: undefined });

  const classifier = watch.createRunNodePathClassifier({ rootDir });
  classifier.refreshGeneratedPluginAssetPaths();
  const generatedPath = path.join("extensions", "canvas", "assets", "generated-runtime.js");
  expect(classifier.isRestartRelevantRunNodePath(generatedPath)).toBe(true);

  writePackage({ buildOutputs: ["assets/generated-runtime.js"] });
  classifier.refreshGeneratedPluginAssetPaths();

  expect(classifier.isBuildRelevantRunNodePath(generatedPath)).toBe(false);
  expect(classifier.isRestartRelevantRunNodePath(generatedPath)).toBe(false);

  if (process.platform !== "win32") {
    // Literal backslashes in native basenames do not identify the generated paths.
    for (const sourcePath of [
      path.join("extensions", "canvas", "assets\\generated-runtime.js"),
      path.join("extensions", "canvas", "src", "host", "qa\\widget.bundle.js"),
    ]) {
      write(sourcePath, "export {};\n");
      expect(classifier.isBuildRelevantRunNodePath(sourcePath), sourcePath).toBe(true);
      expect(classifier.isRestartRelevantRunNodePath(sourcePath), sourcePath).toBe(true);
    }
  }
});

it("keeps browser manifest producers early while deferring selected isolated hooks", async () => {
  const { rootDir, write } = pluginAssetFixture();
  write("package.json", { name: "openclaw", version: "1.0.0" });
  for (const id of ["isolated", "manifest-writer", "unselected", "untracked"]) {
    const writePlugin = fileWriter(path.join(rootDir, "extensions", id));
    writePlugin("package.json", {
      name: `@fixture/${id}`,
      openclaw: {
        extensions: ["./index.ts"],
        build: { bundledDist: false },
        release: { publishToNpm: true },
        assetScripts: {
          build: "node build.mjs",
          ...(id === "manifest-writer" ? { buildOutputs: ["dist/openclaw.plugin.json"] } : {}),
        },
      },
    });
    // Directory IDs own isolation even when a manifest advertises another alias.
    writePlugin("openclaw.plugin.json", { id: `${id}-alias` });
    writePlugin("index.ts", "export {};\n");
  }
  git(rootDir, "init", "--quiet");
  git(
    rootDir,
    "add",
    ...["canvas", "isolated", "manifest-writer", "unselected"].map((id) => `extensions/${id}`),
  );
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS", "canvas,isolated,manifest-writer");
  vi.stubEnv("OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS", undefined);
  try {
    const readIds = async (deferIsolated = false) =>
      (await readHooks(rootDir, { deferIsolated })).map(({ pluginDir }) =>
        path.basename(pluginDir),
      );
    expect(await readIds(true)).toEqual(["canvas", "manifest-writer", "unselected", "untracked"]);
    const allIds = ["canvas", "isolated", "manifest-writer", "unselected", "untracked"];
    expect(await readIds()).toEqual(allIds);
    vi.stubEnv("OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS", "isolated,manifest-writer");
    expect(await readIds(true)).toEqual(allIds);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("awaits bounded asset execution and reports joined timeouts safely", async () => {
  const build = "node scripts/private-asset-command.mjs";
  const { rootDir, pluginDir } = pluginAssetFixture({ build });
  const started = createDeferred<Parameters<typeof managedCommands.runManagedCommand>[0]>();
  const command = createDeferred<number>();
  const runner = vi.spyOn(managedCommands, "runManagedCommand");
  runner.mockImplementationOnce((options) => {
    started.resolve(options);
    return command.promise;
  });
  const running = assets.runBundledPluginAssetHooks({ phase: "build", rootDir });
  const outcome = running.catch((error: unknown) => error);
  try {
    const options = await awaitGateBeforeSettlement(
      started.promise,
      running,
      "Asset hook settled before command",
    );
    expect(options).toMatchObject({
      bin: build,
      cwd: pluginDir,
      timeoutMs: 600_000,
      requireProcessTreeExit: process.platform !== "win32",
    });
    const failure = Object.assign(new Error("cleanup completed"), { code: "ETIMEDOUT" });
    command.reject(failure);
    expect(await outcome).toMatchObject({
      code: "ETIMEDOUT",
      message: "Plugin asset build hook timed out after 600000ms: canvas",
      cause: failure,
    });
  } finally {
    command.resolve(0);
    await outcome;
    runner.mockRestore();
  }
});

it("rejects a symlinked dist root before running copy hooks", async () => {
  const { rootDir, write } = pluginAssetFixture();
  const targetDir = path.join(rootDir, "live-gateway-dist");
  write("live-gateway-dist/sentinel.js", "keep\n");
  fs.symlinkSync(targetDir, path.join(rootDir, "dist"), "dir");

  await expect(assets.runBundledPluginAssetHooks({ phase: "copy", rootDir })).rejects.toThrow(
    /symbolic link/u,
  );
  expect(fs.readFileSync(path.join(targetDir, "sentinel.js"), "utf8")).toBe("keep\n");
  expect(fs.readlinkSync(path.join(rootDir, "dist"))).toBe(targetDir);
});

it("parses whole-repo check runs and rejects filtered or copy-phase checks", () => {
  expect(assets.parseBundledPluginAssetArgs(["--phase", "build", "--check"])).toEqual({
    check: true,
    phase: "build",
    plugins: [],
  });
  const deferError = "--defer-isolated requires --phase build without --check";
  for (const [args, error] of [
    ["--phase copy --check", "--check requires --phase build"],
    ["--phase build --check --plugin=canvas", "--check cannot be combined with --plugin filters"],
    ["--phase build --check --defer-isolated", deferError],
    ["--phase copy --defer-isolated", deferError],
  ] as const) {
    expect(() => assets.parseBundledPluginAssetArgs(args.split(" "))).toThrow(error);
  }
});

it("reports declared generated outputs that differ from the committed bytes", async () => {
  const { rootDir, write } = pluginAssetFixture();
  const generatedPath = "extensions/canvas/assets/generated-runtime.js";
  write(generatedPath, "export const generated = 1;\n");
  git(rootDir, "init", "--quiet");
  git(rootDir, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git(rootDir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "init");

  expect(assets.listStaleGeneratedPluginAssets({ rootDir })).toEqual([]);

  write(generatedPath, "export const generated = 2;\n");
  expect(assets.listStaleGeneratedPluginAssets({ rootDir })).toEqual([generatedPath]);
});
