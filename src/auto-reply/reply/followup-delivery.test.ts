import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery.js";

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

  it("keeps different-text replies when a messaging tool already sent to the same provider and target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentTexts: ["different message"],
        sentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });

  it("deduplicates same-text replies when originating channel resolves the provider", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "heartbeat",
        originatingChannel: "telegram",
        originatingTo: "268300329",
        sentTexts: ["hello world!"],
        sentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
      }),
    ).toEqual([]);
  });

  it("keeps final text when a same-target messaging tool send only duplicated media", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "Setup complete! Here is the summary..." }],
        messageProvider: "heartbeat",
        originatingChannel: "discord",
        originatingTo: "channel:1489265252167323680",
        sentMediaUrls: ["file:///tmp/test.mp3"],
        sentTargets: [{ tool: "message", provider: "discord", to: "channel:1489265252167323680" }],
        sentTexts: ["Test audio 🟢"],
      }),
    ).toEqual([{ text: "Setup complete! Here is the summary..." }]);
  });

  it("keeps final text when sent target metadata exists but followup origin target is missing", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "slack",
        sentTexts: ["hello world!"],
        sentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });
});
