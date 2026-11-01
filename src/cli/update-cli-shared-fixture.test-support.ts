import { vi, type Mock } from "vitest";
import type { ConfigMutationIO, TransformConfigFileWithRetryParams } from "../config/mutate.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { getMockCallOutput } from "./test-runtime-capture.js";

/** Model the parent phase that precedes an otherwise standalone post-core child. */
export async function withPostCoreUpdateFixtureRun<T>(operation: () => Promise<T>): Promise<T> {
  if (process.env.OPENCLAW_UPDATE_RUN_ID?.trim()) {
    return await operation();
  }
  const [{ createUpdateRun, recordUpdateRunStep }, { withEnvAsync }, { VERSION }] =
    await Promise.all([
      import("../infra/update-run-ledger.js"),
      import("../test-utils/env.js"),
      import("../version.js"),
    ]);
  const { runId } = createUpdateRun({ trigger: "cli", before: { version: VERSION } });
  recordUpdateRunStep(runId, { step: "openclaw doctor", status: "completed" });
  recordUpdateRunStep(runId, { step: "post-update verification", status: "in_progress" });
  return await withEnvAsync({ OPENCLAW_UPDATE_RUN_ID: runId }, operation);
}

export function createUpdateConfigMock() {
  const readConfigFileSnapshot = vi.fn();
  // Keep orchestration I/O synthetic while using the config owner's transform
  // and publication receipts, including custom plugin-index commits.
  const io: ConfigMutationIO = {
    readConfigFileSnapshotForWrite: async (options) => ({
      snapshot: await readConfigFileSnapshot(options),
      writeOptions: {},
    }),
    writeConfigFile: async () => {},
  };
  const replaceConfigFile = vi.fn<typeof import("../config/mutate.js").replaceConfigFile>(
    async (params) => {
      const actual = await import("../config/mutate.js");
      return await actual.replaceConfigFile({ ...params, io });
    },
  );
  return {
    // Source-only recovery cleanup may import the runtime loader, but must not use it.
    loadConfig: vi.fn((): OpenClawConfig => {
      throw new Error("Unexpected runtime config load in update fixture");
    }),
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
        throw new Error(
          [
            "Config is managed by Nix (`OPENCLAW_NIX_MODE=1`), so OpenClaw treats openclaw.json as immutable.",
            "Do not run setup, onboarding, openclaw update, plugin install/update/uninstall/enable, doctor repair/token-generation, or config set against this file.",
            "Agent-first Nix setup: https://github.com/openclaw/nix-openclaw#quick-start",
            "OpenClaw Nix overview: https://docs.openclaw.ai/install/nix",
          ].join("\n"),
        );
      }
    },
    ConfigMutationConflictError: class ConfigMutationConflictError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ConfigMutationConflictError";
      }
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
    transformConfigFileWithRetry: async <T>(params: TransformConfigFileWithRetryParams<T>) => {
      const actual = await import("../config/mutate.js");
      return await actual.transformConfigFileWithRetry({ ...params, io });
    },
    replaceConfigFile,
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
  const syncPluginCall = (index = 0) => {
    const calls = syncPluginsForUpdateChannel.mock.calls as unknown as Array<
      [Record<string, unknown> & { channel?: string; config?: OpenClawConfig }]
    >;
    return calls[index]?.[0];
  };

  const npmPluginUpdateCall = (index = 0) => {
    const calls = updateNpmInstalledPlugins.mock.calls as unknown as Array<
      [Record<string, unknown> & { config?: OpenClawConfig; timeoutMs?: number }]
    >;
    return calls[index]?.[0];
  };
  const lastNpmPluginUpdateCall = () =>
    npmPluginUpdateCall(updateNpmInstalledPlugins.mock.calls.length - 1);

  const replaceConfigCall = (index = 0) => vi.mocked(replaceConfigFile).mock.calls[index]?.[0];
  const lastReplaceConfigCall = () =>
    replaceConfigCall(vi.mocked(replaceConfigFile).mock.calls.length - 1);
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

  const writeJsonCall = (index = 0) => vi.mocked(defaultRuntime.writeJson).mock.calls[index]?.[0];
  const lastWriteJsonCall = () =>
    writeJsonCall(vi.mocked(defaultRuntime.writeJson).mock.calls.length - 1);
  const getLogOutput = () => getMockCallOutput(vi.mocked(defaultRuntime.log));
  const getErrorOutput = () => getMockCallOutput(vi.mocked(defaultRuntime.error));
  return {
    syncPluginCall,
    npmPluginUpdateCall,
    lastNpmPluginUpdateCall,
    replaceConfigCall,
    lastReplaceConfigCall,
    setupConfigMutationWithRetryMock,
    lastWriteJsonCall,
    getLogOutput,
    getErrorOutput,
  };
}
