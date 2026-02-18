import { beforeEach, describe, expect, it, vi } from "vitest";

const recordChannelActivity = vi.fn();
vi.mock("../../infra/channel-activity.js", () => ({
  recordChannelActivity: (...args: unknown[]) => recordChannelActivity(...args),
}));

import { createWebSendApi, injectMentionTokens, resolveMentionJids } from "./send-api.js";

describe("createWebSendApi", () => {
  const sendMessage = vi.fn(async () => ({ key: { id: "msg-1" } }));
  const sendPresenceUpdate = vi.fn(async () => {});
  const api = createWebSendApi({
    sock: { sendMessage, sendPresenceUpdate },
    defaultAccountId: "main",
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses sendOptions fileName for outbound documents", async () => {
    const payload = Buffer.from("pdf");
    await api.sendMessage("+1555", "doc", payload, "application/pdf", { fileName: "invoice.pdf" });
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        document: payload,
        fileName: "invoice.pdf",
        caption: "doc",
        mimetype: "application/pdf",
      }),
    );
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("falls back to default document filename when fileName is absent", async () => {
    const payload = Buffer.from("pdf");
    await api.sendMessage("+1555", "doc", payload, "application/pdf");
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        document: payload,
        fileName: "file",
        caption: "doc",
        mimetype: "application/pdf",
      }),
    );
  });

  it("sends plain text messages", async () => {
    await api.sendMessage("+1555", "hello");
    expect(sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", { text: "hello" });
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("supports image media with caption", async () => {
    const payload = Buffer.from("img");
    await api.sendMessage("+1555", "cap", payload, "image/jpeg");
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        image: payload,
        caption: "cap",
        mimetype: "image/jpeg",
      }),
    );
  });

  it("supports audio as push-to-talk voice note", async () => {
    const payload = Buffer.from("aud");
    await api.sendMessage("+1555", "", payload, "audio/ogg", { accountId: "alt" });
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        audio: payload,
        ptt: true,
        mimetype: "audio/ogg",
      }),
    );
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "alt",
      direction: "outbound",
    });
  });

  it("supports video media and gifPlayback option", async () => {
    const payload = Buffer.from("vid");
    await api.sendMessage("+1555", "cap", payload, "video/mp4", { gifPlayback: true });
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        video: payload,
        caption: "cap",
        mimetype: "video/mp4",
        gifPlayback: true,
      }),
    );
  });

  it("falls back to unknown messageId if Baileys result does not expose key.id", async () => {
    sendMessage.mockResolvedValueOnce({ key: {} as { id: string } });
    const res = await api.sendMessage("+1555", "hello");
    expect(res.messageId).toBe("unknown");
  });

  it("sends polls and records outbound activity", async () => {
    const res = await api.sendPoll("+1555", {
      question: "Q?",
      options: ["a", "b"],
      maxSelections: 2,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        poll: { name: "Q?", values: ["a", "b"], selectableCount: 2 },
      }),
    );
    expect(res.messageId).toBe("msg-1");
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("sends reactions with participant JID normalization", async () => {
    await api.sendReaction("+1555", "msg-2", "👍", false, "+1999");
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        react: {
          text: "👍",
          key: expect.objectContaining({
            remoteJid: "1555@s.whatsapp.net",
            id: "msg-2",
            fromMe: false,
            participant: "1999@s.whatsapp.net",
          }),
        },
      }),
    );
  });

  it("sends composing presence updates to the recipient JID", async () => {
    await api.sendComposingTo("+1555");
    expect(sendPresenceUpdate).toHaveBeenCalledWith("composing", "1555@s.whatsapp.net");
  });

  it("keeps phone-number mention payloads even when lid mapping exists", async () => {
    const mentions = await resolveMentionJids("@14155550111 done", {
      lidLookup: {
        getLIDForPN: async () => "199999999999999@lid",
        getPNForLID: async () => "14155550111@s.whatsapp.net",
      },
    });
    expect(mentions).toEqual(["14155550111@s.whatsapp.net"]);
  });

  it("prefers phone-number jid for name mentions when participant phone is known", async () => {
    const mentions = await resolveMentionJids("@Alice done", {
      participants: [
        {
          jid: "199999999999999@lid",
          name: "Alice Doe",
          phoneNumber: "+14155550111",
        },
      ],
      lidLookup: {
        getPNForLID: async () => "14155550111@s.whatsapp.net",
      },
    });
    expect(mentions).toEqual(["14155550111@s.whatsapp.net"]);
  });

  it("resolves @Name mentions via participants provider when sending text", async () => {
    const sendMessageWithParticipants = vi.fn(async () => ({ key: { id: "msg-2" } }));
    const apiWithParticipants = createWebSendApi({
      sock: { sendMessage: sendMessageWithParticipants, sendPresenceUpdate },
      defaultAccountId: "main",
      getParticipants: async (jid) =>
        jid === "1555@s.whatsapp.net"
          ? [
              {
                jid: "199999999999999@lid",
                name: "Alice Doe",
                phoneNumber: "+14155550111",
              },
            ]
          : [],
    });

    await apiWithParticipants.sendMessage("+1555", "@Alice can you check this?");

    expect(sendMessageWithParticipants).toHaveBeenCalledWith("1555@s.whatsapp.net", {
      text: "@14155550111 can you check this?",
      mentions: ["14155550111@s.whatsapp.net"],
    });
  });

  it("resolves self alias mentions without participants", async () => {
    const mentions = await resolveMentionJids("@OpenClaw check this", {
      selfMentionJid: "14155550333:2@s.whatsapp.net",
      selfMentionAliases: ["openclaw", "bot"],
    });
    expect(mentions).toEqual(["14155550333@s.whatsapp.net"]);
  });

  it("sends self mention payload when text includes self alias", async () => {
    const sendMessageWithSelf = vi.fn(async () => ({ key: { id: "msg-self" } }));
    const apiWithSelf = createWebSendApi({
      sock: { sendMessage: sendMessageWithSelf, sendPresenceUpdate },
      defaultAccountId: "main",
      selfMentionJid: "14155550333:2@s.whatsapp.net",
      selfMentionAliases: ["openclaw", "bot"],
    });

    await apiWithSelf.sendMessage("+1555", "@OpenClaw check this");

    expect(sendMessageWithSelf).toHaveBeenCalledWith("1555@s.whatsapp.net", {
      text: "@14155550333 check this",
      mentions: ["14155550333@s.whatsapp.net"],
    });
  });

  it("does not append duplicate self token when self name comes from participants", () => {
    const text = "@HelperBot check this";
    const mentionJids = ["14155550333@s.whatsapp.net"];
    const outgoing = injectMentionTokens(
      text,
      mentionJids,
      [{ jid: "14155550333@s.whatsapp.net", name: "HelperBot" }],
      {
        selfMentionJid: "14155550333@s.whatsapp.net",
        selfMentionAliases: ["bot"],
      },
    );
    expect(outgoing).toBe("@14155550333 check this");
  });

  it("canonicalizes existing name mentions in-place without adding duplicate line", () => {
    const text = "@Alice Example @Bob joke time";
    const mentionJids = ["14155550111@s.whatsapp.net", "14155550222@s.whatsapp.net"];
    const outgoing = injectMentionTokens(text, mentionJids, [
      { jid: "14155550111@s.whatsapp.net", name: "Alice Example" },
      { jid: "14155550222@s.whatsapp.net", name: "Bob Example" },
    ]);
    expect(outgoing).toBe("@14155550111 @14155550222 joke time");
  });

  it("canonicalizes multi-word alias hints with variable spaces", () => {
    const text = "@Alice   Example @Bob done bhai ✅";
    const mentionJids = ["14155550111@s.whatsapp.net", "14155550222@s.whatsapp.net"];
    const outgoing = injectMentionTokens(text, mentionJids, undefined, {
      mentionAliasHintsByUser: new Map<string, string[]>([
        ["14155550111", ["Alice Example"]],
        ["14155550222", ["Bob"]],
      ]),
    });
    expect(outgoing).toBe("@14155550111 @14155550222 done bhai ✅");
  });

  it("resolves bare lid-like tokens via lid mapping lookup", async () => {
    const mentions = await resolveMentionJids("@199999999999999 done", {
      lidLookup: {
        getPNForLID: async (jid) =>
          jid === "199999999999999@lid" ? "14155550111@s.whatsapp.net" : null,
      },
    });
    expect(mentions).toEqual(["14155550111@s.whatsapp.net"]);
  });

  it("appends canonical numeric mention tokens when mentions are missing", () => {
    const text = "roll call done 😎";
    const mentionJids = [
      "14155550111@s.whatsapp.net",
      "14155550222@s.whatsapp.net",
      "14155550333@s.whatsapp.net",
    ];
    const outgoing = injectMentionTokens(text, mentionJids, [
      { jid: "14155550111@s.whatsapp.net", name: "Alice Example" },
      { jid: "14155550222@s.whatsapp.net", name: "Bob Example" },
      { jid: "14155550333@s.whatsapp.net", name: "OpenClaw Bot" },
    ]);
    expect(outgoing).toBe("roll call done 😎\n@14155550111 @14155550222 @14155550333");
  });

  it("keeps natural text and appends canonical tokens for clickable mentions", () => {
    const text = "@Alice Example @Bob Example @OpenClaw Bot roll call done 😎";
    const mentionJids = [
      "14155550111@s.whatsapp.net",
      "14155550222@s.whatsapp.net",
      "14155550333@s.whatsapp.net",
    ];
    const outgoing = injectMentionTokens(text, mentionJids, [
      { jid: "14155550111@s.whatsapp.net", name: "Alice Example" },
      { jid: "14155550222@s.whatsapp.net", name: "Bob Example" },
      { jid: "14155550333@s.whatsapp.net", name: "OpenClaw Bot" },
    ]);
    expect(outgoing).toBe("@14155550111 @14155550222 @14155550333 roll call done 😎");
  });

  it("normalizes +prefixed numeric tokens to canonical mention tokens", () => {
    const text = "@Alice Example @+14155550222 joke time";
    const mentionJids = ["14155550111@s.whatsapp.net", "14155550222@s.whatsapp.net"];
    const outgoing = injectMentionTokens(text, mentionJids, [
      { jid: "14155550111@s.whatsapp.net", name: "Alice Example" },
      { jid: "14155550222@s.whatsapp.net", name: "Bob Example" },
    ]);
    expect(outgoing).toBe("@14155550111 @14155550222 joke time");
  });

  it("keeps existing numeric mention tokens unchanged", () => {
    const text = "@14155550111 @14155550222 @14155550333 roll call done 😎";
    const mentionJids = [
      "14155550111@s.whatsapp.net",
      "14155550222@s.whatsapp.net",
      "14155550333@s.whatsapp.net",
    ];
    const outgoing = injectMentionTokens(text, mentionJids, [
      { jid: "14155550111@s.whatsapp.net", name: "Alice Example" },
      { jid: "14155550222@s.whatsapp.net", name: "Bob Example" },
      { jid: "14155550333@s.whatsapp.net", name: "OpenClaw Bot" },
    ]);
    expect(outgoing).toBe(text);
  });
});
