import { vi, type Mock } from "vitest";
import type { ConfigIoFactoryOptions } from "../config/io.types.js";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { getMockCallOutput } from "./test-runtime-capture.js";

const callArg = <T>(mock: Mock, index = 0): T | undefined =>
  mock.mock.calls[index]?.[0] as T | undefined;
type PluginCall = Record<string, unknown> & { config?: OpenClawConfig };

export function createUpdateConfigMock() {
  const readConfigFileSnapshot = vi.fn();
  return {
    createConfigIO: (options: ConfigIoFactoryOptions = {}) => ({
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
    ConfigMutationConflictError,
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
  syncPluginsForUpdateChannel: sync,
  updateNpmInstalledPlugins: npm,
  readConfigFileSnapshot: readSnapshot,
  mutateConfigFileWithRetry: mutate,
  replaceConfigFile: replace,
  defaultRuntime: runtime,
}: Pick<
  typeof import("../config/config.js"),
  "readConfigFileSnapshot" | "mutateConfigFileWithRetry" | "replaceConfigFile"
> & {
  syncPluginsForUpdateChannel: Mock;
  updateNpmInstalledPlugins: Mock;
  defaultRuntime: typeof import("../runtime.js").defaultRuntime;
}) {
  const syncPluginCall = (index = 0) => callArg<PluginCall & { channel?: string }>(sync, index);
  const npmPluginUpdateCall = (index = 0) =>
    callArg<PluginCall & { timeoutMs?: number }>(npm, index);
  return {
    syncPluginCall,
    npmPluginUpdateCall,
    lastNpmPluginUpdateCall: () => npmPluginUpdateCall(npm.mock.calls.length - 1),
    replaceConfigCall: (index = 0) => vi.mocked(replace).mock.calls[index]?.[0],
    lastReplaceConfigCall: () => vi.mocked(replace).mock.calls.at(-1)?.[0],
    setupConfigMutationWithRetryMock(
      onCommitted?: (snapshot: ConfigFileSnapshot, nextConfig: OpenClawConfig) => void,
    ) {
      vi.mocked(mutate).mockImplementation(async (params) => {
        const snapshot = await readSnapshot();
        const nextConfig = structuredClone(snapshot.sourceConfig) as OpenClawConfig;
        await params.mutate(nextConfig, {
          snapshot,
          previousHash: snapshot.hash ?? null,
          attempt: 0,
        });
        await replace({
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
    },
    lastWriteJsonCall: () => vi.mocked(runtime.writeJson).mock.calls.at(-1)?.[0],
    getLogOutput: () => getMockCallOutput(vi.mocked(runtime.log)),
    getErrorOutput: () => getMockCallOutput(vi.mocked(runtime.error)),
  };
}
