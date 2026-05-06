import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
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

  it("does not dedupe text sent via messaging tool to another target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "chat-a",
        originatingTo: "chat-a:123",
        sentTexts: ["hello world!"],
        sentTargets: [{ tool: "chat-b", provider: "chat-b", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });

  it("does not dedupe media sent via messaging tool to another target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }],
        messageProvider: "chat-a",
        originatingTo: "chat-a:123",
        sentMediaUrls: ["file:///tmp/photo.jpg"],
        sentTargets: [{ tool: "chat-b", provider: "chat-b", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }]);
  });

  it("dedupes final text only against message-tool text sent to the same route", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "chat-b-only text" }],
        messageProvider: "chat-a",
        originatingTo: "channel:C1",
        sentTexts: ["chat-a text", "chat-b-only text"],
        sentTargets: [
          { tool: "chat-a", provider: "chat-a", to: "channel:C1", text: "chat-a text" },
          {
            tool: "chat-b",
            provider: "chat-b",
            to: "channel:C2",
            text: "chat-b-only text",
          },
        ],
      }),
    ).toEqual([{ text: "chat-b-only text" }]);
  });

  it("falls back to global text dedupe for legacy multi-target messaging telemetry", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "chat-a",
        originatingTo: "channel:C1",
        sentTexts: ["hello world!"],
        sentTargets: [
          { tool: "chat-a", provider: "chat-a", to: "channel:C1" },
          { tool: "chat-b", provider: "chat-b", to: "channel:C2" },
        ],
      }),
    ).toEqual([]);
  });

  it("dedupes final media only against message-tool media sent to the same route", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "photo", mediaUrl: "file:///tmp/chat-b-photo.jpg" }],
        messageProvider: "chat-a",
        originatingTo: "channel:C1",
        sentMediaUrls: ["file:///tmp/chat-a-photo.jpg", "file:///tmp/chat-b-photo.jpg"],
        sentTargets: [
          {
            tool: "chat-a",
            provider: "chat-a",
            to: "channel:C1",
            mediaUrls: ["file:///tmp/chat-a-photo.jpg"],
          },
          {
            tool: "chat-b",
            provider: "chat-b",
            to: "channel:C2",
            mediaUrls: ["file:///tmp/chat-b-photo.jpg"],
          },
        ],
      }),
    ).toEqual([{ text: "photo", mediaUrl: "file:///tmp/chat-b-photo.jpg" }]);
  });

  it("falls back to global media dedupe for legacy multi-target messaging telemetry", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }],
        messageProvider: "chat-a",
        originatingTo: "channel:C1",
        sentMediaUrls: ["file:///tmp/photo.jpg"],
        sentTargets: [
          { tool: "chat-a", provider: "chat-a", to: "channel:C1" },
          { tool: "chat-b", provider: "chat-b", to: "channel:C2" },
        ],
      }),
    ).toEqual([{ text: "photo", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("delivers distinct replies when a messaging tool already sent to the same provider and target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "chat-a",
        originatingTo: "channel:C1",
        sentTargets: [{ tool: "chat-a", provider: "chat-a", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });

  it("dedupes duplicate replies when a messaging tool already sent to the same provider and target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "chat-a",
        originatingTo: "channel:C1",
        sentTexts: ["hello world!"],
        sentTargets: [
          { tool: "chat-a", provider: "chat-a", to: "channel:C1", text: "hello world!" },
        ],
      }),
    ).toEqual([]);
  });

  it("delivers distinct replies when originating channel resolves the provider", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "heartbeat",
        originatingChannel: "chat-a" as never,
        originatingTo: "268300329",
        sentTargets: [{ tool: "chat-a", provider: "chat-a", to: "268300329" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });
});
