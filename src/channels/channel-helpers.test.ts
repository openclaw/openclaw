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
  const cases: Array<{ name: string; ctx: MsgContext; expected: string }> = [
    {
      name: "prefers ConversationLabel when present",
      ctx: { ConversationLabel: "Pinned Label", ChatType: "group" },
      expected: "Pinned Label",
    },
    {
      name: "prefers ThreadLabel over derived chat labels",
      ctx: {
        ThreadLabel: "Thread Alpha",
        ChatType: "group",
        GroupSubject: "Ops",
        From: "telegram:group:42",
      },
      expected: "Thread Alpha",
    },
    {
      name: "uses SenderName for direct chats when available",
      ctx: { ChatType: "direct", SenderName: "Ada", From: "telegram:99" },
      expected: "Ada",
    },
    {
      name: "falls back to From for direct chats when SenderName is missing",
      ctx: { ChatType: "direct", From: "telegram:99" },
      expected: "telegram:99",
    },
    {
      name: "derives Telegram-like group labels with numeric id suffix",
      ctx: { ChatType: "group", GroupSubject: "Ops", From: "telegram:group:42" },
      expected: "Ops id:42",
    },
    {
      name: "does not append ids for #rooms/channels",
      ctx: {
        ChatType: "channel",
        GroupSubject: "#general",
        From: "slack:channel:C123",
      },
      expected: "#general",
    },
    {
      name: "does not append ids when the base already contains the id",
      ctx: {
        ChatType: "group",
        GroupSubject: "Family id:123@g.us",
        From: "whatsapp:group:123@g.us",
      },
      expected: "Family id:123@g.us",
    },
    {
      name: "appends ids for WhatsApp-like group ids when a subject exists",
      ctx: {
        ChatType: "group",
        GroupSubject: "Family",
        From: "whatsapp:group:123@g.us",
      },
      expected: "Family id:123@g.us",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(resolveConversationLabel(testCase.ctx)).toBe(testCase.expected);
    });
  }
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
