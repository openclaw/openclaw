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
    // Chinese meta-acks (Hansen F30/F31 reproduction set)
    "已发",
    "已发 #22141",
    "已发送",
    "主回复已发",
    "主回复已发 (#22142)",
    "核心回答如下",
    "总结如下",
    "不再追加总结",
    "好了",
    "收到",
    // English meta-acks
    "Sent",
    "Sent above",
    "Sent #22141",
    "Done.",
    "Replied above",
    "Posted.",
    "Acknowledged.",
    "OK",
    "Okay",
    "Roger",
    "Got it",
    "Copy that",
    "Replying above",
    "Answer below",
    // Case insensitivity + emoji stripping
    "OK 👍",
    "  sent  ",
    // Punctuation-heavy forms
    "OK...",
    "已发.",
  ])("returns true for meta-commentary %j", (text) => {
    expect(isPostToolSendMetaCommentary(text)).toBe(true);
  });

  it.each([
    // ClawSweeper-flagged false positives — prefix-only matches must NOT be
    // suppressed (the ack must stand alone as the entire text).
    "Oklahoma weather",
    "sentence fixed",
    "已发现问题",
    "已发现",
    "已收到消息",
    "sentry deployed",
    "okay let's go",
    // Compound meta-acks: NOT auto-suppressed (trade-off — see PR description).
    // These could legitimately be a real reply or a meta-ack; the filter
    // errs on the side of preserving short user-visible replies.
    "OK, that's the fix.",
    "OK. Done.",
    "Sent. Replied in thread.",
    "已发, 不再追加",
    "已发. 不再追加.",
    "Roger, copy.",
    // Real reply content (must never be suppressed)
    "已发 now let me explain the actual fix in detail: the dedupe threshold is 10.",
    "Here is my analysis of the situation.",
    "I think we should rerun the test suite before pushing.",
    "Yes, the migration is complete and tested on staging.",
    "Let me check that for you — one moment.",
    "The price is $4,235.67, up 2.3% on the day.",
    // Long acks that wrap into real content
    "OK so basically the issue is that the dedupe only fires for texts of length >= 10, which means the short meta-commentary escapes. Let me draft a fix.",
  ])("returns false for real reply content %j", (text) => {
    expect(isPostToolSendMetaCommentary(text)).toBe(false);
  });

  it("returns false for empty / whitespace-only text", () => {
    expect(isPostToolSendMetaCommentary("")).toBe(false);
    expect(isPostToolSendMetaCommentary("   ")).toBe(false);
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

  it("drops meta-acks when message-tool sends happened this run", () => {
    const filtered = filterMessagingToolMetaCommentary({
      payloads: [
        { text: "已发 #22141" },
        { text: "Sent above" },
        { text: "OK" },
        { text: "Here is the real follow-up analysis: ..." },
      ],
      sentTexts: ["主回复内容 (length >= 10)"],
    });
    expect(filtered.map((p) => p.text)).toEqual(["Here is the real follow-up analysis: ..."]);
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
});
