// Linux/macOS filesystem proof for Kubernetes AtomicWriter-style config projection swaps.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import { startGatewayConfigReloader } from "./config-reload.js";

function makeSnapshot(configPath: string, raw: string): ConfigFileSnapshot {
  const config = JSON.parse(raw) as OpenClawConfig;
  const sourceConfig = config as ConfigFileSnapshot["sourceConfig"];
  return {
    path: configPath,
    exists: true,
    raw,
    parsed: config,
    sourceConfig,
    resolved: sourceConfig,
    valid: true,
    runtimeConfig: config,
    config,
    hash: raw,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

async function writeProjectedGeneration(
  root: string,
  name: string,
  config: OpenClawConfig,
): Promise<void> {
  const generationPath = path.join(root, name);
  await fs.mkdir(generationPath);
  await fs.writeFile(path.join(generationPath, "openclaw.json"), JSON.stringify(config), "utf8");
}

describe("managed config filesystem watching", () => {
  it.skipIf(process.platform === "win32")(
    "reconciles an AtomicWriter-style ..data symlink swap",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-config-"));
      const configPath = path.join(root, "openclaw.json");
      const initialConfig: OpenClawConfig = {
        gateway: { reload: { debounceMs: 10 } },
        hooks: { enabled: false },
      };
      const nextConfig: OpenClawConfig = {
        gateway: { reload: { debounceMs: 10 } },
        hooks: { enabled: true },
      };

      await writeProjectedGeneration(root, "..2026_01", initialConfig);
      await writeProjectedGeneration(root, "..2026_02", nextConfig);
      await fs.symlink("..2026_01", path.join(root, "..data"));
      await fs.symlink("..data/openclaw.json", configPath);

      const readSnapshot = vi.fn(async () =>
        makeSnapshot(configPath, await fs.readFile(configPath, "utf8")),
      );
      const onHotReload = vi.fn(async () => {});
      const onRestart = vi.fn(async () => {});
      const realWatch = chokidar.watch;
      let markWatcherReady: () => void = () => {};
      const watcherReady = new Promise<void>((resolve) => {
        markWatcherReady = resolve;
      });
      const watchSpy = vi.spyOn(chokidar, "watch").mockImplementation((watchPath, options) => {
        const watcher = realWatch(watchPath, options);
        watcher.once("ready", markWatcherReady);
        return watcher;
      });
      const reloader = startGatewayConfigReloader({
        initialConfig,
        initialCompareConfig: initialConfig,
        initialPluginInstallRecords: {},
        readPluginInstallRecords: async () => ({}),
        readSnapshot,
        onNoopConfigCommit: async () => {},
        onHotReload,
        onRestart,
        log: {
          info: () => {},
          warn: () => {},
          error: () => {},
        },
        watchPath: configPath,
        watchParentDirectory: true,
      });

      try {
        await watcherReady;
        await fs.symlink("..2026_02", path.join(root, "..data_tmp"));
        await fs.rename(path.join(root, "..data_tmp"), path.join(root, "..data"));

        await vi.waitFor(
          () => {
            expect(onHotReload).toHaveBeenCalledWith(
              expect.objectContaining({ changedPaths: ["hooks.enabled"] }),
              nextConfig,
            );
          },
          { interval: 25, timeout: 5_000 },
        );
        expect(readSnapshot).toHaveBeenCalled();
        expect(onRestart).not.toHaveBeenCalled();
      } finally {
        await reloader.stop();
        watchSpy.mockRestore();
        await fs.rm(root, { force: true, recursive: true });
      }
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "reconciles changes through a symlink whose target is outside the watched parent",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-link-"));
      const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-target-"));
      const configPath = path.join(root, "openclaw.json");
      const targetPath = path.join(targetRoot, "openclaw.json");
      const initialConfig: OpenClawConfig = {
        gateway: { reload: { debounceMs: 10 } },
        hooks: { enabled: false },
      };
      const nextConfig: OpenClawConfig = {
        gateway: { reload: { debounceMs: 10 } },
        hooks: { enabled: true },
      };

      await fs.writeFile(targetPath, JSON.stringify(initialConfig), "utf8");
      await fs.symlink(targetPath, configPath);

      const readSnapshot = vi.fn(async () =>
        makeSnapshot(configPath, await fs.readFile(configPath, "utf8")),
      );
      const onHotReload = vi.fn(async () => {});
      const realWatch = chokidar.watch;
      let markWatcherReady: () => void = () => {};
      const watcherReady = new Promise<void>((resolve) => {
        markWatcherReady = resolve;
      });
      const watchSpy = vi.spyOn(chokidar, "watch").mockImplementation((watchPath, options) => {
        const watcher = realWatch(watchPath, options);
        watcher.once("ready", markWatcherReady);
        return watcher;
      });
      const reloader = startGatewayConfigReloader({
        initialConfig,
        initialCompareConfig: initialConfig,
        initialPluginInstallRecords: {},
        readPluginInstallRecords: async () => ({}),
        readSnapshot,
        onNoopConfigCommit: async () => {},
        onHotReload,
        onRestart: async () => {},
        log: {
          info: () => {},
          warn: () => {},
          error: () => {},
        },
        watchPath: configPath,
        watchParentDirectory: true,
      });

      try {
        await watcherReady;
        await fs.writeFile(targetPath, JSON.stringify(nextConfig), "utf8");

        await vi.waitFor(
          () => {
            expect(onHotReload).toHaveBeenCalledWith(
              expect.objectContaining({ changedPaths: ["hooks.enabled"] }),
              nextConfig,
            );
          },
          { interval: 25, timeout: 5_000 },
        );
        expect(readSnapshot).toHaveBeenCalled();
      } finally {
        await reloader.stop();
        watchSpy.mockRestore();
        await fs.rm(root, { force: true, recursive: true });
        await fs.rm(targetRoot, { force: true, recursive: true });
      }
    },
    10_000,
  );
});
