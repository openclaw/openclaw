// Tests reply payload helper behavior and delivery metadata.
import { describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import {
  filterMessagingToolMediaDuplicates,
  filterMessagingToolMetaCommentary,
  isPostToolSendMetaCommentary,
  resolveMessagingToolPayloadDedupe,
  shouldDedupeMessagingToolRepliesForRoute,
} from "./reply-payloads.js";

function targetsMatchTelegramReplySuppression(params: {
  originTarget: string;
  targetKey: string;
  targetThreadId?: string;
}): boolean {
  const baseTarget = (value: string) =>
    value
      .replace(/^telegram:(group|channel):/u, "")
      .replace(/^telegram:/u, "")
      .replace(/:topic:.*$/u, "");
  const originTopic = params.originTarget.match(/:topic:([^:]+)$/u)?.[1];
  return (
    baseTarget(params.originTarget) === baseTarget(params.targetKey) &&
    (originTopic === undefined || originTopic === params.targetThreadId)
  );
}

vi.mock("../../channels/plugins/bundled.js", () => ({
  getBundledChannelPlugin: (channel: string) =>
    channel === "telegram"
      ? {
          outbound: {
            targetsMatchForReplySuppression: targetsMatchTelegramReplySuppression,
          },
        }
      : undefined,
}));

describe("filterMessagingToolMediaDuplicates", () => {
  it("strips mediaUrl when it matches sentMediaUrls", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("preserves mediaUrl when it is not in sentMediaUrls", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      sentMediaUrls: ["file:///tmp/other.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }]);
  });

  it("filters matching entries from mediaUrls array", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [
        {
          text: "gallery",
          mediaUrls: ["file:///tmp/a.jpg", "file:///tmp/b.jpg", "file:///tmp/c.jpg"],
        },
      ],
      sentMediaUrls: ["file:///tmp/b.jpg"],
    });
    expect(result).toEqual([
      { text: "gallery", mediaUrls: ["file:///tmp/a.jpg", "file:///tmp/c.jpg"] },
    ]);
  });

  it("clears mediaUrls when all entries match", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "gallery", mediaUrls: ["file:///tmp/a.jpg"] }],
      sentMediaUrls: ["file:///tmp/a.jpg"],
    });
    expect(result).toEqual([{ text: "gallery", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("returns payloads unchanged when no media present", () => {
    const payloads = [{ text: "plain text" }];
    const result = filterMessagingToolMediaDuplicates({
      payloads,
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });
    expect(result).toStrictEqual(payloads);
  });

  it("returns payloads unchanged when sentMediaUrls is empty", () => {
    const payloads = [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }];
    const result = filterMessagingToolMediaDuplicates({
      payloads,
      sentMediaUrls: [],
    });
    expect(result).toBe(payloads);
  });

  it("dedupes equivalent file and local path variants", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "/tmp/photo.jpg" }],
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("dedupes encoded file:// paths against local paths", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "/tmp/photo one.jpg" }],
      sentMediaUrls: ["file:///tmp/photo%20one.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("preserves transcript ownership metadata when stripping media", () => {
    const payload = setReplyPayloadMetadata(
      { text: "hello", mediaUrl: "file:///tmp/photo.jpg" },
      { assistantTranscriptOwned: true },
    );
    const [result] = filterMessagingToolMediaDuplicates({
      payloads: [payload],
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });

    expect(getReplyPayloadMetadata(result)).toEqual({
      assistantTranscriptOwned: true,
    });
  });
});

describe("shouldDedupeMessagingToolRepliesForRoute", () => {
  const installTelegramSuppressionRegistry = () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram-plugin",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              targetsMatchForReplySuppression: targetsMatchTelegramReplySuppression,
            },
          }),
        },
      ]),
    );
  };

  it("matches when target provider is missing but target matches current provider route", () => {
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "", to: "123" }],
      }),
    ).toBe(true);
  });

  it('matches when target provider uses "message" placeholder and target matches', () => {
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "message", to: "123" }],
      }),
    ).toBe(true);
  });

  it("does not match when providerless target does not match origin route", () => {
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "", to: "456" }],
      }),
    ).toBe(false);
  });

  it("matches when only one side carries the account id", () => {
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "123",
        accountId: "work",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "123" }],
      }),
    ).toBe(true);
  });

  it("does not match when route accounts differ", () => {
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "123",
        accountId: "work",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "123", accountId: "personal" },
        ],
      }),
    ).toBe(false);
  });

  it("matches telegram topic-origin replies when explicit threadId matches", () => {
    installTelegramSuppressionRegistry();
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: "77" },
        ],
      }),
    ).toBe(true);
  });

  it("preserves string thread ids before plugin reply-suppression matching", () => {
    installTelegramSuppressionRegistry();
    const largeThreadId = "9007199254740993";

    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: `telegram:group:-100123:topic:${largeThreadId}`,
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: largeThreadId },
        ],
      }),
    ).toBe(true);
  });

  it("does not match telegram topic-origin replies when explicit threadId differs", () => {
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: "88" },
        ],
      }),
    ).toBe(false);
  });

  it("does not match telegram topic-origin replies when target omits topic metadata", () => {
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "-100123" }],
      }),
    ).toBe(false);
  });

  it("matches telegram replies when chatId matches but target forms differ", () => {
    installTelegramSuppressionRegistry();
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "-100123" }],
      }),
    ).toBe(true);
  });

  it("matches telegram replies even when the active plugin registry omits telegram", () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createTestRegistry([]));

    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: "77" },
        ],
      }),
    ).toBe(true);
  });
});

describe("resolveMessagingToolPayloadDedupe", () => {
  it("dedupes by content when messaging tool target metadata is unavailable", () => {
    expect(
      resolveMessagingToolPayloadDedupe({
        messageProvider: "telegram",
        originatingTo: "123",
      }),
    ).toEqual({
      shouldDedupePayloads: true,
      matchingRoute: false,
      routeSentTexts: [],
      routeSentMediaUrls: [],
      useGlobalSentTextEvidenceFallback: false,
      useGlobalSentMediaUrlEvidenceFallback: false,
    });
  });

  it("dedupes final replies by content when a messaging tool sent to the same route", () => {
    expect(
      resolveMessagingToolPayloadDedupe({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "telegram",
            to: "123",
            text: "sent text",
            mediaUrls: ["file:///tmp/sent.png"],
          },
        ],
      }),
    ).toEqual({
      shouldDedupePayloads: true,
      matchingRoute: true,
      routeSentTexts: ["sent text"],
      routeSentMediaUrls: ["file:///tmp/sent.png"],
      useGlobalSentTextEvidenceFallback: false,
      useGlobalSentMediaUrlEvidenceFallback: false,
    });
  });

  it("preserves global evidence fallback for legacy multi-target records", () => {
    expect(
      resolveMessagingToolPayloadDedupe({
        messageProvider: "slack",
        originatingTo: "channel:C1",
        messagingToolSentTargets: [
          { tool: "slack", provider: "slack", to: "channel:C1" },
          { tool: "discord", provider: "discord", to: "channel:C2" },
        ],
      }),
    ).toEqual({
      shouldDedupePayloads: true,
      matchingRoute: true,
      routeSentTexts: [],
      routeSentMediaUrls: [],
      useGlobalSentTextEvidenceFallback: true,
      useGlobalSentMediaUrlEvidenceFallback: true,
    });
  });

  it("scopes matching-route evidence to the matched target", () => {
    expect(
      resolveMessagingToolPayloadDedupe({
        messageProvider: "slack",
        originatingTo: "channel:C1",
        messagingToolSentTargets: [
          { tool: "slack", provider: "slack", to: "channel:C1", text: "slack text" },
          {
            tool: "discord",
            provider: "discord",
            to: "channel:C2",
            text: "discord text",
            mediaUrls: ["file:///tmp/discord.png"],
          },
        ],
      }),
    ).toEqual({
      shouldDedupePayloads: true,
      matchingRoute: true,
      routeSentTexts: ["slack text"],
      routeSentMediaUrls: [],
      useGlobalSentTextEvidenceFallback: false,
      useGlobalSentMediaUrlEvidenceFallback: false,
    });
  });

  it("keeps final payloads intact when a messaging tool sent to another route", () => {
    expect(
      resolveMessagingToolPayloadDedupe({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      }),
    ).toEqual({
      shouldDedupePayloads: false,
      matchingRoute: false,
      routeSentTexts: [],
      routeSentMediaUrls: [],
      useGlobalSentTextEvidenceFallback: false,
      useGlobalSentMediaUrlEvidenceFallback: false,
    });
  });
});

describe("isPostToolSendMetaCommentary", () => {
  it.each([
    // Chinese standalone meta-acks
    "已发",
    "已发 #22141",
    "已发送",
    "已发完毕",
    "主回复已发",
    "主回复已发 (#22142)",
    "消息已发出",
    "回复已发",
    "好了",
    "收到",
    "完毕",
    "完成",
    "了解",
    "知道了",
    "明白",
    // Chinese mid-text acks
    "核心回答如下",
    "总结如下",
    "以下为核心回答",
    "以下为总结",
    "不再追加总结",
    "不再追加",
    "以下为回复",
    "答案如下",
    "如上",
    "回复如上",
    // English standalone acks
    "Sent",
    "Sent above",
    "Sent #22141",
    "Done.",
    "Replied above",
    "Replied in thread",
    "See above",
    "As above",
    "Posted.",
    "Acknowledged.",
    "OK",
    "Okay",
    "Roger",
    "Got it",
    "Gotcha",
    "Copy that",
    "Copied",
    "Ack",
    "Will do",
    "On it",
    "Noted",
    "Understood",
    "Thanks",
    // English mid-text acks
    "Replying above",
    "Replying in thread",
    "Answer below",
    "Response above",
    "Sent in thread",
    // Case insensitivity + whitespace + punctuation
    "OK 👍",
    "  sent  ",
    "OK...",
    "已发.",
    "ok",
    "SENT ABOVE",
  ])("returns true for standalone meta-ack %j", (text) => {
    expect(isPostToolSendMetaCommentary(text)).toBe(true);
  });

  it.each([
    // Compound acks — every segment is itself ack-like
    "Sent. Replied in thread.",
    "已发, 不再追加总结",
    "已发. 不再追加.",
    "OK. Done.",
    "Roger, copy.",
    "Done. Sent.",
    "收到. 已发.",
    "Sent above. Replying in thread.",
    "Got it. Will do.",
    "已发, 完成",
    "OK, noted",
    "了解, 收到",
    "Copied, thanks",
  ])("returns true for compound meta-ack %j", (text) => {
    expect(isPostToolSendMetaCommentary(text)).toBe(true);
  });

  it.each([
    // ClawSweeper-flagged false positives — prefix-only matches must NOT be
    // suppressed (the ack must stand alone as the entire text or every
    // segment must be ack-like).
    "Oklahoma weather",
    "sentence fixed",
    "已发现问题",
    "已发现",
    "已收到消息",
    "sentry deployed",
    "okay let's go",
    // Mixed compound forms — second segment has real content that is not
    // ack-like, so these must NOT be suppressed.
    "OK, that's the fix.",
    "OK. That's the fix.",
    "OK, let me check that.",
    "已发. Now let me explain the actual fix in detail: the dedupe threshold is 10.",
    "Got it, let me take a look at the code.",
    "Done, the migration is complete.",
    "Sent, but I noticed the logs have an error.",
    "收到, 但是这个方案有一个问题",
    // Real reply content (must never be suppressed)
    "已发 now let me explain the actual fix in detail: the dedupe threshold is 10.",
    "Here is my analysis of the situation.",
    "I think we should rerun the test suite before pushing.",
    "Yes, the migration is complete and tested on staging.",
    "Let me check that for you — one moment.",
    "The price is $4,235.67, up 2.3% on the day.",
    // Long content that happens to start with an ack-like word
    "OK so basically the issue is that the dedupe only fires for texts of length >= 10, which means the short meta-commentary escapes. Let me draft a fix.",
    // Non-ack short replies
    "No",
    "Yes",
    "Maybe",
    "Please wait",
    "Hold on",
    "One moment",
    "Checking",
  ])("returns false for real reply content %j", (text) => {
    expect(isPostToolSendMetaCommentary(text)).toBe(false);
  });

  it("returns false for empty / whitespace-only text", () => {
    expect(isPostToolSendMetaCommentary("")).toBe(false);
    expect(isPostToolSendMetaCommentary("   ")).toBe(false);
  });

  it("returns false for text exceeding MAX_META_COMMENTARY_LENGTH", () => {
    expect(isPostToolSendMetaCommentary("OK " + "x".repeat(200))).toBe(false);
  });
});

describe("filterMessagingToolMetaCommentary", () => {
  it("does nothing when no message-tool sends happened this run", () => {
    const filtered = filterMessagingToolMetaCommentary({
      payloads: [{ text: "已发 #1" }],
      sentTexts: [],
    });
    expect(filtered).toEqual([{ text: "已发 #1" }]);
  });

  it("drops standalone meta-acks when message-tool sends happened", () => {
    const filtered = filterMessagingToolMetaCommentary({
      payloads: [
        { text: "已发 #22141" },
        { text: "Sent above" },
        { text: "OK" },
        { text: "Here is the real follow-up analysis: ..." },
      ],
      sentTexts: ["main reply content (length >= 10)"],
    });
    expect(filtered.map((p) => p.text)).toEqual(["Here is the real follow-up analysis: ..."]);
  });

  it("drops compound meta-acks when message-tool sends happened", () => {
    const filtered = filterMessagingToolMetaCommentary({
      payloads: [
        { text: "Sent. Replied in thread." },
        { text: "已发, 不再追加总结" },
        { text: "OK. Done." },
        { text: "Real content here." },
      ],
      sentTexts: ["main reply"],
    });
    expect(filtered.map((p) => p.text)).toEqual(["Real content here."]);
  });

  it("preserves mixed compound forms that contain real content", () => {
    const filtered = filterMessagingToolMetaCommentary({
      payloads: [{ text: "OK, that's the fix." }, { text: "Done, the migration is complete." }],
      sentTexts: ["main reply"],
    });
    expect(filtered.map((p) => p.text)).toEqual([
      "OK, that's the fix.",
      "Done, the migration is complete.",
    ]);
  });

  it("never suppresses media payloads even if the caption is meta-ack", () => {
    const filtered = filterMessagingToolMetaCommentary({
      payloads: [
        { text: "已发", mediaUrl: "https://example.com/chart.png" },
        { text: "Sent", mediaUrls: ["https://example.com/photo.jpg"] },
      ],
      sentTexts: ["main reply"],
    });
    expect(filtered).toHaveLength(2);
  });

  it("preserves empty-text payloads", () => {
    const filtered = filterMessagingToolMetaCommentary({
      payloads: [{ text: "" }, { text: undefined }],
      sentTexts: ["main reply"],
    });
    expect(filtered).toHaveLength(2);
  });
});
