import { describe, expect, it } from "vitest";
import {
  isChatBubbleMode,
  normalizeChatBubbleSessionKeys,
  setChatBubbleMode,
} from "./chat-bubble-mode.ts";

describe("session speech bubbles", () => {
  it("defaults off and changes only the selected conversation", () => {
    const initial = { chatBubbleSessionKeys: ["agent:main:other"] };
    expect(isChatBubbleMode({}, "main")).toBe(false);
    const enabled = setChatBubbleMode(initial, "main", true);
    expect(enabled).toEqual({ chatBubbleSessionKeys: ["agent:main:other", "agent:main:main"] });
    expect(initial.chatBubbleSessionKeys).toEqual(["agent:main:other"]);
    expect(isChatBubbleMode(enabled, " Agent:MAIN:Main ")).toBe(true);
    expect(isChatBubbleMode(enabled, "agent:writer:main")).toBe(false);
    expect(setChatBubbleMode(enabled, "main", false)).toEqual(initial);
    expect(setChatBubbleMode(initial, "agent:main:other", false)).toEqual({
      chatBubbleSessionKeys: undefined,
    });
    expect(setChatBubbleMode(initial, " ", true)).toEqual({});
  });

  it("normalizes aliases without merging opaque channel identities", () => {
    const settings = {
      chatBubbleSessionKeys: [" main ", "AGENT:MAIN:MAIN", "agent:main:matrix:channel:!AbC:host"],
    };
    expect(normalizeChatBubbleSessionKeys(settings.chatBubbleSessionKeys)).toEqual([
      "agent:main:main",
      "agent:main:matrix:channel:!AbC:host",
    ]);
    expect(isChatBubbleMode(settings, "agent:main:matrix:channel:!abc:host")).toBe(false);
    expect(setChatBubbleMode(settings, "agent:main:main", false)).toEqual({
      chatBubbleSessionKeys: ["agent:main:matrix:channel:!AbC:host"],
    });
    expect(normalizeChatBubbleSessionKeys([null, 42, " "])).toBeUndefined();
    expect(normalizeChatBubbleSessionKeys(true)).toBeUndefined();
  });
});
