import { describe, expect, it } from "vitest";

import { normalizeMediaUnderstandingChatType, resolveMediaUnderstandingScope } from "./scope.js";

describe("media understanding scope", () => {
  it("normalizes channel/room", () => {
    expect(normalizeMediaUnderstandingChatType("channel")).toBe("channel");
    expect(normalizeMediaUnderstandingChatType("room")).toBe("channel");
  });

  it("treats room match as channel", () => {
    const scope = {
      rules: [{ action: "deny", match: { chatType: "room" } }],
    } as const;

    expect(resolveMediaUnderstandingScope({ scope, chatType: "channel" })).toBe("deny");
  });

  it("matches channel chatType explicitly", () => {
    const scope = {
      rules: [{ action: "deny", match: { chatType: "channel" } }],
    } as const;

    expect(resolveMediaUnderstandingScope({ scope, chatType: "channel" })).toBe("deny");
  });
});

