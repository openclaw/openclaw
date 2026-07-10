import { describe, expect, it, vi } from "vitest";
import { resolveStatusChannelFeatureLine } from "./status-text.js";
import type { BuildStatusTextParams } from "./status-text.types.js";

function minimalBuildStatusTextParams(
  overrides?: Partial<BuildStatusTextParams>,
): BuildStatusTextParams {
  return {
    cfg: {},
    sessionEntry: { sessionId: "retry-test", updatedAt: 0 },
    sessionKey: "agent:main:test",
    statusChannel: "mobilechat",
    provider: "anthropic",
    model: "claude-opus-4-5",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => "medium",
    isGroup: false,
    defaultGroupActivation: () => "mention",
    skipDefaultTaskLookup: true,
    ...overrides,
  };
}

describe("buildStatusText channel features", () => {
  it.each([
    { richMessages: undefined, expected: "Telegram rich messages: off" },
    { richMessages: false, expected: "Telegram rich messages: off" },
    { richMessages: true, expected: "Telegram rich messages: on" },
  ])("shows Telegram rich message state for %s", ({ richMessages, expected }) => {
    const telegram = richMessages === undefined ? {} : { richMessages };
    const text = resolveStatusChannelFeatureLine({
      cfg: { channels: { telegram } },
      sessionEntry: { sessionId: `telegram-rich-${String(richMessages)}`, updatedAt: 0 },
      statusChannel: "telegram",
    });

    expect(text).toContain(expected);
    if (richMessages === true) {
      expect(text).toContain("sendRichMessage enabled");
    } else {
      expect(text).toContain("channels.telegram.richMessages=true");
    }
  });

  it("uses Telegram account rich message overrides", () => {
    const text = resolveStatusChannelFeatureLine({
      cfg: {
        channels: {
          telegram: {
            richMessages: true,
            accounts: { Work: { richMessages: false } },
          },
        },
      },
      sessionEntry: {
        sessionId: "telegram-rich-account",
        updatedAt: 0,
        lastAccountId: "work",
      },
      statusChannel: "telegram",
    });

    expect(text).toContain("Telegram rich messages: off");
    expect(text).toContain("enable richMessages for this Telegram account");
  });

  it("uses the current Telegram command account before the session records it", () => {
    const text = resolveStatusChannelFeatureLine({
      cfg: {
        channels: {
          telegram: {
            richMessages: true,
            accounts: { Work: { richMessages: false } },
          },
        },
      },
      sessionEntry: {
        sessionId: "telegram-rich-command-account",
        updatedAt: 0,
      },
      statusChannel: "telegram",
      statusAccountId: "work",
    });

    expect(text).toContain("Telegram rich messages: off");
    expect(text).toContain("enable richMessages for this Telegram account");
  });
});

describe("buildStatusText dynamic loader retry cache", () => {
  it("falls back on import failure and retries in the same module instance", async () => {
    vi.doMock("./status-plugin-health.runtime.js", async () => {
      throw new Error("Module load failure");
    });
    vi.resetModules();
    const { buildStatusText: retryingBuildStatusText } = await import("./status-text.js");

    const failText = await retryingBuildStatusText(minimalBuildStatusTextParams());
    expect(failText).toContain("Plugins: health unavailable");

    vi.doMock("./status-plugin-health.runtime.js", () => ({
      collectInstalledPluginHealthSnapshot: async () => ({}),
      collectRuntimePluginHealthSnapshot: () => ({
        plugins: [],
        diagnostics: [],
        contextEngineQuarantines: [],
        runtimeToolQuarantines: [],
        channelPluginFailures: [],
      }),
    }));

    const successText = await retryingBuildStatusText(minimalBuildStatusTextParams());
    expect(successText).not.toContain("Plugins: health unavailable");
  });
});
