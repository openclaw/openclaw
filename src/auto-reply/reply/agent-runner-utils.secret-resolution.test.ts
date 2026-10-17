import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

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
const { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
  await import("../../config/config.js");

const secretResult = (resolvedConfig: OpenClawConfig) => ({
  resolvedConfig,
  diagnostics: [],
  targetStatesByPath: {},
  hadUnresolvedTargets: false,
});
const sourceConfig: OpenClawConfig = {};
function expectScope(config: OpenClawConfig, accountId?: string) {
  expect(hoisted.getScopedChannelsCommandSecretTargetsMock).toHaveBeenCalledWith({
    config,
    channel: "discord",
    accountId,
  });
}

describe("resolveQueuedReplyExecutionConfig channel scope", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    hoisted.resolveCommandSecretRefsViaGatewayMock
      .mockReset()
      .mockImplementation(async ({ config }) => secretResult(config));
    hoisted.getScopedChannelsCommandSecretTargetsMock.mockReset().mockReturnValue({
      targetIds: new Set(["channels.discord.token"]),
      allowedPaths: new Set(["channels.discord.token", "channels.discord.accounts.work.token"]),
    });
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("resolves base runtime targets, then active channel/account targets from originating context", async () => {
    const baseResolved: OpenClawConfig = { tools: { profile: "coding" } };
    const scopedResolved: OpenClawConfig = { tools: { profile: "full" } };
    hoisted.resolveCommandSecretRefsViaGatewayMock
      .mockResolvedValueOnce(secretResult(baseResolved))
      .mockResolvedValueOnce(secretResult(scopedResolved));

    const resolved = await resolveQueuedReplyExecutionConfig(sourceConfig, {
      originatingChannel: "discord",
      messageProvider: "slack",
      originatingAccountId: "work",
      agentAccountId: "default",
    });

    expect(resolved).toBe(scopedResolved);
    expect(hoisted.resolveCommandSecretRefsViaGatewayMock).toHaveBeenCalledTimes(2);
    expect(hoisted.resolveCommandSecretRefsViaGatewayMock.mock.calls[0]?.[0]).toEqual({
      config: sourceConfig,
      commandName: "reply",
      targetIds: new Set(["skills.entries.*.apiKey"]),
      optionalActivePaths: new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
    });
    expect(hoisted.resolveCommandSecretRefsViaGatewayMock.mock.calls[0]?.[0].config).toBe(
      sourceConfig,
    );
    expectScope(baseResolved, "work");
    expect(hoisted.resolveCommandSecretRefsViaGatewayMock.mock.calls[1]?.[0]).toEqual({
      config: baseResolved,
      commandName: "reply",
      targetIds: new Set(["channels.discord.token"]),
      allowedPaths: new Set(["channels.discord.token", "channels.discord.accounts.work.token"]),
    });
    expect(hoisted.resolveCommandSecretRefsViaGatewayMock.mock.calls[1]?.[0].config).toBe(
      baseResolved,
    );
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
    expect(hoisted.resolveCommandSecretRefsViaGatewayMock).toHaveBeenCalledTimes(1);
    expect(hoisted.getScopedChannelsCommandSecretTargetsMock).not.toHaveBeenCalled();
  });

  it("prefers the runtime snapshot as the base config for secret resolution", async () => {
    const runtimeConfig: OpenClawConfig = { tools: { profile: "coding" } };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    hoisted.getScopedChannelsCommandSecretTargetsMock.mockReturnValue({
      targetIds: new Set<string>(),
    });

    await resolveQueuedReplyExecutionConfig(sourceConfig, {
      messageProvider: "discord",
    });

    const baseCall = hoisted.resolveCommandSecretRefsViaGatewayMock.mock.calls[0]?.[0];
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
});
