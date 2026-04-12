import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery.js";

const baseConfig = {} as OpenClawConfig;
const autoWhatsappConfig = {
  channels: {
    whatsapp: {
      replyToMode: "auto",
    },
  },
} as OpenClawConfig;

describe("resolveFollowupDeliveryPayloads", () => {
  it("drops heartbeat ack payloads without media", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "HEARTBEAT_OK" }],
      }),
    ).toEqual([]);
  });

  it("keeps media payloads when stripping heartbeat ack text", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "HEARTBEAT_OK", mediaUrl: "/tmp/image.png" }],
      }),
    ).toEqual([{ text: "", mediaUrl: "/tmp/image.png" }]);
  });

  it("drops text payloads already sent via messaging tool", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        sentTexts: ["hello world!"],
      }),
    ).toEqual([]);
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

  it("suppresses replies when a messaging tool already sent to the same provider and target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      }),
    ).toEqual([]);
  });

  it("suppresses replies when originating channel resolves the provider", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "heartbeat",
        originatingChannel: "telegram",
        originatingTo: "268300329",
        sentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
      }),
    ).toEqual([]);
  });

  it("does not suppress replies when account differs", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "heartbeat",
        originatingChannel: "telegram",
        originatingTo: "268300329",
        originatingAccountId: "personal",
        sentTargets: [
          { tool: "telegram", provider: "telegram", to: "268300329", accountId: "work" },
        ],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });

  it("splits multi-target replies for whitespace-variant reply tags", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [
          {
            text: "[[ reply_to : 123 ]] First answer\n[[ reply_to : 456 ]] Second answer",
          },
        ],
      }),
    ).toEqual([
      { text: "First answer", replyToId: "123", replyToCurrent: undefined },
      { text: "Second answer", replyToId: "456", replyToCurrent: undefined },
    ]);
  });

  it("keeps auto-mode split replies pinned to collected message ids", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: autoWhatsappConfig,
        messageProvider: "whatsapp",
        collectedMessageIds: ["collected-1", "collected-2"],
        payloads: [
          {
            text: "[[reply_to:collected-1]] First answer\n[[reply_to:not-allowed]] Second answer",
          },
        ],
      }),
    ).toEqual([
      { text: "First answer", replyToId: "collected-1", replyToCurrent: undefined },
      { text: "Second answer", replyToId: "collected-2", replyToCurrent: true },
    ]);
  });

  it("fills missing collected ids after accounting for explicit auto-mode targets", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: autoWhatsappConfig,
        messageProvider: "whatsapp",
        collectedMessageIds: ["collected-A", "collected-B"],
        payloads: [{ text: "[[reply_to:collected-B]] First answer" }, { text: "Second answer" }],
      }),
    ).toEqual([
      {
        text: "First answer",
        replyToId: "collected-B",
        replyToCurrent: true,
        replyToTag: true,
      },
      { text: "Second answer", replyToId: "collected-A", replyToCurrent: true },
    ]);
  });

  it("strips collected auto-mode targets that were not supplied by the queue", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: autoWhatsappConfig,
        messageProvider: "whatsapp",
        collectedMessageIds: ["collected-1", "collected-2"],
        payloads: [{ text: "[[reply_to:not-allowed]] reply" }],
      }),
    ).toEqual([
      { text: "reply", replyToId: "collected-1", replyToTag: true, replyToCurrent: true },
    ]);
  });
});
