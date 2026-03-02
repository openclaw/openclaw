import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { buildMentionRegexes, stripMentions } from "./mentions.js";

describe("buildMentionRegexes", () => {
  it("ignores non-string, empty, and invalid mention patterns", () => {
    const cfg = {
      messages: {
        groupChat: {
          mentionPatterns: [undefined, null, "   ", "@openclaw", "(["],
        },
      },
    } as unknown as OpenClawConfig;

    const regexes = buildMentionRegexes(cfg);
    expect(regexes).toHaveLength(1);
    expect(regexes[0]?.test("@openclaw hi")).toBe(true);
  });
});

describe("stripMentions", () => {
  it("does not throw when mentionPatterns contains undefined entries", () => {
    const cfg = {
      messages: {
        groupChat: {
          mentionPatterns: [undefined, "@openclaw"],
        },
      },
    } as unknown as OpenClawConfig;
    const ctx = {} as MsgContext;

    expect(() => stripMentions("@openclaw hello", ctx, cfg)).not.toThrow();
    expect(stripMentions("@openclaw hello", ctx, cfg)).toBe("hello");
  });
});
