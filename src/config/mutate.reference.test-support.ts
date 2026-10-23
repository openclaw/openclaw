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
import type { OpenClawConfig } from "./types.js";

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

const demo = { enabled: true };
type PluginEntry = { enabled: boolean; config: Record<string, string> };
const pluginConfig = (old: PluginEntry, addDemo = false) => ({
  plugins: { entries: { old, ...(addDemo ? { demo } : {}) } },
});
const jsonFile = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const parsedInclude = { plugins: { $include: "./config/plugins.json5" } };

async function referenceFixture(
  { suiteRootTracker, allowConfigPathWrite }: IncludeReferenceFixture,
  name: string,
  tokenName: string,
  token: string,
  extra: Record<string, string> = {},
) {
  const paths = await createPluginIncludeFixture(await suiteRootTracker.make(name));
  const authoredOldEntry = { enabled: true, config: { token: `\${${tokenName}}`, ...extra } };
  const oldEntry = { ...authoredOldEntry, config: { token, ...extra } };
  const initialPluginsRaw = jsonFile(pluginConfig(authoredOldEntry).plugins);
  await fs.writeFile(paths.pluginsPath, initialPluginsRaw, "utf-8");
  const snapshot = createSnapshot({
    hash: `hash-${name}`,
    path: paths.configPath,
    parsed: parsedInclude,
    sourceConfig: pluginConfig(oldEntry),
  });
  snapshot.authoredConfig = pluginConfig(authoredOldEntry);
  const writeOptions = {
    expectedConfigPath: paths.configPath,
    envSnapshotForRestore: { [tokenName]: token },
    assertConfigPathForWrite: allowConfigPathWrite,
    includeFileTargetsForWrite: {
      [paths.pluginsPath]: await resolveIncludeTarget(paths.pluginsPath),
    },
  };
  return { ...paths, authoredOldEntry, oldEntry, initialPluginsRaw, snapshot, writeOptions };
}

export function registerPluginIncludeReferenceRepairTest(fixture: IncludeReferenceFixture) {
  const { ioMocks } = fixture;
  it("repairs invalid config through a single-file top-level plugins include", async () => {
    const { configPath, pluginsPath, authoredOldEntry, oldEntry, snapshot, writeOptions } =
      await referenceFixture(
        fixture,
        "include",
        "OPENCLAW_TEST_PLUGIN_TOKEN",
        "plugin-token-runtime",
        {
          optional: "${OPTIONAL_TOKEN}",
        },
      );
    const previousBackupPath = `${pluginsPath}.bak`;
    await fs.writeFile(previousBackupPath, "previous backup", { mode: 0o644 });
    snapshot.valid = false;
    snapshot.issues = [{ path: "plugins.load.paths", message: "plugin path not found: /gone" }];
    const nextConfig = pluginConfig(oldEntry, true);
    const refreshedSnapshot = createSnapshot({
      hash: "hash-include-refreshed",
      path: configPath,
      parsed: parsedInclude,
      sourceConfig: nextConfig,
    });
    ioMocks.readConfigFileSnapshotForWrite
      .mockResolvedValueOnce({ snapshot, writeOptions })
      .mockResolvedValueOnce({
        snapshot: refreshedSnapshot,
        writeOptions: { expectedConfigPath: configPath },
      });
    const notifications: unknown[] = [];
    const unregister = registerRuntimeConfigWriteListener((event) => {
      notifications.push(event);
    });

    const afterWrite = { mode: "restart", reason: "test include refresh" } as const;
    try {
      await replaceConfigFile({
        baseHash: snapshot.hash,
        afterWrite,
        writeOptions: {
          expectedConfigPath: snapshot.path,
          unsetPaths: [["plugins", "installs"]],
        },
        nextConfig: {
          plugins: {
            ...nextConfig.plugins,
            installs: { demo: { source: "npm", spec: "demo", installPath: "/tmp/demo" } },
          },
        },
        io: {
          ...ioMocks,
          env: { OPENCLAW_TEST_PLUGIN_TOKEN: "plugin-token-after-read" },
        },
      });
    } finally {
      unregister();
    }

    expect(ioMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(notifications).toEqual([
      expect.objectContaining({
        configPath,
        persistedHash: "hash-include-refreshed",
        sourceConfig: nextConfig,
        runtimeConfig: nextConfig,
        afterWrite,
      }),
    ]);
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
      entries?: Record<string, { config?: { token?: string; optional?: string } }>;
      installs?: Record<string, unknown>;
    };
    expect(persistedPlugins.entries?.old?.config).toEqual(authoredOldEntry.config);
    expect(persistedPlugins.entries?.demo).toEqual({ enabled: true });
    expect(persistedPlugins.installs).toBeUndefined();
  });
}

export function registerIncludeReferencePreflightTest(fixture: IncludeReferenceFixture) {
  const { ioMocks } = fixture;
  it("preflights the restored include payload with the current environment", async () => {
    const { pluginsPath, oldEntry, initialPluginsRaw, snapshot, writeOptions } =
      await referenceFixture(
        fixture,
        "include-restored-preflight",
        "OPENCLAW_TEST_INCLUDE_TOKEN",
        "old-token",
      );
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
          writeOptions,
          nextConfig: pluginConfig(oldEntry, true),
          io: {
            ...ioMocks,
            env: { OPENCLAW_TEST_INCLUDE_TOKEN: "new-token" },
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
