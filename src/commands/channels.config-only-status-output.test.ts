import { afterEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { makeDirectPlugin } from "../test-utils/channel-plugin-test-fixtures.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { formatConfigChannelsStatusLines } from "./channels/status.js";

function makeUnavailableTokenPlugin(): ChannelPlugin {
  return makeDirectPlugin({
    id: "token-only",
    label: "TokenOnly",
    docsPath: "/channels/token-only",
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      resolveAccount: () => ({
        name: "Primary",
        enabled: true,
        configured: true,
        token: "",
        tokenSource: "config",
        tokenStatus: "configured_unavailable",
      }),
      isConfigured: () => true,
      isEnabled: () => true,
    },
  });
}

function makeResolvedTokenPlugin(): ChannelPlugin {
  return makeDirectPlugin({
    id: "token-only",
    label: "TokenOnly",
    docsPath: "/channels/token-only",
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      inspectAccount: (cfg) =>
        (cfg as { secretResolved?: boolean }).secretResolved
          ? {
              accountId: "primary",
              name: "Primary",
              enabled: true,
              configured: true,
              token: "resolved-token",
              tokenSource: "config",
              tokenStatus: "available",
            }
          : {
              accountId: "primary",
              name: "Primary",
              enabled: true,
              configured: true,
              token: "",
              tokenSource: "config",
              tokenStatus: "configured_unavailable",
            },
      resolveAccount: () => ({
        name: "Primary",
        enabled: true,
        configured: true,
        token: "",
        tokenSource: "config",
        tokenStatus: "configured_unavailable",
      }),
      isConfigured: () => true,
      isEnabled: () => true,
    },
  });
}

function makeResolvedTokenPluginWithoutInspectAccount(): ChannelPlugin {
  return {
    id: "token-only",
    meta: {
      id: "token-only",
      label: "TokenOnly",
      selectionLabel: "TokenOnly",
      docsPath: "/channels/token-only",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      resolveAccount: (cfg) => {
        if (!(cfg as { secretResolved?: boolean }).secretResolved) {
          throw new Error("raw SecretRef reached resolveAccount");
        }
        return {
          name: "Primary",
          enabled: true,
          configured: true,
          token: "resolved-token",
          tokenSource: "config",
          tokenStatus: "available",
        };
      },
      isConfigured: () => true,
      isEnabled: () => true,
    },
    actions: {
      listActions: () => ["send"],
    },
  };
}

function makeUnavailableHttpSlackPlugin(): ChannelPlugin {
  return makeDirectPlugin({
    id: "slack",
    label: "Slack",
    docsPath: "/channels/slack",
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      inspectAccount: () => ({
        accountId: "primary",
        name: "Primary",
        enabled: true,
        configured: true,
        mode: "http",
        botToken: "resolved-bot",
        botTokenSource: "config",
        botTokenStatus: "available",
        signingSecret: "",
        signingSecretSource: "config",
        signingSecretStatus: "configured_unavailable",
      }),
      resolveAccount: () => ({
        name: "Primary",
        enabled: true,
        configured: true,
      }),
      isConfigured: () => true,
      isEnabled: () => true,
    },
  });
}

function expectResolvedTokenStatusSummary(
  summary: string,
  options?: { includeUnavailableTokenLine?: boolean },
) {
  expect(summary).toContain("TokenOnly");
  expect(summary).toContain("configured");
  expect(summary).toContain("token:config");
  expect(summary).not.toContain("secret unavailable in this command path");
  if (options?.includeUnavailableTokenLine === false) {
    expect(summary).not.toContain("token:config (unavailable)");
  }
}

describe("config-only channels status output", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("shows configured-but-unavailable credentials distinctly from not configured", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "token-only",
          source: "test",
          plugin: makeUnavailableTokenPlugin(),
        },
      ]),
    );

    const lines = await formatConfigChannelsStatusLines({ channels: {} } as never, {
      mode: "local",
    });

    const joined = lines.join("\n");
    expect(joined).toContain("TokenOnly");
    expect(joined).toContain("configured, secret unavailable in this command path");
    expect(joined).toContain("token:config (unavailable)");
  });

  it("prefers resolved config snapshots when command-local secret resolution succeeds", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "token-only",
          source: "test",
          plugin: makeResolvedTokenPlugin(),
        },
      ]),
    );

    const lines = await formatConfigChannelsStatusLines(
      { secretResolved: true, channels: {} } as never,
      {
        mode: "local",
      },
      {
        sourceConfig: { channels: {} } as never,
      },
    );

    const joined = lines.join("\n");
    expectResolvedTokenStatusSummary(joined, { includeUnavailableTokenLine: false });
  });

  it("does not resolve raw source config for extension channels without inspectAccount", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "token-only",
          source: "test",
          plugin: makeResolvedTokenPluginWithoutInspectAccount(),
        },
      ]),
    );

    const lines = await formatConfigChannelsStatusLines(
      { secretResolved: true, channels: {} } as never,
      {
        mode: "local",
      },
      {
        sourceConfig: { channels: {} } as never,
      },
    );

    const joined = lines.join("\n");
    expectResolvedTokenStatusSummary(joined);
  });

  it("renders Slack HTTP signing-secret availability in config-only status", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: makeUnavailableHttpSlackPlugin(),
        },
      ]),
    );

    const lines = await formatConfigChannelsStatusLines({ channels: {} } as never, {
      mode: "local",
    });

    const joined = lines.join("\n");
    expect(joined).toContain("Slack");
    expect(joined).toContain("configured, secret unavailable in this command path");
    expect(joined).toContain("mode:http");
    expect(joined).toContain("bot:config");
    expect(joined).toContain("signing:config (unavailable)");
  });
});
