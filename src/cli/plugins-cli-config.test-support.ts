import { vi } from "vitest";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";

type ConfigIO = ReturnType<typeof import("../config/io.factory.js").createConfigIO>;

export function createPluginCliConfigSnapshot(config: OpenClawConfig): ConfigFileSnapshot {
  const snapshot = createTestConfigSnapshot(config, config, "/tmp/openclaw-config.json5");
  return { ...snapshot, parsed: config, hash: "mock" };
}

export function createPluginCliConfigIO(params: {
  original: ConfigIO;
  configPath?: string;
  persisted: ReadonlyMap<string, OpenClawConfig>;
  getRuntimeConfig: () => OpenClawConfig;
  readSnapshot: ConfigIO["readConfigFileSnapshot"];
  readSnapshotForWrite: ConfigIO["readConfigFileSnapshotForWrite"];
}): ConfigIO {
  const projectSnapshot = (snapshot: ConfigFileSnapshot): ConfigFileSnapshot => {
    const configPath = params.configPath ?? snapshot.path;
    const config = structuredClone(params.persisted.get(configPath) ?? snapshot.config);
    const owned = createTestConfigSnapshot(config, config, configPath);
    return {
      ...snapshot,
      path: configPath,
      config: owned.config,
      runtimeConfig: owned.runtimeConfig,
      sourceConfig: owned.sourceConfig,
    };
  };
  return {
    ...params.original,
    loadConfig: () =>
      structuredClone(
        params.persisted.get(params.original.configPath) ?? params.getRuntimeConfig(),
      ),
    readConfigFileSnapshot: async () => projectSnapshot(await params.readSnapshot()),
    readConfigFileSnapshotForWrite: async () => {
      const result = await params.readSnapshotForWrite();
      const snapshot = projectSnapshot(result.snapshot);
      return {
        ...result,
        snapshot,
        writeOptions: {
          ...result.writeOptions,
          expectedConfigPath: snapshot.path,
          ownedConfigPathForWrite: snapshot.path,
        },
      };
    },
  };
}

// mock-isolation: These command fixtures own synthetic storage; ownership has a separate boundary suite.
vi.mock("./plugins-local-state.js", () => ({
  runWithLocalPluginState: async (
    _command: string,
    run: (assertCurrent: () => void) => Promise<unknown>,
  ) => run(() => {}),
}));
