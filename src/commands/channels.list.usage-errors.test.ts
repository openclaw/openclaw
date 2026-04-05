import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { configMocks } from "./channels.mock-harness.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const authMocks = vi.hoisted(() => ({
  loadAuthProfileStore: vi.fn(),
}));

const usageMocks = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn(),
  formatUsageReportLines: vi.fn(),
}));

const secretMocks = vi.hoisted(() => ({
  resolveCommandSecretRefsViaGateway: vi.fn(),
}));

vi.mock("../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/auth-profiles.js")>();
  return {
    ...actual,
    loadAuthProfileStore: authMocks.loadAuthProfileStore,
  };
});

vi.mock("../infra/provider-usage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/provider-usage.js")>();
  return {
    ...actual,
    loadProviderUsageSummary: usageMocks.loadProviderUsageSummary,
    formatUsageReportLines: usageMocks.formatUsageReportLines,
  };
});

vi.mock("../cli/command-secret-gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/command-secret-gateway.js")>();
  return {
    ...actual,
    resolveCommandSecretRefsViaGateway: secretMocks.resolveCommandSecretRefsViaGateway,
  };
});

import { channelsListCommand } from "./channels.js";

function createChannelsListTestPlugin(): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: "discord",
      label: "Discord",
      docsPath: "/channels/discord",
    }),
    config: {
      listAccountIds: () => ["default"],
      defaultAccountId: () => "default",
      resolveAccount: () => ({
        name: "Primary",
        configured: true,
        enabled: true,
        tokenSource: "config",
      }),
      isConfigured: () => true,
      isEnabled: () => true,
    },
  } as ChannelPlugin;
}

describe("channelsListCommand usage snapshot failures", () => {
  const runtime = createTestRuntime();

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          plugin: createChannelsListTestPlugin(),
          source: "test",
        },
      ]),
    );
    runtime.log.mockReset();
    runtime.error.mockReset();
    runtime.exit.mockReset();
    configMocks.readConfigFileSnapshot.mockResolvedValue(baseConfigSnapshot);
    authMocks.loadAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });
    usageMocks.formatUsageReportLines.mockReturnValue(["Usage summary", "Claude: 12 requests"]);
    usageMocks.loadProviderUsageSummary.mockReset();
    secretMocks.resolveCommandSecretRefsViaGateway.mockReset();
    secretMocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: baseConfigSnapshot.config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    });
  });

  afterAll(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("renders usage output when the usage snapshot loads successfully", async () => {
    usageMocks.loadProviderUsageSummary.mockResolvedValue({ providers: [] });

    await channelsListCommand({}, runtime);

    const joined = runtime.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(joined).toContain("Chat channels:");
    expect(joined).toContain("Discord");
    expect(joined).toContain("Usage summary");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("shows actionable Claude guidance for known scope failures", async () => {
    usageMocks.loadProviderUsageSummary.mockRejectedValue(
      new Error("Claude: HTTP 403 forbidden for /api/organizations user:profile"),
    );

    await channelsListCommand({}, runtime);

    const joined = runtime.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(joined).toContain("Chat channels:");
    expect(joined).toContain("Discord");
    expect(joined).toContain("Usage snapshot unavailable for Claude.");
    expect(joined).toContain("user:profile");
    expect(joined).toContain("openclaw channels list --no-usage");
    expect(joined).toContain("CLAUDE_WEB_SESSION_KEY / CLAUDE_WEB_COOKIE");
    expect(joined).not.toContain("Error: Claude: HTTP 403 forbidden");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("shows a generic warning and preserves main output for unknown usage failures", async () => {
    usageMocks.loadProviderUsageSummary.mockRejectedValue(new Error("socket hang up"));

    await channelsListCommand({}, runtime);

    const joined = runtime.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(joined).toContain("Chat channels:");
    expect(joined).toContain("Discord");
    expect(joined).toContain("Usage snapshot unavailable.");
    expect(joined).toContain("The channel and auth summary above is still valid.");
    expect(joined).toContain("Error: socket hang up");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("skips usage loading entirely when usage is disabled", async () => {
    await channelsListCommand({ usage: false }, runtime);

    expect(usageMocks.loadProviderUsageSummary).not.toHaveBeenCalled();
    const joined = runtime.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(joined).toContain("Chat channels:");
    expect(joined).not.toContain("Usage summary");
    expect(joined).not.toContain("Usage snapshot unavailable");
  });
});
