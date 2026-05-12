import { describe, expect, it } from "vitest";
import { formatMessageCliText } from "./message-format.js";

describe("formatMessageCliText", () => {
  it("renders send dry-run results as dry-run output even when handledBy stays core (#80507)", () => {
    expect(
      formatMessageCliText({
        kind: "send",
        channel: "slack",
        action: "send",
        to: "channel:C00000FAKE000",
        handledBy: "core",
        payload: {
          channel: "slack",
          to: "C00000FAKE000",
          via: "direct",
          mediaUrl: null,
          dryRun: true,
        },
        dryRun: true,
      }),
    ).toEqual(["[dry-run] would run send via slack"]);
  });

  it("renders poll dry-run results as dry-run output even when handledBy stays core (#80507)", () => {
    expect(
      formatMessageCliText({
        kind: "poll",
        channel: "telegram",
        action: "poll",
        to: "123456",
        handledBy: "core",
        payload: {
          pollId: "poll-123",
          dryRun: true,
        },
        dryRun: true,
      }),
    ).toEqual(["[dry-run] would run poll via telegram"]);
  });
});
