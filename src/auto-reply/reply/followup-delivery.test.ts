// Tests follow-up reply delivery and route preservation.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery.js";

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
}));

const baseConfig = {} as OpenClawConfig;

describe("resolveFollowupDeliveryPayloads", () => {
  it("drops heartbeat ack payloads without media", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "HEARTBEAT_OK" }],
      }),
    ).toStrictEqual([]);
  });

  it("keeps media payloads when stripping heartbeat ack text", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "HEARTBEAT_OK", mediaUrl: "/tmp/image.png" }],
      }),
    ).toEqual([{ text: "", mediaUrl: "/tmp/image.png" }]);
  });

  it("preserves transcript ownership when stripping heartbeat text", () => {
    const payload = setReplyPayloadMetadata(
      { text: "HEARTBEAT_OK still working" },
      { assistantTranscriptOwned: true },
    );

    const [resolved] = resolveFollowupDeliveryPayloads({
      cfg: baseConfig,
      payloads: [payload],
    });

    expect(getReplyPayloadMetadata(resolved ?? {})).toEqual({
      assistantTranscriptOwned: true,
      replyDelivery: {
        replyToMode: "all",
      },
    });
  });

  it("uses the captured reply policy instead of reloading changed config", () => {
    const [resolved] = resolveFollowupDeliveryPayloads({
      cfg: {
        channels: {
          slack: {
            replyToMode: "all",
          },
        },
      } as OpenClawConfig,
      payloads: [{ text: "queued reply" }],
      originatingChannel: "slack",
      originatingChatType: "channel",
      originatingReplyToMode: "off",
    });

    expect(getReplyPayloadMetadata(resolved ?? {})?.replyDelivery).toEqual({
      chatType: "channel",
      replyToMode: "off",
    });
  });

  it("drops text payloads already sent via messaging tool", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        sentTexts: ["hello world!"],
      }),
    ).toStrictEqual([]);
  });

  it("drops media payloads already sent via messaging tool", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ mediaUrl: "/tmp/img.png" }],
        sentMediaUrls: ["/tmp/img.png"],
      }),
    ).toEqual([{ mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("does not dedupe text sent via messaging tool to another target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "telegram",
        originatingTo: "telegram:123",
        sentTexts: ["hello world!"],
        sentTargets: [{ tool: "discord", provider: "discord", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });

  it("does not dedupe media sent via messaging tool to another target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }],
        messageProvider: "telegram",
        originatingTo: "telegram:123",
        sentMediaUrls: ["file:///tmp/photo.jpg"],
        sentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }]);
  });

  it("dedupes final text only against message-tool text sent to the same route", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "discord-only text" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentTexts: ["slack text", "discord-only text"],
        sentTargets: [
          { tool: "slack", provider: "slack", to: "channel:C1", text: "slack text" },
          {
            tool: "discord",
            provider: "discord",
            to: "channel:C2",
            text: "discord-only text",
          },
        ],
      }),
    ).toEqual([{ text: "discord-only text" }]);
  });

  it("does not dedupe same-channel text sent to a different routed thread", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "thread reply" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        originatingThreadId: "222.000",
        sentTexts: ["thread reply"],
        sentTargets: [
          {
            tool: "slack",
            provider: "slack",
            to: "channel:C1",
            threadId: "111.000",
            text: "thread reply",
          },
        ],
      }),
    ).toEqual([{ text: "thread reply" }]);
  });

  it("dedupes same-channel text sent to the same routed thread", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "thread reply" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        originatingThreadId: "111.000",
        sentTexts: ["thread reply"],
        sentTargets: [
          {
            tool: "slack",
            provider: "slack",
            to: "channel:C1",
            threadId: "111.000",
            text: "thread reply",
          },
        ],
      }),
    ).toStrictEqual([]);
  });

  it("dedupes a Slack DM tool send recorded through its routable target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "thread reply" }],
        messageProvider: "slack",
        originatingTo: "user:U123",
        originatingThreadId: "171.222",
        sentTexts: ["thread reply"],
        sentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "user:U123",
            threadId: "171.222",
            text: "thread reply",
          },
        ],
      }),
    ).toStrictEqual([]);
  });

  it("falls back to global text dedupe for legacy multi-target messaging telemetry", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentTexts: ["hello world!"],
        sentTargets: [
          { tool: "slack", provider: "slack", to: "channel:C1" },
          { tool: "discord", provider: "discord", to: "channel:C2" },
        ],
      }),
    ).toStrictEqual([]);
  });

  it("dedupes final media only against message-tool media sent to the same route", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "photo", mediaUrl: "file:///tmp/discord-photo.jpg" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentMediaUrls: ["file:///tmp/slack-photo.jpg", "file:///tmp/discord-photo.jpg"],
        sentTargets: [
          {
            tool: "slack",
            provider: "slack",
            to: "channel:C1",
            mediaUrls: ["file:///tmp/slack-photo.jpg"],
          },
          {
            tool: "discord",
            provider: "discord",
            to: "channel:C2",
            mediaUrls: ["file:///tmp/discord-photo.jpg"],
          },
        ],
      }),
    ).toEqual([{ text: "photo", mediaUrl: "file:///tmp/discord-photo.jpg" }]);
  });

  it("falls back to global media dedupe for legacy multi-target messaging telemetry", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentMediaUrls: ["file:///tmp/photo.jpg"],
        sentTargets: [
          { tool: "slack", provider: "slack", to: "channel:C1" },
          { tool: "discord", provider: "discord", to: "channel:C2" },
        ],
      }),
    ).toEqual([{ text: "photo", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("delivers distinct replies when a messaging tool already sent to the same provider and target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });

  it("drops short trailing meta acknowledgements after a same-route message tool send", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [
          { text: "已发 #22141" },
          { text: "Sent above" },
          { text: "核心回答如下" },
          { text: "OK" },
        ],
        messageProvider: "telegram",
        originatingTo: "telegram:123",
        sentTargets: [
          {
            tool: "message",
            provider: "telegram",
            to: "telegram:123",
            text: "完整主回复内容已经通过 message tool 发出",
          },
        ],
      }),
    ).toStrictEqual([]);
  });

  it("drops compound meta acknowledgements without dropping substantive short replies", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [
          { text: "已发, 不再追加总结" },
          { text: "Sent. Replied in thread." },
          { text: "OK, that's the fix." },
          { text: "OK, here is the actual answer." },
        ],
        messageProvider: "telegram",
        originatingTo: "telegram:123",
        sentTargets: [
          {
            tool: "message",
            provider: "telegram",
            to: "telegram:123",
            text: "完整主回复内容已经通过 message tool 发出",
          },
        ],
      }),
    ).toEqual([{ text: "OK, here is the actual answer." }]);
  });

  it("dedupes duplicate replies when a messaging tool already sent to the same provider and target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentTexts: ["hello world!"],
        sentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1", text: "hello world!" }],
      }),
    ).toStrictEqual([]);
  });

  it("delivers distinct replies when originating channel resolves the provider", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "heartbeat",
        originatingChannel: "telegram",
        originatingTo: "268300329",
        sentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });
});
