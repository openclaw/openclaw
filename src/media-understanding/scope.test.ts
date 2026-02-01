import { describe, expect, it } from "vitest";
import { normalizeMediaUnderstandingChatType, resolveMediaUnderstandingScope } from "./scope.js";

describe("media understanding scope", () => {
  it("normalizes chatType", () => {
    expect(normalizeMediaUnderstandingChatType("channel")).toBe("channel");
    expect(normalizeMediaUnderstandingChatType("dm")).toBe("direct");
    expect(normalizeMediaUnderstandingChatType("room")).toBeUndefined();
  });

  it("matches channel chatType explicitly", () => {
    const scope = {
      rules: [{ action: "deny", match: { chatType: "channel" } }],
    } as const;

    expect(resolveMediaUnderstandingScope({ scope, chatType: "channel" })).toBe("deny");
  });
});
