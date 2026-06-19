import { describe, expect, it, vi } from "vitest";
import { buildStatusText } from "./status-text.js";

function minimalBuildStatusTextParams(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
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
  } as any;
}

describe("buildStatusText channel features", () => {
  it.each([
    { richMessages: undefined, expected: "Telegram rich messages: off" },
    { richMessages: false, expected: "Telegram rich messages: off" },
    { richMessages: true, expected: "Telegram rich messages: on" },
  ])("shows Telegram rich message state for %s", async ({ richMessages, expected }) => {
    const telegram = richMessages === undefined ? {} : { richMessages };
    const text = await buildStatusText({
      cfg: { channels: { telegram } },
      sessionEntry: { sessionId: `telegram-rich-${String(richMessages)}`, updatedAt: 0 },
      sessionKey: "agent:main:telegram:direct:584667058",
      statusChannel: "telegram",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => "medium",
      isGroup: false,
      defaultGroupActivation: () => "mention",
      taskLineOverride: undefined,
      pluginHealthLineOverride: undefined,
      skipDefaultTaskLookup: true,
    });

    expect(text).toContain(expected);
    if (richMessages === true) {
      expect(text).toContain("sendRichMessage enabled");
    } else {
      expect(text).toContain("channels.telegram.richMessages=true");
    }
  });

  it("uses Telegram account rich message overrides", async () => {
    const text = await buildStatusText({
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
      sessionKey: "agent:main:telegram:work:direct:584667058",
      statusChannel: "telegram",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => "medium",
      isGroup: false,
      defaultGroupActivation: () => "mention",
      taskLineOverride: undefined,
      pluginHealthLineOverride: undefined,
      skipDefaultTaskLookup: true,
    });

    expect(text).toContain("Telegram rich messages: off");
    expect(text).toContain("enable richMessages for this Telegram account");
  });

  describe("dynamic loader retry pattern (??=)", () => {
    it("falls back on import failure and succeeds when module becomes available", async () => {
      // Phase 1: dynamic import fails → loader catch handler runs → returns fallback
      vi.doMock("./status-plugin-health.runtime.js", async () => {
        throw new Error("Module load failure");
      });
      vi.resetModules();
      const { buildStatusText: failBst } = await import("./status-text.js");
      const failText = await failBst(minimalBuildStatusTextParams());
      expect(failText).toContain("Plugins: health unavailable");

      // Phase 2: dynamic import succeeds → loader resolves with module → clean health line
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
      vi.resetModules();
      const { buildStatusText: successBst } = await import("./status-text.js");
      const successText = await successBst(minimalBuildStatusTextParams());
      expect(successText).toContain("Plugins: OK");
    });
  });

  it("uses the current Telegram command account before the session records it", async () => {
    const text = await buildStatusText({
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
      sessionKey: "agent:main:telegram:work:direct:584667058",
      statusChannel: "telegram",
      statusAccountId: "work",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => "medium",
      isGroup: false,
      defaultGroupActivation: () => "mention",
      taskLineOverride: undefined,
      pluginHealthLineOverride: undefined,
      skipDefaultTaskLookup: true,
    });

    expect(text).toContain("Telegram rich messages: off");
    expect(text).toContain("enable richMessages for this Telegram account");
  });
});
