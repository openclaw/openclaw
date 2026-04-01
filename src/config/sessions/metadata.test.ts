import { describe, expect, it } from "vitest";
import { deriveSessionOrigin } from "./metadata.js";

describe("session origin metadata", () => {
  it("ignores synthetic heartbeat-only providers and targets", () => {
    expect(
      deriveSessionOrigin({
        Provider: "heartbeat",
        From: "heartbeat",
        To: "heartbeat",
      }),
    ).toBeUndefined();
  });

  it("keeps explicit originating routes even when the provider is synthetic", () => {
    expect(
      deriveSessionOrigin({
        Provider: "cron-event",
        OriginatingChannel: "telegram",
        OriginatingTo: "123456",
        To: "heartbeat",
      }),
    ).toEqual(
      expect.objectContaining({
        provider: "telegram",
        to: "123456",
      }),
    );
  });
});
