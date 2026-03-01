import { describe, it, expect } from "vitest";
import {
  formatMentionForText,
  formatMentionForCard,
  buildMentionedMessage,
  buildMentionedCardContent,
} from "./mention.js";

const target = { openId: "ou_abc", name: "Alice", key: "@_user_1" };

describe("formatMentionForText", () => {
  it("wraps openId in <at> tag", () => {
    expect(formatMentionForText(target)).toBe('<at user_id="ou_abc">Alice</at>');
  });
});

describe("formatMentionForCard", () => {
  it("wraps openId in card-style <at> tag", () => {
    expect(formatMentionForCard(target)).toBe("<at id=ou_abc></at>");
  });
});

describe("buildMentionedMessage", () => {
  it("returns original message when no targets", () => {
    expect(buildMentionedMessage([], "hello")).toBe("hello");
  });

  it("prepends mention tags to message", () => {
    const result = buildMentionedMessage([target], "hello");
    expect(result).toBe('<at user_id="ou_abc">Alice</at> hello');
  });

  it("joins multiple mentions", () => {
    const t2 = { openId: "ou_def", name: "Bob", key: "@_user_2" };
    const result = buildMentionedMessage([target, t2], "hi");
    expect(result).toContain('<at user_id="ou_abc">Alice</at>');
    expect(result).toContain('<at user_id="ou_def">Bob</at>');
  });
});

describe("buildMentionedCardContent", () => {
  it("returns original when no targets", () => {
    expect(buildMentionedCardContent([], "hello")).toBe("hello");
  });

  it("prepends card mention tags to content", () => {
    const result = buildMentionedCardContent([target], "hello");
    expect(result).toBe("<at id=ou_abc></at> hello");
  });
});
