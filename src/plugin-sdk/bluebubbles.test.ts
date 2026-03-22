import * as bluebubblesSdk from "openclaw/plugin-sdk/bluebubbles";
import { describe, expect, it } from "vitest";

describe("bluebubbles plugin-sdk facade", () => {
  it("exports the webhook guard used by the bundled plugin", () => {
    expect(typeof bluebubblesSdk.beginWebhookRequestPipelineOrReject).toBe("function");
  });

  it("exports pairing helpers used by the bundled plugin", () => {
    expect(typeof bluebubblesSdk.createChannelPairingController).toBe("function");
    expect(typeof bluebubblesSdk.createScopedPairingAccess).toBe("function");
  });

  it("exports reply prefix helpers used by the bundled plugin", () => {
    expect(typeof bluebubblesSdk.createChannelReplyPipeline).toBe("function");
    expect(typeof bluebubblesSdk.createReplyPrefixOptions).toBe("function");
  });
});
