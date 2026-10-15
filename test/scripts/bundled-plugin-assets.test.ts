// Bundled Plugin Assets tests cover bundled plugin assets script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDiscordActivitySdk } from "../../scripts/build-discord-activity-sdk.mts";
import {
  listStaleGeneratedPluginAssets,
  parseBundledPluginAssetArgs,
  readBundledPluginAssetHooks,
  runBundledPluginAssetHooks,
} from "../../scripts/bundled-plugin-assets.mts";
import * as managedCommands from "../../scripts/lib/managed-child-process.mts";
import { listGeneratedExtensionAssetSources } from "../../scripts/lib/static-extension-assets.mts";
import {
  createRunNodePathClassifier,
  isBuildRelevantRunNodePath,
  isRestartRelevantRunNodePath,
} from "../../scripts/run-node-watch-paths.mts";
import { awaitGateBeforeSettlement, createDeferred } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withPluginAssetFixture(run: (rootDir: string) => Promise<void>) {
  const rootDir = tempDirs.make("openclaw-plugin-assets-");
  fs.mkdirSync(path.join(rootDir, "extensions", "canvas"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "extensions", "canvas", "package.json"),
    JSON.stringify(
      {
        name: "@openclaw/canvas-plugin",
        openclaw: {
          assetScripts: {
            build: "node --import tsx scripts/bundle-a2ui.mts",
            buildOutputs: ["assets/generated-runtime.js"],
            copy: "node scripts/copy-a2ui.mjs",
          },
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(rootDir, "extensions", "canvas", "openclaw.plugin.json"),
    JSON.stringify({ id: "canvas" }, null, 2),
  );
  await run(rootDir);
}

describe("bundled plugin assets", () => {
  it("reuses both Canvas dialects across candidates and invalidates changed inputs", () => {
    const workspace = tempDirs.make("openclaw-canvas-cache-");
    const cacheRoot = path.join(workspace, "cache");
    const prepare = (name: string) => {
      const root = path.join(workspace, name);
      const write = (file: string, content: string) => {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      };
      for (const file of [
        "scripts/bundle-a2ui.mts",
        "scripts/pnpm-runner.mts",
        "scripts/windows-cmd-helpers.mjs",
        "scripts/lib/build-artifact-cache.mts",
      ]) {
        write(file, fs.readFileSync(path.resolve(file), "utf8"));
      }
      fs.mkdirSync(path.join(root, "node_modules/@openclaw"), { recursive: true });
      fs.symlinkSync(
        path.resolve("node_modules/@openclaw/fs-safe"),
        path.join(root, "node_modules/@openclaw/fs-safe"),
        "junction",
      );
      for (const module of [
        "@solidjs/compiler/index.js",
        "@solidjs/web/index.js",
        "solid-js/index.js",
        "signal-utils/map.js",
        "@a2ui/web_core/v0_9.js",
        "@a2ui/lit/ui.js",
      ]) {
        write(`node_modules/${module}`, "");
      }
      write("package.json", JSON.stringify({ type: "module", scripts: { check: name } }));
      write("extensions/canvas/package.json", "{}");
      write("pnpm-lock.yaml", "fixture-lock");
      write("extensions/canvas/src/host/a2ui-app/bootstrap.jsx", "fixture-source");
      write(
        "node_modules/rolldown/bin/cli.mjs",
        `
        import fs from "node:fs";
        const output = "extensions/canvas/src/host/a2ui";
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(output + "/a2ui.bundle.js", "dialect-0.8");
        fs.writeFileSync(output + "/a2ui-v0.9.bundle.js", "dialect-0.9");
        fs.appendFileSync("compiled", "x");
      `,
      );
      const run = (env: NodeJS.ProcessEnv = {}, expectedStatus = 0) => {
        const result = spawnSync(process.execPath, ["scripts/bundle-a2ui.mts"], {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            BUILD_ALL_CACHE_ROOT: cacheRoot,
            OPENCLAW_BUILD_CACHE: "1",
            OPENCLAW_A2UI_BUNDLE_OUT: undefined,
            OPENCLAW_SPARSE_PROFILE: "",
            OPENCLAW_A2UI_SKIP_MISSING: "0",
            ...env,
          },
        });
        expect(result.status, result.stderr).toBe(expectedStatus);
        return result.stdout;
      };
      return { root, write, run };
    };
    const first = prepare("first");
    first.run();
    expect(fs.readFileSync(path.join(first.root, "compiled"), "utf8")).toBe("x");
    const next = prepare("next");
    expect(next.run()).toContain("shared artifacts reused");
    expect(fs.existsSync(path.join(next.root, "compiled"))).toBe(false);
    const output = "extensions/canvas/src/host/a2ui/";
    expect(fs.readFileSync(path.join(next.root, output, "a2ui.bundle.js"), "utf8")).toBe(
      "dialect-0.8",
    );
    expect(fs.readFileSync(path.join(next.root, output, "a2ui-v0.9.bundle.js"), "utf8")).toBe(
      "dialect-0.9",
    );
    next.write(`${output}a2ui-v0.9.bundle.js`, "corrupt");
    expect(next.run()).toContain("shared artifacts reused");
    expect(fs.readFileSync(path.join(next.root, output, "a2ui-v0.9.bundle.js"), "utf8")).toBe(
      "dialect-0.9",
    );
    next.write("extensions/canvas/src/host/a2ui-app/bootstrap.jsx", "changed-source");
    next.run();
    next.write("pnpm-lock.yaml", "changed-dependency");
    next.run();
    next.run({ OPENCLAW_BUILD_CACHE: "0" });
    expect(fs.readFileSync(path.join(next.root, "compiled"), "utf8")).toBe("xxx");
    fs.rmSync(path.join(next.root, "node_modules/@a2ui"), { recursive: true });
    expect(next.run()).toContain("keeping prebuilt bundle");
    fs.rmSync(path.join(next.root, output, "a2ui-v0.9.bundle.js"));
    next.run({}, 1);
  });

  it("creates a missing Discord SDK bundle without rewriting it when unchanged", async () => {
    const rootDir = tempDirs.make("openclaw-discord-sdk-");
    const outputPath = path.join(rootDir, "embedded-app-sdk.mjs");
    const build = vi.fn(async () => ({
      outputFiles: [{ text: "export const sdk = true;\n" }],
    }));

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
    const hooks = await readBundledPluginAssetHooks({
      phase: "build",
      plugins: ["discord"],
      rootDir: process.cwd(),
    });

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
    const hooks = await readBundledPluginAssetHooks({ phase: "build", rootDir });
    const generatedAssetSources = listGeneratedExtensionAssetSources({ rootDir });

    for (const hook of hooks) {
      const pluginPath = path.relative(rootDir, hook.pluginDir).replaceAll(path.sep, "/");
      expect(
        generatedAssetSources.some((source) => source.startsWith(`${pluginPath}/`)),
        `${hook.pluginId} build hook must declare at least one generated output`,
      ).toBe(true);
    }

    expect(generatedAssetSources).toContain("extensions/canvas/src/host/a2ui/a2ui.bundle.js");
    expect(generatedAssetSources).toContain("extensions/discord/assets/embedded-app-sdk.mjs");
    for (const source of generatedAssetSources) {
      expect(isBuildRelevantRunNodePath(source), source).toBe(false);
      expect(isRestartRelevantRunNodePath(source), source).toBe(false);
    }
    expect(isRestartRelevantRunNodePath("extensions/discord/src/activities/http.ts")).toBe(true);
  });

  it.each(["packages/llm-core/src/types.ts"])("rebuilds the root runtime for %s", (source) => {
    expect(isBuildRelevantRunNodePath(source)).toBe(true);
    expect(isRestartRelevantRunNodePath(source)).toBe(true);
  });

  it("refreshes generated output metadata without recreating the watcher", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      const packagePath = path.join(rootDir, "extensions", "canvas", "package.json");
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
        openclaw: { assetScripts: { buildOutputs?: string[] } };
      };
      delete packageJson.openclaw.assetScripts.buildOutputs;
      fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));

      const classifier = createRunNodePathClassifier({ rootDir });
      classifier.refreshGeneratedPluginAssetPaths();
      const generatedPath = path.join("extensions", "canvas", "assets", "generated-runtime.js");
      expect(classifier.isRestartRelevantRunNodePath(generatedPath)).toBe(true);

      packageJson.openclaw.assetScripts.buildOutputs = ["assets/generated-runtime.js"];
      fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));
      classifier.refreshGeneratedPluginAssetPaths();

      expect(classifier.isBuildRelevantRunNodePath(generatedPath)).toBe(false);
      expect(classifier.isRestartRelevantRunNodePath(generatedPath)).toBe(false);

      if (process.platform !== "win32") {
        // Literal backslashes in native basenames do not identify the generated paths.
        for (const sourcePath of [
          path.join("extensions", "canvas", "assets\\generated-runtime.js"),
          path.join("extensions", "canvas", "src", "host", "qa\\widget.bundle.js"),
        ]) {
          const absolutePath = path.join(rootDir, sourcePath);
          fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
          fs.writeFileSync(absolutePath, "export {};\n");
          expect(classifier.isBuildRelevantRunNodePath(sourcePath), sourcePath).toBe(true);
          expect(classifier.isRestartRelevantRunNodePath(sourcePath), sourcePath).toBe(true);
        }
      }
    });
  });

  it("keeps browser manifest producers early while deferring selected isolated hooks", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      fs.writeFileSync(path.join(rootDir, "package.json"), '{"name":"openclaw","version":"1.0.0"}');
      for (const id of ["isolated", "manifest-writer", "unselected", "untracked"]) {
        const directory = path.join(rootDir, "extensions", id);
        fs.mkdirSync(directory);
        fs.writeFileSync(
          path.join(directory, "package.json"),
          JSON.stringify({
            name: `@fixture/${id}`,
            openclaw: {
              extensions: ["./index.ts"],
              build: { bundledDist: false },
              release: { publishToNpm: true },
              assetScripts: {
                build: "node build.mjs",
                ...(id === "manifest-writer"
                  ? { buildOutputs: ["dist/openclaw.plugin.json"] }
                  : {}),
              },
            },
          }),
        );
        // Directory IDs own isolation even when a manifest advertises another alias.
        fs.writeFileSync(
          path.join(directory, "openclaw.plugin.json"),
          JSON.stringify({ id: `${id}-alias` }),
        );
        fs.writeFileSync(path.join(directory, "index.ts"), "export {};\n");
      }
      execFileSync("git", ["init", "--quiet"], { cwd: rootDir });
      execFileSync(
        "git",
        [
          "add",
          "extensions/canvas",
          "extensions/isolated",
          "extensions/manifest-writer",
          "extensions/unselected",
        ],
        { cwd: rootDir },
      );
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS", "canvas,isolated,manifest-writer");
      vi.stubEnv("OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS", undefined);
      try {
        const readIds = async (deferIsolated = false) =>
          (await readBundledPluginAssetHooks({ phase: "build", rootDir, deferIsolated })).map(
            ({ pluginDir }) => path.basename(pluginDir),
          );
        expect(await readIds(true)).toEqual([
          "canvas",
          "manifest-writer",
          "unselected",
          "untracked",
        ]);
        expect(await readIds()).toEqual([
          "canvas",
          "isolated",
          "manifest-writer",
          "unselected",
          "untracked",
        ]);
        vi.stubEnv("OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS", "isolated,manifest-writer");
        expect(await readIds(true)).toEqual([
          "canvas",
          "isolated",
          "manifest-writer",
          "unselected",
          "untracked",
        ]);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("awaits bounded asset execution and reports joined timeouts safely", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      const pluginDir = path.join(rootDir, "extensions", "canvas");
      const packagePath = path.join(pluginDir, "package.json");
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
        openclaw: { assetScripts: { build: string } };
      };
      packageJson.openclaw.assetScripts.build = "node scripts/private-asset-command.mjs";
      fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));
      const started = createDeferred<Parameters<typeof managedCommands.runManagedCommand>[0]>();
      const command = createDeferred<number>();
      const runner = vi
        .spyOn(managedCommands, "runManagedCommand")
        .mockImplementationOnce((options) => {
          started.resolve(options);
          return command.promise;
        });
      const running = runBundledPluginAssetHooks({ phase: "build", rootDir });
      const outcome = running.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        const options = await awaitGateBeforeSettlement(
          started.promise,
          running,
          "Asset hooks completed before managed execution settled",
        );
        expect(options).toMatchObject({
          bin: packageJson.openclaw.assetScripts.build,
          cwd: pluginDir,
          timeoutMs: 600_000,
          requireProcessTreeExit: process.platform !== "win32",
        });
        const failure = Object.assign(new Error("Asset command cleanup completed"), {
          code: "ETIMEDOUT",
        });
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
  });

  it("rejects a symlinked dist root before running copy hooks", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      const targetDir = path.join(rootDir, "live-gateway-dist");
      fs.mkdirSync(targetDir);
      fs.writeFileSync(path.join(targetDir, "sentinel.js"), "keep\n");
      fs.symlinkSync(targetDir, path.join(rootDir, "dist"), "dir");

      await expect(runBundledPluginAssetHooks({ phase: "copy", rootDir })).rejects.toThrow(
        /symbolic link/u,
      );
      expect(fs.readFileSync(path.join(targetDir, "sentinel.js"), "utf8")).toBe("keep\n");
      expect(fs.readlinkSync(path.join(rootDir, "dist"))).toBe(targetDir);
    });
  });

  it("parses whole-repo check runs and rejects filtered or copy-phase checks", () => {
    expect(parseBundledPluginAssetArgs(["--phase", "build", "--check"])).toEqual({
      check: true,
      phase: "build",
      plugins: [],
    });
    expect(() => parseBundledPluginAssetArgs(["--phase", "copy", "--check"])).toThrow(
      "--check requires --phase build",
    );
    expect(() =>
      parseBundledPluginAssetArgs(["--phase", "build", "--check", "--plugin=canvas"]),
    ).toThrow("--check cannot be combined with --plugin filters");
    for (const args of [
      ["--phase", "build", "--check", "--defer-isolated"],
      ["--phase", "copy", "--defer-isolated"],
    ]) {
      expect(() => parseBundledPluginAssetArgs(args)).toThrow(
        "--defer-isolated requires --phase build without --check",
      );
    }
  });

  it("reports declared generated outputs that differ from the committed bytes", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      const generatedPath = path.join(
        rootDir,
        "extensions",
        "canvas",
        "assets",
        "generated-runtime.js",
      );
      fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
      fs.writeFileSync(generatedPath, "export const generated = 1;\n");
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] });
      git("init", "--quiet");
      git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "init");

      expect(listStaleGeneratedPluginAssets({ rootDir })).toEqual([]);

      fs.writeFileSync(generatedPath, "export const generated = 2;\n");
      expect(listStaleGeneratedPluginAssets({ rootDir })).toEqual([
        "extensions/canvas/assets/generated-runtime.js",
      ]);
    });
  });
});
