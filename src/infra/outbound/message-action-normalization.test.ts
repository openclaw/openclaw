import { describe, expect, it } from "vitest";
import { normalizeMessageActionInput } from "./message-action-normalization.js";

describe("normalizeMessageActionInput", () => {
  it("prefers explicit target and clears legacy target fields", () => {
    const normalized = normalizeMessageActionInput({
      action: "send",
      args: {
        target: "channel:C1",
        to: "legacy",
        channelId: "legacy-channel",
      },
    });

    expect(normalized.target).toBe("channel:C1");
    expect(normalized.to).toBe("channel:C1");
    expect("channelId" in normalized).toBe(false);
  });

  it("maps legacy target fields into canonical target", () => {
    const normalized = normalizeMessageActionInput({
      action: "send",
      args: {
        to: "channel:C1",
      },
    });

    expect(normalized.target).toBe("channel:C1");
    expect(normalized.to).toBe("channel:C1");
  });

  it("ignores empty legacy target fields when explicit target is present", () => {
    const normalized = normalizeMessageActionInput({
      action: "send",
      args: {
        target: "channel:C1",
        to: "",
        channelId: "   ",
      },
    });

    expect(normalized.target).toBe("channel:C1");
    expect(normalized.to).toBe("channel:C1");
    expect("channelId" in normalized).toBe(false);
  });

  it("infers target from tool context when required", () => {
    const normalized = normalizeMessageActionInput({
      action: "send",
      args: {},
      toolContext: {
        currentChannelId: "channel:C1",
      },
    });

    expect(normalized.target).toBe("channel:C1");
    expect(normalized.to).toBe("channel:C1");
  });

  it("infers channel from tool context provider", () => {
    const normalized = normalizeMessageActionInput({
      action: "send",
      args: {
        target: "channel:C1",
      },
      toolContext: {
        currentChannelId: "C1",
        currentChannelProvider: "slack",
      },
    });

    expect(normalized.channel).toBe("slack");
  });

  it("throws when required target remains unresolved", () => {
    expect(() =>
      normalizeMessageActionInput({
        action: "send",
        args: {},
      }),
    ).toThrow(/requires a target/);
  });
});
