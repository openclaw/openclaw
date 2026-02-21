import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { resolveConversationLabel } from "./conversation-label.js";
import {
  formatChannelSelectionLine,
  listChatChannels,
  normalizeChatChannelId,
} from "./registry.js";
import { buildMessagingTarget, ensureTargetId, requireTargetKind } from "./targets.js";
import { createTypingCallbacks } from "./typing.js";

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("channel registry helpers", () => {
  it("normalizes aliases + trims whitespace", () => {
    expect(normalizeChatChannelId(" imsg ")).toBe("imessage");
    expect(normalizeChatChannelId("gchat")).toBe("googlechat");
    expect(normalizeChatChannelId("google-chat")).toBe("googlechat");
    expect(normalizeChatChannelId("internet-relay-chat")).toBe("irc");
    expect(normalizeChatChannelId("telegram")).toBe("telegram");
    expect(normalizeChatChannelId("web")).toBeNull();
    expect(normalizeChatChannelId("nope")).toBeNull();
  });

  it("keeps Telegram first in the default order", () => {
    const channels = listChatChannels();
    expect(channels[0]?.id).toBe("telegram");
  });

  it("does not include MS Teams by default", () => {
    const channels = listChatChannels();
    expect(channels.some((channel) => channel.id === "msteams")).toBe(false);
  });

  it("formats selection lines with docs labels + website extras", () => {
    const channels = listChatChannels();
    const first = channels[0];
    if (!first) {
      throw new Error("Missing channel metadata.");
    }
    const line = formatChannelSelectionLine(first, (path, label) =>
      [label, path].filter(Boolean).join(":"),
    );
    expect(line).not.toContain("Docs:");
    expect(line).toContain("/channels/telegram");
    expect(line).toContain("https://openclaw.ai");
  });
});

describe("channel targets", () => {
  it("ensureTargetId returns the candidate when it matches", () => {
    expect(
      ensureTargetId({
        candidate: "U123",
        pattern: /^[A-Z0-9]+$/i,
        errorMessage: "bad",
      }),
    ).toBe("U123");
  });

  it("ensureTargetId throws with the provided message on mismatch", () => {
    expect(() =>
      ensureTargetId({
        candidate: "not-ok",
        pattern: /^[A-Z0-9]+$/i,
        errorMessage: "Bad target",
      }),
    ).toThrow(/Bad target/);
  });

  it("requireTargetKind returns the target id when the kind matches", () => {
    const target = buildMessagingTarget("channel", "C123", "C123");
    expect(requireTargetKind({ platform: "Slack", target, kind: "channel" })).toBe("C123");
  });

  it("requireTargetKind throws when the kind is missing or mismatched", () => {
    expect(() =>
      requireTargetKind({ platform: "Slack", target: undefined, kind: "channel" }),
    ).toThrow(/Slack channel id is required/);
    const target = buildMessagingTarget("user", "U123", "U123");
    expect(() => requireTargetKind({ platform: "Slack", target, kind: "channel" })).toThrow(
      /Slack channel id is required/,
    );
  });
});

describe("resolveConversationLabel", () => {
  it("prefers ConversationLabel when present", () => {
    const ctx: MsgContext = { ConversationLabel: "Pinned Label", ChatType: "group" };
    expect(resolveConversationLabel(ctx)).toBe("Pinned Label");
  });

  it("prefers ThreadLabel over derived chat labels", () => {
    const ctx: MsgContext = {
      ThreadLabel: "Thread Alpha",
      ChatType: "group",
      GroupSubject: "Ops",
      From: "telegram:group:42",
    };
    expect(resolveConversationLabel(ctx)).toBe("Thread Alpha");
  });

  it("uses SenderName for direct chats when available", () => {
    const ctx: MsgContext = { ChatType: "direct", SenderName: "Ada", From: "telegram:99" };
    expect(resolveConversationLabel(ctx)).toBe("Ada");
  });

  it("falls back to From for direct chats when SenderName is missing", () => {
    const ctx: MsgContext = { ChatType: "direct", From: "telegram:99" };
    expect(resolveConversationLabel(ctx)).toBe("telegram:99");
  });

  it("derives Telegram-like group labels with numeric id suffix", () => {
    const ctx: MsgContext = { ChatType: "group", GroupSubject: "Ops", From: "telegram:group:42" };
    expect(resolveConversationLabel(ctx)).toBe("Ops id:42");
  });

  it("does not append ids for #rooms/channels", () => {
    const ctx: MsgContext = {
      ChatType: "channel",
      GroupSubject: "#general",
      From: "slack:channel:C123",
    };
    expect(resolveConversationLabel(ctx)).toBe("#general");
  });

  it("does not append ids when the base already contains the id", () => {
    const ctx: MsgContext = {
      ChatType: "group",
      GroupSubject: "Family id:123@g.us",
      From: "whatsapp:group:123@g.us",
    };
    expect(resolveConversationLabel(ctx)).toBe("Family id:123@g.us");
  });

  it("appends ids for WhatsApp-like group ids when a subject exists", () => {
    const ctx: MsgContext = {
      ChatType: "group",
      GroupSubject: "Family",
      From: "whatsapp:group:123@g.us",
    };
    expect(resolveConversationLabel(ctx)).toBe("Family id:123@g.us");
  });
});

describe("createTypingCallbacks", () => {
  it("invokes start on reply start", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const onStartError = vi.fn();
    const callbacks = createTypingCallbacks({ start, onStartError });

    await callbacks.onReplyStart();

    expect(start).toHaveBeenCalledTimes(1);
    expect(onStartError).not.toHaveBeenCalled();
  });

  it("reports start errors", async () => {
    const start = vi.fn().mockRejectedValue(new Error("fail"));
    const onStartError = vi.fn();
    const callbacks = createTypingCallbacks({ start, onStartError });

    await callbacks.onReplyStart();

    expect(onStartError).toHaveBeenCalledTimes(1);
  });

  it("invokes stop on idle and reports stop errors", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockRejectedValue(new Error("stop"));
    const onStartError = vi.fn();
    const onStopError = vi.fn();
    const callbacks = createTypingCallbacks({ start, stop, onStartError, onStopError });

    callbacks.onIdle?.();
    await flushMicrotasks();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(onStopError).toHaveBeenCalledTimes(1);
  });
});
