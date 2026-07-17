// Bundled Plugin Assets tests cover bundled plugin assets script behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDiscordActivitySdk } from "../../scripts/build-discord-activity-sdk.mjs";
import {
  parseBundledPluginAssetArgs,
  readBundledPluginAssetHooks,
} from "../../scripts/bundled-plugin-assets.mjs";
import {
  isBuildRelevantRunNodePath,
  isRestartRelevantRunNodePath,
} from "../../scripts/run-node-watch-paths.mjs";
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
            build: "node scripts/bundle-a2ui.mjs",
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

  it("discovers the Discord Embedded App SDK build hook", async () => {
    const hooks = await readBundledPluginAssetHooks({
      phase: "build",
      plugins: ["discord"],
      rootDir: process.cwd(),
    });

    expect(hooks).toMatchObject([
      {
        command: "node ../../scripts/build-discord-activity-sdk.mjs",
        packageName: "@openclaw/discord",
        phase: "build",
        pluginId: "discord",
      },
    ]);
  });

  it("keeps build-generated static assets out of the source watcher", async () => {
    const rootDir = process.cwd();
    const hooks = await readBundledPluginAssetHooks({ phase: "build", rootDir });
    const generatedAssetSources = hooks.flatMap((hook) => {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(hook.pluginDir, "package.json"), "utf8"),
      ) as {
        openclaw?: { build?: { staticAssets?: Array<{ source?: string }> } };
      };
      const pluginPath = path.relative(rootDir, hook.pluginDir).replaceAll(path.sep, "/");
      return (packageJson.openclaw?.build?.staticAssets ?? []).flatMap((asset) => {
        const source = asset.source?.replace(/^\.\/+/u, "");
        return source ? [path.posix.join(pluginPath, source)] : [];
      });
    });

    expect(generatedAssetSources).toContain("extensions/discord/assets/embedded-app-sdk.mjs");
    for (const source of generatedAssetSources) {
      expect(isBuildRelevantRunNodePath(source), source).toBe(false);
      expect(isRestartRelevantRunNodePath(source), source).toBe(false);
    }
    expect(isRestartRelevantRunNodePath("extensions/discord/src/activities/http.ts")).toBe(true);
  });

  it("discovers plugin-owned asset scripts by manifest id", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      const hooks = await readBundledPluginAssetHooks({
        phase: "build",
        plugins: ["canvas"],
        rootDir,
      });

      expect(hooks).toEqual([
        {
          aliases: ["@openclaw/canvas-plugin", "canvas", "canvas-plugin"],
          command: "node scripts/bundle-a2ui.mjs",
          packageName: "@openclaw/canvas-plugin",
          phase: "build",
          pluginDir: path.join(rootDir, "extensions", "canvas"),
          pluginId: "canvas",
        },
      ]);
    });
  });

  it("skips cleanly when a requested plugin is absent", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      await expect(
        readBundledPluginAssetHooks({ phase: "copy", plugins: ["missing"], rootDir }),
      ).resolves.toStrictEqual([]);
    });
  });

  it("parses phase and plugin filters", () => {
    expect(parseBundledPluginAssetArgs(["--phase", "build", "--plugin=canvas"])).toEqual({
      phase: "build",
      plugins: ["canvas"],
    });
  });
});
