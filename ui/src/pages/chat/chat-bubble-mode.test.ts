import { describe, expect, it } from "vitest";
import {
  isChatBubbleMode,
  normalizeChatBubbleSessionKeys,
  setChatBubbleMode,
} from "./chat-bubble-mode.ts";

describe("session speech bubbles", () => {
  it("gates all bubbles off and defaults only Home on when the lab is enabled", () => {
    for (const key of ["main", " Agent:MAIN:Main ", "agent:writer:main", "global"]) {
      expect(isChatBubbleMode({}, key)).toBe(false);
      expect(isChatBubbleMode({}, key, true)).toBe(true);
    }
    expect(isChatBubbleMode({}, "agent:writer:home", true, "home")).toBe(true);
    expect(isChatBubbleMode({}, "agent:writer:dashboard:task", true, "home")).toBe(false);
    expect(isChatBubbleMode({}, " ", true)).toBe(false);
  });

  it("retains explicit Home off and other-session on across lab disable and re-enable", () => {
    const initial = { chatBubbleSessionKeys: ["agent:main:other"] };
    const choices = { ...initial, ...setChatBubbleMode(initial, "main", false) };
    expect(initial.chatBubbleSessionKeys).toEqual(["agent:main:other"]);
    expect(choices.chatBubbleDisabledSessionKeys).toEqual(["agent:main:main"]);
    expect(isChatBubbleMode(choices, "main", true)).toBe(false);
    expect(isChatBubbleMode(choices, "agent:main:other", true)).toBe(true);
    expect(isChatBubbleMode(choices, "agent:main:other", false)).toBe(false);
    expect(isChatBubbleMode(choices, "agent:main:other", true)).toBe(true);
    const enabled = { ...choices, ...setChatBubbleMode(choices, "main", true) };
    expect(enabled.chatBubbleDisabledSessionKeys).toBeUndefined();
    expect(isChatBubbleMode(enabled, "main", true)).toBe(true);
    expect(setChatBubbleMode(enabled, " ", true)).toEqual({});
  });

  it("normalizes aliases without merging opaque channel identities", () => {
    const settings = {
      chatBubbleSessionKeys: [" main ", "AGENT:MAIN:MAIN", "agent:main:matrix:channel:!AbC:host"],
    };
    expect(normalizeChatBubbleSessionKeys(settings.chatBubbleSessionKeys)).toEqual([
      "agent:main:main",
      "agent:main:matrix:channel:!AbC:host",
    ]);
    expect(isChatBubbleMode(settings, "agent:main:matrix:channel:!abc:host", true)).toBe(false);
    expect(setChatBubbleMode(settings, "agent:main:main", false)).toEqual({
      chatBubbleSessionKeys: ["agent:main:matrix:channel:!AbC:host"],
      chatBubbleDisabledSessionKeys: ["agent:main:main"],
    });
    expect(normalizeChatBubbleSessionKeys([null, 42, " "])).toBeUndefined();
    expect(normalizeChatBubbleSessionKeys(true)).toBeUndefined();
  });
});
