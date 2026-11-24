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
const tokenName = "OPENCLAW_TEST_PLUGIN_TOKEN";
const token = "old-token";
const readFile = (path: string) => fs.readFile(path, "utf-8");

async function referenceFixture(
  { suiteRootTracker, allowConfigPathWrite }: IncludeReferenceFixture,
  name: string,
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
      await referenceFixture(fixture, "include", { optional: "${OPTIONAL_TOKEN}" });
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
          env: { [tokenName]: "plugin-token-after-read" },
        },
      });
    } finally {
      unregister();
    }

    expect(notifications).toEqual([
      expect.objectContaining({
        configPath,
        persistedHash: "hash-include-refreshed",
        sourceConfig: nextConfig,
        runtimeConfig: nextConfig,
        afterWrite,
      }),
    ]);
    await expect(readFile(configPath)).resolves.toContain('"$include": "./config/plugins.json5"');
    await expect(readFile(`${pluginsPath}.bak`)).resolves.toContain('"old"');
    await expect(readFile(`${pluginsPath}.bak.1`)).resolves.toBe("previous backup");
    if (process.platform !== "win32") {
      expect((await fs.stat(`${pluginsPath}.bak`)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(`${pluginsPath}.bak.1`)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await readFile(pluginsPath))).toEqual(
      pluginConfig(authoredOldEntry, true).plugins,
    );
  });
}

export function registerIncludeReferencePreflightTest(fixture: IncludeReferenceFixture) {
  const { ioMocks } = fixture;
  it("preflights the restored include payload with the current environment", async () => {
    const { pluginsPath, oldEntry, initialPluginsRaw, snapshot, writeOptions } =
      await referenceFixture(fixture, "include-restored-preflight");
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
            env: { [tokenName]: "new-token" },
          },
        }),
      ).rejects.toThrow(/active SecretRef resolution failed: stop before write/);

      expect(observedSources[0]?.plugins?.entries?.old?.config).toEqual({ token: "new-token" });
      await expect(readFile(pluginsPath)).resolves.toBe(initialPluginsRaw);
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });
}
