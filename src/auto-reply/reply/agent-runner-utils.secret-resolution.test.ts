import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const { resolveSecrets, scopedTargets } = vi.hoisted(() => ({
  resolveSecrets: vi.fn(),
  scopedTargets: vi.fn(),
}));

// mock-isolation: Resolve synthetic secrets without contacting a Gateway.
vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: resolveSecrets,
}));

// mock-isolation: Supply fixed target inventories without loading channel or plugin registries.
vi.mock("../../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: () => new Set(["skills.entries.*.apiKey"]),
  getAgentRuntimeOptionalCommandSecretPaths: () =>
    new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
  getScopedChannelsCommandSecretTargets: scopedTargets,
}));

const { resolveQueuedReplyExecutionConfig } = await import("./agent-runner-utils.js");
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
  expect(scopedTargets).toHaveBeenCalledWith({ config, channel: "discord", accountId });
}

beforeEach(() => {
  clearRuntimeConfigSnapshot();
  resolveSecrets.mockReset().mockImplementation(async ({ config }) => secretResult(config));
  scopedTargets.mockReset().mockReturnValue({
    targetIds: new Set(["channels.discord.token"]),
    allowedPaths: new Set(["channels.discord.token", "channels.discord.accounts.work.token"]),
  });
});

afterEach(clearRuntimeConfigSnapshot);

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
  expect(resolveSecrets.mock.calls[0]?.[0]).toMatchObject({
    config: sourceConfig,
    targetIds: new Set(["skills.entries.*.apiKey"]),
    optionalActivePaths: new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
  });
  expectScope(baseResolved, "work");
  expect(resolveSecrets).toHaveBeenNthCalledWith(2, {
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
