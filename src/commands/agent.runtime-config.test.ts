import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentRuntimeConfig } from "../agents/agent-runtime-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

type ConfigSnapshotForWrite = {
  snapshot: { valid: boolean; resolved: OpenClawConfig };
  writeOptions: { basePluginMetadataSnapshot?: PluginMetadataSnapshot };
};

type ResolveCommandConfigParams = Parameters<
  typeof import("../cli/command-config-resolution.runtime.js").resolveCommandConfigWithSecrets
>[0];

const loadConfigMock = vi.hoisted(() => vi.fn<() => OpenClawConfig>());
const readConfigFileSnapshotForWriteMock = vi.hoisted(() =>
  vi.fn<() => Promise<ConfigSnapshotForWrite>>(),
);
// mock-isolation: Secret-resolution cases control runtime/source snapshots without real config IO.
vi.mock("../config/io.js", () => ({
  captureRuntimeConfigAsyncReader: () => async () => loadConfigMock(),
  getRuntimeConfig: loadConfigMock,
  loadConfig: loadConfigMock,
  readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: (params?: { includeChannelTargets?: boolean }) =>
    new Set([
      "models.providers.*.apiKey",
      ...(params?.includeChannelTargets === true ? ["channels.telegram.botToken"] : []),
    ]),
  getAgentRuntimeOptionalCommandSecretPaths: () =>
    new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
  getScopedChannelsCommandSecretTargets: (params: {
    config: OpenClawConfig;
    channel?: string;
    accountId?: string;
    defaultAccountWhenMissing?: boolean;
  }) => {
    const channelConfig = params.config.channels?.[params.channel ?? ""] as
      | { defaultAccount?: string }
      | undefined;
    const accountId =
      params.accountId ??
      (params.defaultAccountWhenMissing ? (channelConfig?.defaultAccount ?? "default") : undefined);
    return {
      targetIds: new Set(
        params.channel === "telegram"
          ? ["channels.telegram.botToken", "channels.telegram.accounts.*.botToken"]
          : params.channel === "discord"
            ? ["channels.discord.token"]
            : [],
      ),
      ...(params.channel === "telegram" && accountId
        ? {
            allowedPaths: new Set([
              "channels.telegram.botToken",
              `channels.telegram.accounts.${accountId}.botToken`,
            ]),
          }
        : {}),
    };
  },
}));

vi.mock("../secrets/target-registry.js", () => ({
  discoverConfigSecretTargetsByIds: (
    config: OpenClawConfig,
    targetIds: Iterable<string>,
  ): Array<{ path: string }> => {
    const ids = new Set(targetIds);
    return ids.has("models.providers.*.apiKey") && config.models?.providers?.openai?.apiKey
      ? [{ path: "models.providers.openai.apiKey" }]
      : [];
  },
}));

const setRuntimeConfigSnapshotMock = vi.hoisted(() =>
  vi.fn<(cfg: OpenClawConfig, sourceConfig: OpenClawConfig) => void>(),
);
vi.mock("../config/runtime-snapshot.js", () => ({
  getRuntimeConfigSourceSnapshot: () => null,
  registerRuntimeConfigSnapshotPreparer: vi.fn(),
  setRuntimeConfigSnapshot: setRuntimeConfigSnapshotMock,
}));

const getActiveSecretsRuntimeConfigSnapshotMock = vi.hoisted(() =>
  vi.fn<typeof import("../secrets/runtime-state.js").getActiveSecretsRuntimeConfigSnapshot>(),
);
vi.mock("../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: getActiveSecretsRuntimeConfigSnapshotMock,
}));
const prepareSecretsRuntimeSnapshotMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      config: OpenClawConfig;
      assignmentConfig: OpenClawConfig;
      pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins" | "manifestRegistry">;
    }) => ({
      sourceConfig: params.config,
      config: params.assignmentConfig,
      authStores: [],
      authStoreCredentialsRevision: 0,
      authStoreSnapshotsRevision: 0,
      warnings: [],
      webTools: {},
    }),
  ),
);
const activateSecretsRuntimeSnapshotMock = vi.hoisted(() => vi.fn());
vi.mock("../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: prepareSecretsRuntimeSnapshotMock,
  activateSecretsRuntimeSnapshot: activateSecretsRuntimeSnapshotMock,
}));

const resolveCommandConfigWithSecretsMock = vi.hoisted(() =>
  vi.fn<
    (params: ResolveCommandConfigParams) => Promise<{
      resolvedConfig: OpenClawConfig;
      effectiveConfig: OpenClawConfig;
      diagnostics: never[];
    }>
  >(),
);
vi.mock("../cli/command-config-resolution.runtime.js", () => ({
  resolveCommandConfigWithSecrets: resolveCommandConfigWithSecretsMock,
}));

const runtime = createThrowingTestRuntime();

function mockConfig(cfg: OpenClawConfig = {}): OpenClawConfig {
  loadConfigMock.mockReturnValue(cfg);
  return cfg;
}

const secretRef = (id: string) => ({ source: "env" as const, provider: "default", id });
function modelConfig(apiKey: string | ReturnType<typeof secretRef>): OpenClawConfig["models"] {
  return { providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey, models: [] } } };
}
function telegramConfig(defaultAccount?: string): OpenClawConfig["channels"] {
  return {
    telegram: {
      ...(defaultAccount ? { defaultAccount } : { botToken: secretRef("TELEGRAM_BOT_TOKEN") }),
      accounts: {
        ops: { botToken: secretRef("TELEGRAM_OPS_TOKEN") },
        chat: { botToken: secretRef("TELEGRAM_CHAT_TOKEN") },
      },
    },
  };
}
function resolveSecretsWith(config: OpenClawConfig) {
  resolveCommandConfigWithSecretsMock.mockResolvedValueOnce({
    resolvedConfig: config,
    effectiveConfig: config,
    diagnostics: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getActiveSecretsRuntimeConfigSnapshotMock.mockImplementation(() => ({
    config: loadConfigMock(),
    sourceConfig: loadConfigMock(),
    configRefsPrepared: true,
  }));
  readConfigFileSnapshotForWriteMock.mockResolvedValue({
    snapshot: { valid: false, resolved: {} as OpenClawConfig },
    writeOptions: {},
  });
});

describe("agentCommand runtime config", () => {
  it("materializes auth-profile refs for standalone local runs", async () => {
    const loadedConfig = mockConfig();
    const sourceConfig = { ...loadedConfig, secrets: { providers: {} } } as OpenClawConfig;
    const pluginMetadataSnapshot = {
      plugins: [],
      manifestRegistry: { plugins: [], diagnostics: [] },
    } as unknown as PluginMetadataSnapshot;
    readConfigFileSnapshotForWriteMock.mockResolvedValue({
      snapshot: { valid: true, resolved: sourceConfig },
      writeOptions: { basePluginMetadataSnapshot: pluginMetadataSnapshot },
    });
    getActiveSecretsRuntimeConfigSnapshotMock.mockReturnValue(null);

    await resolveAgentRuntimeConfig(runtime);

    expect(prepareSecretsRuntimeSnapshotMock).toHaveBeenCalledWith({
      config: sourceConfig,
      assignmentConfig: loadedConfig,
      includeConfigRefs: false,
      pluginMetadataSnapshot,
    });
    expect(prepareSecretsRuntimeSnapshotMock.mock.calls[0]?.[0].pluginMetadataSnapshot).toBe(
      pluginMetadataSnapshot,
    );
    expect(activateSecretsRuntimeSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceConfig, config: loadedConfig }),
    );
    expect(setRuntimeConfigSnapshotMock).not.toHaveBeenCalled();
  });

  it("sets runtime snapshots from source config before embedded agent run", async () => {
    const loadedConfig = mockConfig({ models: modelConfig(secretRef("OPENAI_API_KEY")) });
    const sourceConfig = structuredClone(loadedConfig);
    const resolvedConfig = {
      ...loadedConfig,
      models: modelConfig("sk-resolved-runtime"), // pragma: allowlist secret
    };

    getActiveSecretsRuntimeConfigSnapshotMock.mockReturnValue({
      config: loadedConfig,
      sourceConfig,
      configRefsPrepared: true,
    });
    resolveSecretsWith(resolvedConfig);

    const prepared = await resolveAgentRuntimeConfig(runtime);

    expect(resolveCommandConfigWithSecretsMock).toHaveBeenCalledWith({
      config: loadedConfig,
      commandName: "agent",
      targetIds: new Set(["models.providers.*.apiKey"]),
      optionalActivePaths: new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
      runtime,
    });
    expect(setRuntimeConfigSnapshotMock).toHaveBeenCalledWith(resolvedConfig, sourceConfig);
    expect(prepared).toBe(resolvedConfig);
  });

  it.each(["default", "selected"])("scopes routing secrets to the %s account", async (scope) => {
    const selected = scope === "selected";
    const loadedConfig = mockConfig({
      channels: telegramConfig(selected ? undefined : "ops"),
      ...(selected ? { models: modelConfig(secretRef("OPENAI_API_KEY")) } : {}),
    });
    resolveSecretsWith(loadedConfig);
    await resolveAgentRuntimeConfig(runtime, {
      runtimeChannelSecretScope: { channel: "telegram", ...(selected ? { accountId: "ops" } : {}) },
    });
    expect(resolveCommandConfigWithSecretsMock.mock.calls[0]?.[0].allowedPaths).toEqual(
      new Set([
        ...(selected ? ["models.providers.openai.apiKey"] : []),
        "channels.telegram.botToken",
        "channels.telegram.accounts.ops.botToken",
      ]),
    );
  });

  it.each([
    ["global", { memory: memoryConfig("MEMORY_HEADER") }],
    [
      "per-agent",
      { agents: { entries: { personal: { memory: memoryConfig("AGENT_MEMORY_HEADER") } } } },
    ],
  ] as const)("resolves command secrets for %s memory headers", async (_scope, config) => {
    const loadedConfig = mockConfig(config as unknown as OpenClawConfig);
    resolveSecretsWith(loadedConfig);

    await resolveAgentRuntimeConfig(runtime);

    expect(resolveCommandConfigWithSecretsMock).toHaveBeenCalledTimes(1);
  });
});

function memoryConfig(id: string) {
  return { search: { remote: { headers: { Authorization: secretRef(id) } } } };
}
