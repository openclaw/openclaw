import fs from "node:fs/promises";
import { expect, it, type Mock } from "vitest";
import type { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { replaceConfigFile } from "./mutate.js";
import {
  createPluginIncludeFixture,
  createSnapshot,
  resolveIncludeTarget,
} from "./mutate.test-support.js";
import {
  registerRuntimeConfigWriteListener,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

type IncludeReferenceFixture = {
  suiteRootTracker: Pick<ReturnType<typeof createSuiteTempRootTracker>, "make">;
  allowConfigPathWrite: () => void;
  ioMocks: {
    readConfigFileSnapshotForWrite: Mock<
      ReturnType<typeof import("./io.js").createConfigIO>["readConfigFileSnapshotForWrite"]
    >;
    writeConfigFile: Mock;
  };
};

export function registerPluginIncludeReferenceRepairTest({
  suiteRootTracker,
  allowConfigPathWrite,
  ioMocks,
}: IncludeReferenceFixture) {
  it("repairs invalid config through a single-file top-level plugins include", async () => {
    const home = await suiteRootTracker.make("include");
    const { configPath, pluginsPath } = await createPluginIncludeFixture(home);
    await fs.writeFile(
      pluginsPath,
      `${JSON.stringify(
        {
          entries: {
            old: {
              enabled: true,
              config: { token: "${OPENCLAW_TEST_PLUGIN_TOKEN}" },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const previousBackupPath = `${pluginsPath}.bak`;
    await fs.writeFile(previousBackupPath, "previous backup", { mode: 0o644 });
    const oldEntry = {
      enabled: true,
      config: { token: "plugin-token-runtime" },
    };
    const snapshot: ConfigFileSnapshot = {
      ...createSnapshot({
        hash: "hash-include",
        path: configPath,
        parsed: { plugins: { $include: "./config/plugins.json5" } },
        sourceConfig: {
          plugins: {
            entries: { old: oldEntry },
          },
        },
      }),
      valid: false,
      issues: [{ path: "plugins.load.paths", message: "plugin path not found: /gone" }],
    };
    const refreshedSnapshot = createSnapshot({
      hash: "hash-include-refreshed",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: {
        plugins: {
          entries: {
            old: oldEntry,
            demo: { enabled: true },
          },
        },
      },
    });
    snapshot.authoredConfig = {
      plugins: {
        entries: {
          old: { ...oldEntry, config: { token: "${OPENCLAW_TEST_PLUGIN_TOKEN}" } },
        },
      },
    };
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce({
        snapshot,
        writeOptions: {
          expectedConfigPath: configPath,
          envSnapshotForRestore: { OPENCLAW_TEST_PLUGIN_TOKEN: "plugin-token-runtime" },
          assertConfigPathForWrite: allowConfigPathWrite,
          includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
        },
      })
      .mockResolvedValueOnce({
        snapshot: refreshedSnapshot,
        writeOptions: { expectedConfigPath: configPath },
      });
    const notifications: unknown[] = [];
    const unregister = registerRuntimeConfigWriteListener((event) => {
      notifications.push(event);
    });

    try {
      await replaceConfigFile({
        baseHash: snapshot.hash,
        afterWrite: { mode: "restart", reason: "test include refresh" },
        writeOptions: {
          expectedConfigPath: snapshot.path,
          unsetPaths: [["plugins", "installs"]],
        },
        nextConfig: {
          plugins: {
            entries: {
              old: oldEntry,
              demo: { enabled: true },
            },
            installs: {
              demo: {
                source: "npm",
                spec: "demo",
                installPath: "/tmp/demo",
              },
            },
          },
        },
        io: {
          env: { OPENCLAW_TEST_PLUGIN_TOKEN: "plugin-token-after-read" },
          readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
          writeConfigFile: ioMocks.writeConfigFile,
        },
      });
    } finally {
      unregister();
    }

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(1);
    const [notification] = notifications as Array<{
      configPath?: string;
      persistedHash?: string;
      sourceConfig?: unknown;
      runtimeConfig?: unknown;
      afterWrite?: unknown;
    }>;
    expect(notification?.configPath).toBe(configPath);
    expect(notification?.persistedHash).toBe("hash-include-refreshed");
    expect(notification?.sourceConfig).toEqual({
      plugins: {
        entries: {
          old: oldEntry,
          demo: { enabled: true },
        },
      },
    });
    expect(notification?.runtimeConfig).toEqual({
      plugins: {
        entries: {
          old: oldEntry,
          demo: { enabled: true },
        },
      },
    });
    expect(notification?.afterWrite).toEqual({ mode: "restart", reason: "test include refresh" });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toContain(
      '"$include": "./config/plugins.json5"',
    );
    await expect(fs.readFile(`${pluginsPath}.bak`, "utf-8")).resolves.toContain('"old"');
    await expect(fs.readFile(`${pluginsPath}.bak.1`, "utf-8")).resolves.toBe("previous backup");
    if (process.platform !== "win32") {
      expect((await fs.stat(`${pluginsPath}.bak`)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(`${pluginsPath}.bak.1`)).mode & 0o777).toBe(0o600);
    }
    const persistedPlugins = JSON.parse(await fs.readFile(pluginsPath, "utf-8")) as {
      entries?: Record<string, { config?: { token?: string } }>;
      installs?: Record<string, unknown>;
    };
    expect(persistedPlugins.entries?.old?.config?.token).toBe("${OPENCLAW_TEST_PLUGIN_TOKEN}");
    expect(persistedPlugins.entries?.demo).toEqual({ enabled: true });
    expect(persistedPlugins.installs).toBeUndefined();
  });
}

export function registerIncludeReferencePreflightTest({
  suiteRootTracker,
  allowConfigPathWrite,
  ioMocks,
}: IncludeReferenceFixture) {
  it("preflights the restored include payload with the current environment", async () => {
    const home = await suiteRootTracker.make("include-restored-preflight");
    const { configPath, pluginsPath } = await createPluginIncludeFixture(home);
    const initialPluginsRaw = `${JSON.stringify(
      {
        entries: {
          old: { enabled: true, config: { token: "${OPENCLAW_TEST_INCLUDE_TOKEN}" } },
        },
      },
      null,
      2,
    )}\n`;
    await fs.writeFile(pluginsPath, initialPluginsRaw, "utf-8");
    const oldEntry = { enabled: true, config: { token: "old-token" } };
    const snapshot = createSnapshot({
      hash: "hash-include-restored-preflight",
      path: configPath,
      parsed: { plugins: { $include: "./config/plugins.json5" } },
      sourceConfig: { plugins: { entries: { old: oldEntry } } },
    });
    snapshot.authoredConfig = {
      plugins: {
        entries: {
          old: { ...oldEntry, config: { token: "${OPENCLAW_TEST_INCLUDE_TOKEN}" } },
        },
      },
    };
    const observedSources: OpenClawConfig[] = [];

    try {
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: ({ sourceConfig }) => {
          observedSources.push(sourceConfig);
          throw new Error("stop before write");
        },
        refresh: () => true,
      });

      await expect(
        replaceConfigFile({
          baseHash: snapshot.hash,
          snapshot,
          writeOptions: {
            expectedConfigPath: snapshot.path,
            envSnapshotForRestore: { OPENCLAW_TEST_INCLUDE_TOKEN: "old-token" },
            assertConfigPathForWrite: allowConfigPathWrite,
            includeFileTargetsForWrite: { [pluginsPath]: await resolveIncludeTarget(pluginsPath) },
          },
          nextConfig: {
            plugins: {
              entries: {
                old: oldEntry,
                demo: { enabled: true },
              },
            },
          },
          io: {
            env: { OPENCLAW_TEST_INCLUDE_TOKEN: "new-token" },
            readConfigFileSnapshotForWrite: ioMocks.readConfigFileSnapshotForWrite,
            writeConfigFile: ioMocks.writeConfigFile,
          },
        }),
      ).rejects.toThrow(/active SecretRef resolution failed: stop before write/);

      expect(observedSources[0]?.plugins?.entries?.old?.config).toEqual({ token: "new-token" });
      await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(initialPluginsRaw);
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });
}
