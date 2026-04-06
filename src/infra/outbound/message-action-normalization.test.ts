import { describe, expect, it } from "vitest";
import { normalizeMessageActionInput } from "./message-action-normalization.js";

describe("normalizeMessageActionInput", () => {
  it("rejects legacy to targets", () => {
    expect(() =>
      normalizeMessageActionInput({
        action: "send",
        args: {
          to: "channel:C1",
        },
      }),
    ).toThrow(/Use `target` instead of `to`\/`channelId`/);
  });

  it("rejects legacy channelId targets for target-taking actions", () => {
    expect(() =>
      normalizeMessageActionInput({
        action: "read",
        args: {
          channelId: "channel:C1",
        },
      }),
    ).toThrow(/Use `target` instead of `to`\/`channelId`/);
  });

  it("rejects legacy channelId targets for channel actions", () => {
    expect(() =>
      normalizeMessageActionInput({
        action: "channel-info",
        args: {
          channelId: "channel:C1",
        },
      }),
    ).toThrow(/Use `target` instead of `to`\/`channelId`/);
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

  it("does not overwrite explicit targets with tool-context fallback", () => {
    const normalized = normalizeMessageActionInput({
      action: "send",
      args: {
        target: "channel:C9",
      },
      toolContext: {
        currentChannelId: "channel:C1",
        currentChannelProvider: "slack",
      },
    });

    expect(normalized.target).toBe("channel:C9");
    expect(normalized.to).toBe("channel:C9");
  });

  it("throws when required target remains unresolved", () => {
    expect(() =>
      normalizeMessageActionInput({
        action: "send",
        args: {},
      }),
    ).toThrow(/requires a target/);
  });

  it("does not infer read targets from tool context", () => {
    expect(() =>
      normalizeMessageActionInput({
        action: "read",
        args: {},
        toolContext: {
          currentChannelId: "channel:C1",
          currentChannelProvider: "discord",
        },
      }),
    ).toThrow(/requires a target/);
  });
});
