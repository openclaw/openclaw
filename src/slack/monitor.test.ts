import { describe, expect, it } from "vitest";

import { isSlackRoomAllowedByPolicy, resolveSlackThreadTs } from "./monitor.js";

describe("slack groupPolicy gating", () => {
  it("allows when policy is open", () => {
    expect(
      isSlackRoomAllowedByPolicy({
        groupPolicy: "open",
        channelAllowlistConfigured: false,
        channelAllowed: false,
      }),
    ).toBe(true);
  });

  it("blocks when policy is disabled", () => {
    expect(
      isSlackRoomAllowedByPolicy({
        groupPolicy: "disabled",
        channelAllowlistConfigured: true,
        channelAllowed: true,
      }),
    ).toBe(false);
  });

  it("blocks allowlist when no channel allowlist configured", () => {
    expect(
      isSlackRoomAllowedByPolicy({
        groupPolicy: "allowlist",
        channelAllowlistConfigured: false,
        channelAllowed: true,
      }),
    ).toBe(false);
  });

  it("allows allowlist when channel is allowed", () => {
    expect(
      isSlackRoomAllowedByPolicy({
        groupPolicy: "allowlist",
        channelAllowlistConfigured: true,
        channelAllowed: true,
      }),
    ).toBe(true);
  });

  it("blocks allowlist when channel is not allowed", () => {
    expect(
      isSlackRoomAllowedByPolicy({
        groupPolicy: "allowlist",
        channelAllowlistConfigured: true,
        channelAllowed: false,
      }),
    ).toBe(false);
  });
});

describe("resolveSlackThreadTs", () => {
  const threadTs = "1234567890.123456";

  describe("replyToMode=off", () => {
    it("returns baseThreadTs when in a thread", () => {
      expect(
        resolveSlackThreadTs({
          replyToMode: "off",
          baseThreadTs: threadTs,
          hasReplied: false,
        }),
      ).toBe(threadTs);
    });

    it("returns baseThreadTs even after replies (stays in thread)", () => {
      expect(
        resolveSlackThreadTs({
          replyToMode: "off",
          baseThreadTs: threadTs,
          hasReplied: true,
        }),
      ).toBe(threadTs);
    });

    it("returns undefined when not in a thread", () => {
      expect(
        resolveSlackThreadTs({
          replyToMode: "off",
          baseThreadTs: undefined,
          hasReplied: false,
        }),
      ).toBeUndefined();
    });
  });

  describe("replyToMode=first", () => {
    it("returns baseThreadTs for first reply", () => {
      expect(
        resolveSlackThreadTs({
          replyToMode: "first",
          baseThreadTs: threadTs,
          hasReplied: false,
        }),
      ).toBe(threadTs);
    });

    it("returns undefined for subsequent replies (goes to main channel)", () => {
      expect(
        resolveSlackThreadTs({
          replyToMode: "first",
          baseThreadTs: threadTs,
          hasReplied: true,
        }),
      ).toBeUndefined();
    });
  });

  describe("replyToMode=all", () => {
    it("returns baseThreadTs for first reply", () => {
      expect(
        resolveSlackThreadTs({
          replyToMode: "all",
          baseThreadTs: threadTs,
          hasReplied: false,
        }),
      ).toBe(threadTs);
    });

    it("returns baseThreadTs for subsequent replies (all go to thread)", () => {
      expect(
        resolveSlackThreadTs({
          replyToMode: "all",
          baseThreadTs: threadTs,
          hasReplied: true,
        }),
      ).toBe(threadTs);
    });
  });
});
