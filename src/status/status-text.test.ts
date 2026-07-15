import { describe, expect, it } from "vitest";
import { buildStatusText } from "./status-text.js";

type StatusTextParams = Parameters<typeof buildStatusText>[0];

async function renderTelegramStatus(params: {
  cfg: StatusTextParams["cfg"];
  sessionEntry: NonNullable<StatusTextParams["sessionEntry"]>;
  statusAccountId?: string;
}): Promise<string> {
  return await buildStatusText({
    cfg: params.cfg,
    sessionEntry: params.sessionEntry,
    sessionKey: "agent:main:main",
    statusChannel: "telegram",
    ...(params.statusAccountId ? { statusAccountId: params.statusAccountId } : {}),
    provider: "openai",
    model: "gpt-5.4-mini",
    resolvedHarness: "pi",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    defaultGroupActivation: () => "mention",
    pluginHealthLineOverride: "Plugins: test",
    taskLineOverride: "",
    skipDefaultTaskLookup: true,
    primaryModelLabelOverride: "openai/gpt-5.4-mini",
    modelAuthOverride: "test",
    activeModelAuthOverride: "test",
    includeTranscriptUsage: false,
  });
}

describe("buildStatusText channel features", () => {
  it.each([
    { richMessages: undefined, expected: "Telegram rich messages: off" },
    { richMessages: false, expected: "Telegram rich messages: off" },
    { richMessages: true, expected: "Telegram rich messages: on" },
  ])("shows Telegram rich message state for %s", async ({ richMessages, expected }) => {
    const telegram = richMessages === undefined ? {} : { richMessages };
    const text = await renderTelegramStatus({
      cfg: { channels: { telegram } },
      sessionEntry: { sessionId: `telegram-rich-${String(richMessages)}`, updatedAt: 0 },
    });

    expect(text).toContain(expected);
    if (richMessages === true) {
      expect(text).toContain("sendRichMessage enabled");
    } else {
      expect(text).toContain("channels.telegram.richMessages=true");
    }
  });

  it("uses Telegram account rich message overrides", async () => {
    const text = await renderTelegramStatus({
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
    });

    expect(text).toContain("Telegram rich messages: off");
    expect(text).toContain("enable richMessages for this Telegram account");
  });

  it("uses the current Telegram command account before the session records it", async () => {
    const text = await renderTelegramStatus({
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
      statusAccountId: "work",
    });

    expect(text).toContain("Telegram rich messages: off");
    expect(text).toContain("enable richMessages for this Telegram account");
  });
});
