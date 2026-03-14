import { describe, expect, it } from "vitest";
import {
  looksLikeSlackTargetId,
  normalizeSlackMessagingTarget,
} from "../channels/plugins/normalize/slack.js";
import { parseSlackTarget, resolveSlackChannelId } from "./targets.js";

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

  it("infers bare Slack IDs by prefix", () => {
    expect(parseSlackTarget("U12345678")).toMatchObject({
      kind: "user",
      id: "U12345678",
      normalized: "user:u12345678",
    });
    expect(parseSlackTarget("W12345678")).toMatchObject({
      kind: "user",
      id: "W12345678",
      normalized: "user:w12345678",
    });
    expect(parseSlackTarget("C12345678")).toMatchObject({
      kind: "channel",
      id: "C12345678",
      normalized: "channel:c12345678",
    });
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
    expect(() => resolveSlackChannelId("U12345678")).toThrow(/channel id is required/i);
  });
});

describe("normalizeSlackMessagingTarget", () => {
  it("normalizes raw ids by inferred target kind", () => {
    expect(normalizeSlackMessagingTarget("C123")).toBe("channel:c123");
    expect(normalizeSlackMessagingTarget("U12345678")).toBe("user:u12345678");
  });
});

describe("looksLikeSlackTargetId", () => {
  it("recognizes bare Slack IDs including Z-prefixed channel IDs", () => {
    expect(looksLikeSlackTargetId("U12345678")).toBe(true);
    expect(looksLikeSlackTargetId("W12345678")).toBe(true);
    expect(looksLikeSlackTargetId("C12345678")).toBe(true);
    expect(looksLikeSlackTargetId("G12345678")).toBe(true);
    expect(looksLikeSlackTargetId("D12345678")).toBe(true);
    expect(looksLikeSlackTargetId("Z12345678")).toBe(true);
  });
});
