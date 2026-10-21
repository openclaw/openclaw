import { vi, type Mock } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { getMockCallOutput } from "./test-runtime-capture.js";

function callArg<T>(mock: Mock, index = 0): T | undefined {
  return mock.mock.calls[index]?.[0] as T | undefined;
}
type PluginCall = Record<string, unknown> & { config?: OpenClawConfig };

export function createUpdateConfigMock() {
  const readConfigFileSnapshot = vi.fn();
  return {
    createConfigIO: (
      options: {
        pluginValidation?: string;
        observe?: boolean;
        suppressFutureVersionWarning?: boolean;
      } = {},
    ) => ({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: await readConfigFileSnapshot({
          ...(options.pluginValidation === "skip" ? { skipPluginValidation: true } : {}),
          ...(options.observe !== undefined ? { observe: options.observe } : {}),
          ...(options.suppressFutureVersionWarning !== undefined
            ? { suppressFutureVersionWarning: options.suppressFutureVersionWarning }
            : {}),
        }),
        writeOptions: {},
      }),
    }),
    assertConfigWriteAllowedInCurrentMode: () => {
      if (process.env.OPENCLAW_NIX_MODE === "1") {
        throw new Error("Config is managed by Nix (`OPENCLAW_NIX_MODE=1`).");
      }
    },
    ConfigMutationConflictError: class ConfigMutationConflictError extends Error {
      override name = "ConfigMutationConflictError";
    },
    parseConfigJson5: (raw: string) => {
      try {
        return { ok: true, parsed: JSON.parse(raw) };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    readConfigFileSnapshot,
    readSourceConfigBestEffort: vi.fn(),
    mutateConfigFileWithRetry: vi.fn(),
    replaceConfigFile: vi.fn(),
    resolveGatewayPort: vi.fn(() => 18789),
  };
}

export function createUpdateFixtureAssertions({
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
  readConfigFileSnapshot,
  mutateConfigFileWithRetry,
  replaceConfigFile,
  defaultRuntime,
}: Pick<
  typeof import("../config/config.js"),
  "readConfigFileSnapshot" | "mutateConfigFileWithRetry" | "replaceConfigFile"
> & {
  syncPluginsForUpdateChannel: Mock;
  updateNpmInstalledPlugins: Mock;
  defaultRuntime: typeof import("../runtime.js").defaultRuntime;
}) {
  const syncPluginCall = (index = 0) =>
    callArg<PluginCall & { channel?: string }>(syncPluginsForUpdateChannel, index);
  const npmPluginUpdateCall = (index = 0) =>
    callArg<PluginCall & { timeoutMs?: number }>(updateNpmInstalledPlugins, index);
  const setupConfigMutationWithRetryMock = (
    onCommitted?: (snapshot: ConfigFileSnapshot, nextConfig: OpenClawConfig) => void,
  ) => {
    vi.mocked(mutateConfigFileWithRetry).mockImplementation(async (params) => {
      const snapshot = await readConfigFileSnapshot();
      const nextConfig = structuredClone(snapshot.sourceConfig) as OpenClawConfig;
      await params.mutate(nextConfig, {
        snapshot,
        previousHash: snapshot.hash ?? null,
        attempt: 0,
      });
      await replaceConfigFile({
        nextConfig,
        ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
      });
      onCommitted?.(snapshot, nextConfig);
      return {
        path: snapshot.path,
        previousHash: snapshot.hash ?? null,
        snapshot,
        nextConfig,
        persistedHash: snapshot.hash ?? null,
        result: undefined,
        attempts: 1,
        afterWrite: { mode: "none", reason: "test" },
        followUp: { mode: "none", reason: "test", requiresRestart: false },
      };
    });
  };

  return {
    syncPluginCall,
    npmPluginUpdateCall,
    lastNpmPluginUpdateCall: () =>
      npmPluginUpdateCall(updateNpmInstalledPlugins.mock.calls.length - 1),
    replaceConfigCall: (index = 0) => vi.mocked(replaceConfigFile).mock.calls[index]?.[0],
    lastReplaceConfigCall: () => vi.mocked(replaceConfigFile).mock.calls.at(-1)?.[0],
    setupConfigMutationWithRetryMock,
    lastWriteJsonCall: () => vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0],
    getLogOutput: () => getMockCallOutput(vi.mocked(defaultRuntime.log)),
    getErrorOutput: () => getMockCallOutput(vi.mocked(defaultRuntime.error)),
  };
}
