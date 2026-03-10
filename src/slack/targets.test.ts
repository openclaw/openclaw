import { describe, expect, it } from "vitest";
import { normalizeSlackMessagingTarget } from "../channels/plugins/normalize/slack.js";
import {
  canonicalizeSlackRoutePeerId,
  parseSlackTarget,
  resolveSlackChannelId,
} from "./targets.js";

describe("parseSlackTarget", () => {
  it("parses user mentions and prefixes", () => {
    const cases = [
      { input: "<@U123>", id: "U123", normalized: "user:u123" },
      { input: "user:U456", id: "U456", normalized: "user:u456" },
      { input: "slack:U789", id: "U789", normalized: "user:u789" },
    ] as const;
    for (const testCase of cases) {
      expect(parseSlackTarget(testCase.input), testCase.input).toMatchObject({
        kind: "user",
        id: testCase.id,
        normalized: testCase.normalized,
      });
    }
  });

  it("parses channel targets", () => {
    const cases = [
      { input: "channel:C123", id: "C123", normalized: "channel:c123" },
      { input: "#C999", id: "C999", normalized: "channel:c999" },
    ] as const;
    for (const testCase of cases) {
      expect(parseSlackTarget(testCase.input), testCase.input).toMatchObject({
        kind: "channel",
        id: testCase.id,
        normalized: testCase.normalized,
      });
    }
  });

  it("rejects invalid @ and # targets", () => {
    const cases = [
      { input: "@bob-1", expectedMessage: /Slack DMs require a user id/ },
      { input: "#general-1", expectedMessage: /Slack channels require a channel id/ },
    ] as const;
    for (const testCase of cases) {
      expect(() => parseSlackTarget(testCase.input), testCase.input).toThrow(
        testCase.expectedMessage,
      );
    }
  });
});

describe("resolveSlackChannelId", () => {
  it("strips channel: prefix and accepts raw ids", () => {
    expect(resolveSlackChannelId("channel:C123")).toBe("C123");
    expect(resolveSlackChannelId("C123")).toBe("C123");
  });

  it("rejects user targets", () => {
    expect(() => resolveSlackChannelId("user:U123")).toThrow(/channel id is required/i);
  });
});

describe("normalizeSlackMessagingTarget", () => {
  it("defaults raw ids to channels", () => {
    expect(normalizeSlackMessagingTarget("C123")).toBe("channel:c123");
  });
});

describe("canonicalizeSlackRoutePeerId", () => {
  it("normalizes Slack target syntax for channel bindings", () => {
    expect(canonicalizeSlackRoutePeerId({ kind: "channel", raw: "channel:c123abc" })).toEqual({
      id: "C123ABC",
      didNormalize: true,
      usedTargetSyntax: true,
    });
    expect(canonicalizeSlackRoutePeerId({ kind: "group", raw: "<#C123ABC|general>" })).toEqual({
      id: "C123ABC",
      didNormalize: true,
      usedTargetSyntax: true,
    });
  });

  it("normalizes Slack target syntax for direct bindings", () => {
    expect(canonicalizeSlackRoutePeerId({ kind: "direct", raw: "user:u123abc" })).toEqual({
      id: "U123ABC",
      didNormalize: true,
      usedTargetSyntax: true,
    });
    expect(canonicalizeSlackRoutePeerId({ kind: "direct", raw: "<@U123ABC>" })).toEqual({
      id: "U123ABC",
      didNormalize: true,
      usedTargetSyntax: true,
    });
  });
});
