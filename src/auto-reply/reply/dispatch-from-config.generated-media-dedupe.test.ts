import { beforeEach, describe, expect, it } from "vitest";
import { testing } from "./dispatch-from-config.js";

const route = {
  accountId: "default",
  channel: "discord",
  to: "channel:1507887702379335791",
};

describe("generated media final delivery dedupe", () => {
  beforeEach(() => {
    testing.resetGeneratedMediaFinalDeliveryDedupeForTest();
  });

  it("suppresses repeat generated media finals for the same artifact even when captions differ", () => {
    const firstPayload = {
      text: "first caption",
      mediaUrl: "/home/dicky/.openclaw/media/tool-image-generation/cyan-square.jpg",
    };
    const replayPayload = {
      text: "different replay caption",
      mediaUrl: "/home/dicky/.openclaw/media/tool-image-generation/cyan-square.jpg",
    };

    expect(
      testing.shouldSuppressRecentlyDeliveredGeneratedMediaFinal({
        payload: firstPayload,
        route,
        now: 1_000,
      }),
    ).toBe(false);

    testing.markGeneratedMediaFinalDelivered({
      payload: firstPayload,
      route,
      now: 1_000,
    });

    expect(
      testing.shouldSuppressRecentlyDeliveredGeneratedMediaFinal({
        payload: replayPayload,
        route,
        now: 2_000,
      }),
    ).toBe(true);
  });

  it("keeps distinct generated media deliverable", () => {
    testing.markGeneratedMediaFinalDelivered({
      payload: {
        text: "first caption",
        mediaUrl: "/home/dicky/.openclaw/media/tool-image-generation/cyan-square.jpg",
      },
      route,
      now: 1_000,
    });

    expect(
      testing.shouldSuppressRecentlyDeliveredGeneratedMediaFinal({
        payload: {
          text: "first caption",
          mediaUrl: "/home/dicky/.openclaw/media/tool-image-generation/other.jpg",
        },
        route,
        now: 2_000,
      }),
    ).toBe(false);
  });

  it("does not suppress non-generated media or expired generated media", () => {
    testing.markGeneratedMediaFinalDelivered({
      payload: {
        text: "first caption",
        mediaUrl: "/home/dicky/.openclaw/media/tool-image-generation/cyan-square.jpg",
      },
      route,
      now: 1_000,
    });

    expect(
      testing.shouldSuppressRecentlyDeliveredGeneratedMediaFinal({
        payload: {
          text: "external image",
          mediaUrl: "https://example.test/cyan-square.jpg",
        },
        route,
        now: 2_000,
      }),
    ).toBe(false);

    expect(
      testing.shouldSuppressRecentlyDeliveredGeneratedMediaFinal({
        payload: {
          text: "late replay",
          mediaUrl: "/home/dicky/.openclaw/media/tool-image-generation/cyan-square.jpg",
        },
        route,
        now: 1_000 + 10 * 60 * 1_000 + 1,
      }),
    ).toBe(false);
  });
});
