// Tests mention detection and command trigger matching.
import { describe, expect, it } from "vitest";
import { buildMentionRegexes, matchesMentionPatterns, stripStructuralPrefixes } from "./mentions.js";

describe("stripStructuralPrefixes", () => {
  it("returns empty string for undefined input at runtime", () => {
    expect(stripStructuralPrefixes(undefined as unknown as string)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(stripStructuralPrefixes("")).toBe("");
  });

  it("strips sender prefix labels", () => {
    expect(stripStructuralPrefixes("John: hello")).toBe("hello");
  });

  it("preserves colon-delimited slash commands", () => {
    expect(stripStructuralPrefixes("/config:json")).toBe("/config:json");
    expect(stripStructuralPrefixes("/reset: soft")).toBe("/reset: soft");
    expect(stripStructuralPrefixes("/compact: focus on decisions")).toBe(
      "/compact: focus on decisions",
    );
  });

  it("strips direct envelope display labels with handles", () => {
    expect(
      stripStructuralPrefixes("[Telegram Alice (@alice) id:123] Alice (@alice): /status"),
    ).toBe("/status");
  });

  it("strips direct envelope display labels with non-ascii characters", () => {
    expect(stripStructuralPrefixes("[Telegram Jörg] Jörg: /status")).toBe("/status");
    expect(stripStructuralPrefixes("[Telegram 山田] 山田: /status")).toBe("/status");
  });

  it("strips slash-like display labels only after an envelope", () => {
    expect(stripStructuralPrefixes("[Telegram /reset id:123] /reset: hello")).toBe("hello");
  });

  it("passes through plain text", () => {
    expect(stripStructuralPrefixes("just a message")).toBe("just a message");
  });

  it("flattens multiline soft reset commands before downstream parsing", () => {
    expect(stripStructuralPrefixes("/reset soft\nre-read persona files")).toBe(
      "/reset soft re-read persona files",
    );
    expect(stripStructuralPrefixes("/reset \nsoft")).toBe("/reset soft");
  });
});

describe("CJK single-char mention matching (regression #87303)", () => {
  const cfgWithCjkName = {
    agents: {
      default: { identity: { name: "包" } },
    },
  } as Parameters<typeof buildMentionRegexes>[0];

  const cfgWithCjkTwoChar = {
    agents: {
      default: { identity: { name: "苏苏" } },
    },
  } as Parameters<typeof buildMentionRegexes>[0];

  it("matches single-char CJK name with @ prefix in Chinese text", () => {
    const regexes = buildMentionRegexes(cfgWithCjkName, "default");
    expect(regexes.length).toBeGreaterThan(0);
    expect(matchesMentionPatterns("@包 你好", regexes)).toBe(true);
  });

  it("matches single-char CJK name without @ prefix", () => {
    const regexes = buildMentionRegexes(cfgWithCjkName, "default");
    expect(matchesMentionPatterns("包 你好", regexes)).toBe(true);
  });

  it("does not match single-char CJK name inside a longer CJK word", () => {
    const regexes = buildMentionRegexes(cfgWithCjkName, "default");
    expect(matchesMentionPatterns("面包好吃", regexes)).toBe(false);
  });

  it("matches two-char CJK name with @ prefix", () => {
    const regexes = buildMentionRegexes(cfgWithCjkTwoChar, "default");
    expect(matchesMentionPatterns("@苏苏 你好", regexes)).toBe(true);
  });

  it("does not match two-char CJK name as substring", () => {
    const regexes = buildMentionRegexes(cfgWithCjkTwoChar, "default");
    expect(matchesMentionPatterns("紫苏苏叶", regexes)).toBe(false);
  });
});
