import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindRequesterProfile } from "../requester-profile.js";
import type { MsgContext } from "../templating.js";
import { prepareReplyMessageLocale } from "./message-locale.js";

const { readPreferences } = vi.hoisted(() => ({ readPreferences: vi.fn() }));
vi.mock("../../state/user-preferences.js", () => ({
  getCanonicalUserPreferences: readPreferences,
}));

function direct(): MsgContext {
  const ctx: MsgContext = {
    ChatType: "direct",
    Provider: "whatsapp",
    SenderId: "sender",
    ChannelMessageLocale: "de",
  };
  bindRequesterProfile(ctx, { id: "person", displayName: null, isCurrent: () => true });
  return ctx;
}

beforeEach(() => {
  readPreferences.mockReset();
});
describe("request message language", () => {
  it("honors the verified person's choice and freezes it for this turn", async () => {
    readPreferences.mockResolvedValue({ entries: { "messages.locale": "en" } });
    const ctx = direct();
    await prepareReplyMessageLocale(ctx, { messages: { locale: "de" } });
    expect(ctx.MessageLocale).toBe("en");
    readPreferences.mockResolvedValue({ entries: { "messages.locale": "de" } });
    await prepareReplyMessageLocale(ctx, { messages: { locale: "de" } });
    expect(ctx.MessageLocale).toBe("en");
    expect(readPreferences).toHaveBeenCalledTimes(1);
    const next = direct();
    await prepareReplyMessageLocale(next, {});
    expect(next.MessageLocale).toBe("de");
  });

  it.each(["group", "channel", " GROUP "])(
    "uses the channel setting for %s even when the sender has a preference",
    async (chatType) => {
      const ctx = direct();
      ctx.ChatType = chatType;
      ctx.ClientLocale = "en";
      await prepareReplyMessageLocale(ctx, { messages: { locale: "en" } });
      expect(ctx.MessageLocale).toBe("de");
      expect(readPreferences).not.toHaveBeenCalled();
    },
  );

  it("does not trust profile-like fields copied from a message", async () => {
    const ctx: MsgContext = {
      ...structuredClone(direct()),
      ChannelMessageLocale: undefined,
    };
    await prepareReplyMessageLocale(ctx, {});
    expect(ctx.MessageLocale).toBe("en");
    expect(readPreferences).not.toHaveBeenCalled();
  });

  it.each([
    [{ ClientLocale: "de-DE", ChannelMessageLocale: "en" }, "de"],
    [{ ClientLocale: "fr-FR", ChannelMessageLocale: "de" }, "en"],
    [{ ChannelMessageLocale: "de" }, "de"],
    [{}, "en"],
  ] as const)(
    "resolves client and channel hints with English fallback: %j",
    async (input, expected) => {
      const ctx: MsgContext = { ...input, ChatType: "direct" };
      await prepareReplyMessageLocale(ctx, {});
      expect(ctx.MessageLocale).toBe(expected);
    },
  );

  it("still replies using channel defaults when the preference store is unavailable", async () => {
    readPreferences.mockRejectedValue(new Error("unavailable"));
    const ctx = direct();
    await prepareReplyMessageLocale(ctx, {});
    expect(ctx.MessageLocale).toBe("de");
  });

  it("keeps simultaneous requests isolated and honors the global default", async () => {
    const german: MsgContext = {};
    const english: MsgContext = { ClientLocale: "en-GB" };
    await Promise.all([
      prepareReplyMessageLocale(german, { messages: { locale: "de" } }),
      prepareReplyMessageLocale(english, { messages: { locale: "de" } }),
    ]);
    expect([german.MessageLocale, english.MessageLocale]).toEqual(["de", "en"]);
  });
});
