// Tests queued reply runtime secret resolution for agent and channel scopes.
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

const hoisted = vi.hoisted(() => ({
  resolveCommandSecretRefsViaGatewayMock: vi.fn(),
  getScopedChannelsCommandSecretTargetsMock: vi.fn(),
}));

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: (...args: unknown[]) =>
    hoisted.resolveCommandSecretRefsViaGatewayMock(...args),
}));

vi.mock("../../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: () => new Set(["skills.entries.*.apiKey"]),
  getAgentRuntimeOptionalCommandSecretPaths: () =>
    new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
  getScopedChannelsCommandSecretTargets: (...args: unknown[]) =>
    hoisted.getScopedChannelsCommandSecretTargetsMock(...args),
}));

const { resolveQueuedReplyExecutionConfig, resolveQueuedReplyRuntimeConfig } =
  await import("./agent-runner-utils.js");
const { clearRuntimeConfigSnapshot, getRuntimeConfigSourceSnapshot, setRuntimeConfigSnapshot } =
  await import("../../config/config.js");

type ResolveCommandSecretRefsCall = {
  config: OpenClawConfig;
  commandName: string;
  targetIds?: Set<string>;
  allowedPaths?: Set<string>;
  optionalActivePaths?: Set<string>;
};

function resolveCommandSecretRefsCall(callIndex = 0): ResolveCommandSecretRefsCall {
  const call = hoisted.resolveCommandSecretRefsViaGatewayMock.mock.calls[callIndex]?.[0] as
    | ResolveCommandSecretRefsCall
    | undefined;
  if (!call) {
    throw new Error(`expected command secret resolution call ${callIndex}`);
  }
  return call;
}

describe("resolveQueuedReplyExecutionConfig channel scope", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    hoisted.resolveCommandSecretRefsViaGatewayMock
      .mockReset()
      .mockImplementation(async ({ config }) => ({
        resolvedConfig: config,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }));
    hoisted.getScopedChannelsCommandSecretTargetsMock.mockReset().mockReturnValue({
      targetIds: new Set(["channels.discord.token"]),
      allowedPaths: new Set(["channels.discord.token", "channels.discord.accounts.work.token"]),
    });
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshotState();
  });

  it("resolves base runtime targets, then active channel/account targets from originating context", async () => {
    const sourceConfig = { source: true } as unknown as OpenClawConfig;
    const baseResolved = { baseResolved: true } as unknown as OpenClawConfig;
    const scopedResolved = { scopedResolved: true } as unknown as OpenClawConfig;
    hoisted.resolveCommandSecretRefsViaGatewayMock
      .mockResolvedValueOnce({
        resolvedConfig: baseResolved,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      })
      .mockResolvedValueOnce({
        resolvedConfig: scopedResolved,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      });

    const resolved = await resolveQueuedReplyExecutionConfig(sourceConfig, {
      originatingChannel: "discord",
      messageProvider: "slack",
      originatingAccountId: "work",
      agentAccountId: "default",
    });

    expect(resolved).toBe(scopedResolved);
    expect(hoisted.resolveCommandSecretRefsViaGatewayMock).toHaveBeenCalledTimes(2);
    const baseCall = resolveCommandSecretRefsCall();
    expect(baseCall.config).toBe(sourceConfig);
    expect(baseCall.commandName).toBe("reply");
    expect(baseCall.targetIds).toEqual(new Set(["skills.entries.*.apiKey"]));
    expect(baseCall.optionalActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
    );
    expect(hoisted.getScopedChannelsCommandSecretTargetsMock).toHaveBeenCalledWith({
      config: baseResolved,
      channel: "discord",
      accountId: "work",
    });
    const scopedCall = resolveCommandSecretRefsCall(1);
    expect(scopedCall.config).toBe(baseResolved);
    expect(scopedCall.commandName).toBe("reply");
    expect(scopedCall.targetIds).toEqual(new Set(["channels.discord.token"]));
    expect(scopedCall.allowedPaths).toEqual(
      new Set(["channels.discord.token", "channels.discord.accounts.work.token"]),
    );
  });

  it("falls back to messageProvider and agentAccountId when originating values are missing", async () => {
    const sourceConfig = { source: true } as unknown as OpenClawConfig;

    await resolveQueuedReplyExecutionConfig(sourceConfig, {
      messageProvider: "discord",
      agentAccountId: "ops",
    });

    expect(hoisted.getScopedChannelsCommandSecretTargetsMock).toHaveBeenCalledWith({
      config: sourceConfig,
      channel: "discord",
      accountId: "ops",
    });
  });

  it("skips scoped channel resolution when no active channel can be resolved", async () => {
    const sourceConfig = { source: true } as unknown as OpenClawConfig;

    const resolved = await resolveQueuedReplyExecutionConfig(sourceConfig);

    expect(resolved).toBe(sourceConfig);
    expect(hoisted.resolveCommandSecretRefsViaGatewayMock).toHaveBeenCalledTimes(1);
    expect(hoisted.getScopedChannelsCommandSecretTargetsMock).not.toHaveBeenCalled();
  });

  it("prefers the runtime snapshot as the base config for secret resolution", async () => {
    const sourceConfig = { source: true } as unknown as OpenClawConfig;
    const runtimeConfig = { runtime: true } as unknown as OpenClawConfig;
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    hoisted.getScopedChannelsCommandSecretTargetsMock.mockReturnValue({
      targetIds: new Set<string>(),
    });

    await resolveQueuedReplyExecutionConfig(sourceConfig, {
      messageProvider: "discord",
    });

    const baseCall = resolveCommandSecretRefsCall();
    expect(baseCall.config).toBe(runtimeConfig);
    expect(baseCall.commandName).toBe("reply");
    expect(hoisted.getScopedChannelsCommandSecretTargetsMock).toHaveBeenCalledWith({
      config: runtimeConfig,
      channel: "discord",
      accountId: undefined,
    });
  });

  it("does not replace an already resolved run config with a stale runtime snapshot", () => {
    const sourceConfig = {
      models: {
        providers: {
          openai: {
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const staleRuntimeConfig = {
      models: {
        providers: {
          openai: {
            apiKey: "stale-runtime-key",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const scopedResolvedConfig = {
      models: {
        providers: {
          openai: {
            apiKey: "fresh-scoped-key",
            models: [],
          },
        },
      },
      tools: {
        updatePlan: true,
      },
    } as unknown as OpenClawConfig;
    setRuntimeConfigSnapshot(staleRuntimeConfig, sourceConfig);

    expect(resolveQueuedReplyRuntimeConfig(structuredClone(sourceConfig))).toBe(staleRuntimeConfig);
    expect(resolveQueuedReplyRuntimeConfig(scopedResolvedConfig)).toBe(scopedResolvedConfig);
  });

  function activateRuntime(sourceConfig: OpenClawConfig, config: OpenClawConfig) {
    activateSecretsRuntimeSnapshotState({
      snapshot: {
        sourceConfig,
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
    return resolveQueuedReplyRuntimeConfig(sourceConfig);
  }

  it("keeps queued replies on the activated SecretRef bytes without command-time resolution", async () => {
    const sourceConfig: OpenClawConfig = {
      skills: {
        entries: {
          example: { apiKey: { source: "env", provider: "default", id: "EXAMPLE_API_KEY" } },
        },
      },
    };
    const runtimeConfig = activateRuntime(sourceConfig, {
      skills: { entries: { example: { apiKey: "activated-key" } } },
    });
    hoisted.resolveCommandSecretRefsViaGatewayMock.mockResolvedValue({
      resolvedConfig: { skills: { entries: { example: { apiKey: "command-key" } } } },
    });

    // Healthy activated bytes leave no scoped channel targets to resolve.
    hoisted.getScopedChannelsCommandSecretTargetsMock.mockReturnValue({ targetIds: new Set() });
    for (const config of [sourceConfig, runtimeConfig, structuredClone(sourceConfig)]) {
      const resolved = await resolveQueuedReplyExecutionConfig(config, {
        originatingChannel: "discord",
      });
      expect(resolved).toBe(runtimeConfig);
      expect(JSON.stringify(resolved)).toBe(JSON.stringify(runtimeConfig));
    }
    expect(hoisted.resolveCommandSecretRefsViaGatewayMock).not.toHaveBeenCalled();
  });

  it("keeps cold channel-account resolution on the activated fast path", async () => {
    const sourceConfig: OpenClawConfig = {
      skills: {
        entries: {
          example: { apiKey: { source: "env", provider: "default", id: "EXAMPLE_API_KEY" } },
        },
      },
    };
    const runtimeConfig = activateRuntime(sourceConfig, {
      skills: { entries: { example: { apiKey: "activated-key" } } },
    });
    // A cold account still carries an unresolved scoped target; the activated
    // snapshot must not bypass the channel/account-scoped stage that rejects it.
    const scopedResolved = {
      ...runtimeConfig,
      channels: { discord: { accounts: { work: { token: "scoped-token" } } } },
    };
    hoisted.resolveCommandSecretRefsViaGatewayMock.mockResolvedValue({
      resolvedConfig: scopedResolved,
    });
    const resolved = await resolveQueuedReplyExecutionConfig(runtimeConfig, {
      originatingChannel: "discord",
      originatingAccountId: "work",
    });
    expect(resolved).toBe(scopedResolved);
    expect(hoisted.resolveCommandSecretRefsViaGatewayMock).toHaveBeenCalledTimes(1);
    expect(resolveCommandSecretRefsCall(0).config).toBe(runtimeConfig);
    expect(resolveCommandSecretRefsCall(0).targetIds).toEqual(new Set(["channels.discord.token"]));
  });

  it("adopts a new runtime generation for a previously queued config while preserving explicit overrides", async () => {
    const sourceConfig: OpenClawConfig = {
      skills: {
        entries: {
          example: { apiKey: { source: "env", provider: "default", id: "EXAMPLE_API_KEY" } },
        },
      },
    };
    const queuedConfig = activateRuntime(sourceConfig, {
      skills: { entries: { example: { apiKey: "first-key" } } },
    });
    const queuedSource = getRuntimeConfigSourceSnapshot()!;
    const changedSource: OpenClawConfig = {
      ...sourceConfig,
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
