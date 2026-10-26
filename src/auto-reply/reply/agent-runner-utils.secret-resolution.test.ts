import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
} from "../../agents/auth-profiles/runtime-snapshots.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshotState,
} from "../../secrets/runtime-state.js";

const { resolveSecrets, scopedTargets } = vi.hoisted(() => ({
  resolveSecrets: vi.fn(),
  scopedTargets: vi.fn(),
}));

// mock-isolation: Resolve synthetic secrets without contacting a Gateway.
vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: resolveSecrets,
}));

// mock-isolation: Supply fixed target inventories without loading channel or plugin registries.
vi.mock("../../cli/command-secret-targets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../cli/command-secret-targets.js")>();
  return {
    ...actual,
    // The real owner decides whether a prepared snapshot already covers the config;
    // unprepared configs narrow to one fixture target.
    getAgentRuntimeCommandSecretTargetIds: (
      params: Parameters<typeof actual.getAgentRuntimeCommandSecretTargetIds>[0],
    ) =>
      actual.getAgentRuntimeCommandSecretTargetIds(params).size === 0
        ? new Set<string>()
        : new Set(["skills.entries.*.apiKey"]),
    getAgentRuntimeOptionalCommandSecretPaths: () =>
      new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
    getScopedChannelsCommandSecretTargets: scopedTargets,
  };
});

const { resolveQueuedReplyExecutionConfig, resolveQueuedReplyRuntimeConfig } =
  await import("./agent-runner-utils.js");
const { clearRuntimeConfigSnapshot, getRuntimeConfigSourceSnapshot, setRuntimeConfigSnapshot } =
  await import("../../config/config.js");

const secretResult = (resolvedConfig: OpenClawConfig) => ({
  resolvedConfig,
  diagnostics: [],
  targetStatesByPath: {},
  hadUnresolvedTargets: false,
});
const sourceConfig: OpenClawConfig = {};
function expectScope(config: OpenClawConfig, accountId?: string) {
  expect(scopedTargets).toHaveBeenCalledWith({
    config,
    channel: "discord",
    accountId,
  });
}

describe("resolveQueuedReplyExecutionConfig channel scope", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    resolveSecrets.mockReset().mockImplementation(async ({ config }) => secretResult(config));
    scopedTargets.mockReset().mockReturnValue({
      targetIds: new Set(["channels.discord.token"]),
      allowedPaths: new Set(["channels.discord.token", "channels.discord.accounts.work.token"]),
    });
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshotState();
  });

  it("resolves base runtime targets, then active channel/account targets from originating context", async () => {
    const baseResolved: OpenClawConfig = { tools: { profile: "coding" } };
    const scopedResolved: OpenClawConfig = { tools: { profile: "full" } };
    resolveSecrets
      .mockResolvedValueOnce(secretResult(baseResolved))
      .mockResolvedValueOnce(secretResult(scopedResolved));

    const resolved = await resolveQueuedReplyExecutionConfig(sourceConfig, {
      originatingChannel: "discord",
      messageProvider: "slack",
      originatingAccountId: "work",
      agentAccountId: "default",
    });

    expect(resolved).toBe(scopedResolved);
    expect(resolveSecrets).toHaveBeenCalledTimes(2);
    expect(resolveSecrets.mock.calls[0]?.[0]).toEqual({
      config: sourceConfig,
      commandName: "reply",
      targetIds: new Set(["skills.entries.*.apiKey"]),
      optionalActivePaths: new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
    });
    expect(resolveSecrets.mock.calls[0]?.[0].config).toBe(sourceConfig);
    expectScope(baseResolved, "work");
    expect(resolveSecrets.mock.calls[1]?.[0]).toEqual({
      config: baseResolved,
      commandName: "reply",
      targetIds: new Set(["channels.discord.token"]),
      allowedPaths: new Set(["channels.discord.token", "channels.discord.accounts.work.token"]),
    });
    expect(resolveSecrets.mock.calls[1]?.[0].config).toBe(baseResolved);
  });

  it("falls back to messageProvider and agentAccountId when originating values are missing", async () => {
    await resolveQueuedReplyExecutionConfig(sourceConfig, {
      messageProvider: "discord",
      agentAccountId: "ops",
    });

    expectScope(sourceConfig, "ops");
  });

  it("skips scoped channel resolution when no active channel can be resolved", async () => {
    const resolved = await resolveQueuedReplyExecutionConfig(sourceConfig);

    expect(resolved).toBe(sourceConfig);
    expect(resolveSecrets).toHaveBeenCalledTimes(1);
    expect(scopedTargets).not.toHaveBeenCalled();
  });

  it("prefers the runtime snapshot as the base config for secret resolution", async () => {
    const runtimeConfig: OpenClawConfig = { tools: { profile: "coding" } };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    scopedTargets.mockReturnValue({
      targetIds: new Set<string>(),
    });

    await resolveQueuedReplyExecutionConfig(sourceConfig, {
      messageProvider: "discord",
    });

    const baseCall = resolveSecrets.mock.calls[0]?.[0];
    expect(baseCall.config).toBe(runtimeConfig);
    expect(baseCall.commandName).toBe("reply");
    expectScope(runtimeConfig);
  });

  it("does not replace an already resolved run config with a stale runtime snapshot", () => {
    const withKey = (
      apiKey: string | { source: "env"; provider: string; id: string },
    ): OpenClawConfig => ({
      models: { providers: { openai: { baseUrl: "https://unused.invalid", apiKey, models: [] } } },
    });
    const unresolvedConfig = withKey({ source: "env", provider: "default", id: "OPENAI_API_KEY" });
    const staleRuntimeConfig = withKey("stale-runtime-key");
    const scopedResolvedConfig = { ...withKey("fresh-scoped-key"), tools: { updatePlan: true } };
    setRuntimeConfigSnapshot(staleRuntimeConfig, unresolvedConfig);

    expect(resolveQueuedReplyRuntimeConfig(structuredClone(unresolvedConfig))).toBe(
      staleRuntimeConfig,
    );
    expect(resolveQueuedReplyRuntimeConfig(scopedResolvedConfig)).toBe(scopedResolvedConfig);
  });

  function activateRuntime(secretSource: OpenClawConfig, config: OpenClawConfig) {
    activateSecretsRuntimeSnapshotState({
      snapshot: {
        sourceConfig: secretSource,
        config,
        authStores: [],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      },
      // The gateway activation this models prepares config SecretRefs; an
      // unrecorded activation must not reach the fast path.
      refreshContext: {
        env: {},
        explicitAgentDirs: null,
        includeConfigRefs: true,
        includeAuthStoreRefs: false,
        loadablePluginOrigins: new Map(),
      },
      refreshHandler: null,
    });
    return resolveQueuedReplyRuntimeConfig(secretSource);
  }

  it("keeps queued replies on the activated SecretRef bytes without command-time resolution", async () => {
    const secretSource: OpenClawConfig = {
      skills: {
        entries: {
          example: { apiKey: { source: "env", provider: "default", id: "EXAMPLE_API_KEY" } },
        },
      },
    };
    const runtimeConfig = activateRuntime(secretSource, {
      skills: { entries: { example: { apiKey: "activated-key" } } },
    });
    // Mirrors the gateway: refs are materialized only for nonempty target sets.
    resolveSecrets.mockImplementation(
      async ({ config, targetIds }: { config: OpenClawConfig; targetIds?: Set<string> }) => ({
        resolvedConfig:
          targetIds?.size === 0
            ? config
            : { skills: { entries: { example: { apiKey: "command-key" } } } },
      }),
    );

    // Healthy activated bytes leave no scoped channel targets to resolve.
    scopedTargets.mockReturnValue({ targetIds: new Set() });
    for (const config of [secretSource, runtimeConfig, structuredClone(secretSource)]) {
      const resolved = await resolveQueuedReplyExecutionConfig(config, {
        originatingChannel: "discord",
      });
      expect(resolved).toBe(runtimeConfig);
      expect(JSON.stringify(resolved)).toBe(JSON.stringify(runtimeConfig));
    }
    // The prepared snapshot leaves the shared owner no command targets to resolve.
    for (const [call] of resolveSecrets.mock.calls) {
      expect(call.targetIds).toEqual(new Set());
    }
  });

  it("keeps cold channel-account resolution for activated configs", async () => {
    const secretSource: OpenClawConfig = {
      skills: {
        entries: {
          example: { apiKey: { source: "env", provider: "default", id: "EXAMPLE_API_KEY" } },
        },
      },
    };
    const runtimeConfig = activateRuntime(secretSource, {
      skills: { entries: { example: { apiKey: "activated-key" } } },
    });
    // A cold account still carries an unresolved scoped target; the activated
    // snapshot must not bypass the channel/account-scoped stage that rejects it.
    const scopedResolved = {
      ...runtimeConfig,
      channels: { discord: { accounts: { work: { token: "scoped-token" } } } },
    };
    resolveSecrets.mockImplementation(
      async ({ config, targetIds }: { config: OpenClawConfig; targetIds?: Set<string> }) => ({
        resolvedConfig: targetIds?.size === 0 ? config : scopedResolved,
      }),
    );
    const resolved = await resolveQueuedReplyExecutionConfig(runtimeConfig, {
      originatingChannel: "discord",
      originatingAccountId: "work",
    });
    expect(resolved).toBe(scopedResolved);
    expect(resolveSecrets).toHaveBeenCalledTimes(2);
    expect(resolveSecrets.mock.calls[0]?.[0].targetIds).toEqual(new Set());
    expect(resolveSecrets.mock.calls[1]?.[0].config).toBe(runtimeConfig);
    expect(resolveSecrets.mock.calls[1]?.[0].targetIds).toEqual(
      new Set(["channels.discord.token"]),
    );
  });

  it("adopts a new runtime generation for a previously queued config while preserving explicit overrides", async () => {
    const secretSource: OpenClawConfig = {
      skills: {
        entries: {
          example: { apiKey: { source: "env", provider: "default", id: "EXAMPLE_API_KEY" } },
        },
      },
    };
    const queuedConfig = activateRuntime(secretSource, {
      skills: { entries: { example: { apiKey: "first-key" } } },
    });
    const queuedSource = getRuntimeConfigSourceSnapshot()!;
    const changedSource: OpenClawConfig = {
      ...secretSource,
      tools: { updatePlan: true },
    };
    const changedRuntime = activateRuntime(changedSource, {
      skills: { entries: { example: { apiKey: "rotated-key" } } },
      tools: { updatePlan: true },
    });

    expect(await resolveQueuedReplyExecutionConfig(queuedConfig)).toBe(changedRuntime);
    expect(await resolveQueuedReplyExecutionConfig(queuedSource)).toBe(changedRuntime);
    const override = { ...queuedConfig, tools: { updatePlan: false } };
    expect(resolveQueuedReplyRuntimeConfig(override)).toBe(override);
  });
});
