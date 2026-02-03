import { describe, expect, it } from "vitest";
import { normalizeChatType } from "./chat-type.js";

describe("normalizeChatType", () => {
  it("normalizes common inputs", () => {
    expect(normalizeChatType("direct")).toBe("direct");
    expect(normalizeChatType("dm")).toBe("direct");
    expect(normalizeChatType("group")).toBe("group");
    expect(normalizeChatType("channel")).toBe("channel");
  });

  it("returns undefined for empty/unknown values", () => {
    expect(normalizeChatType(undefined)).toBeUndefined();
    expect(normalizeChatType("")).toBeUndefined();
    expect(normalizeChatType("nope")).toBeUndefined();
    expect(normalizeChatType("room")).toBeUndefined();
  });
});
