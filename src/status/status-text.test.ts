import { describe, expect, it } from "vitest";
import { buildStatusText } from "./status-text.js";

describe("buildStatusText error recovery", () => {
  it("returns a string (not throws) even when invoked without optional session data", async () => {
    // Issue #94626: buildStatusText must never throw, even when lazy dynamic
    // imports or runtime data collection encounter errors. This smoke test
    // exercises the function with minimal params — the try-catch wrapper
    // ensures any internal failure returns a degraded status message.
    const result = await buildStatusText({
      cfg: {},
      sessionEntry: { sessionId: "test-error-recovery", updatedAt: 0 },
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

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("does not throw when called without a sessionKey", async () => {
    // Session-less status (e.g. agent-level status) must also be protected
    // by the error boundary.
    const result = await buildStatusText({
      cfg: {},
      statusChannel: "mobilechat",
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

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

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
