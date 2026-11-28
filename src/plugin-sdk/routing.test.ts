import { describe, expect, it } from "vitest";
import { deriveSessionChatTypeFromKey, type SessionKeyChatType } from "./routing.js";

describe("deriveSessionChatTypeFromKey", () => {
  it.each([
    ["agent:main:direct:user-1", "direct"],
    ["agent:main:dm:alice", "direct"],
    ["direct:alice", "direct"],
    ["agent:main:whatsapp:group:group-1", "group"],
    ["agent:main:slack:channel:c123", "channel"],
    ["agent:main:slack:account-1:direct:user-1", "direct"],
    ["group:old-group", "group"],
    ["channel:old-channel", "channel"],
    ["123@g.us", "group"],
    ["", "unknown"],
    [undefined, "unknown"],
    [null, "unknown"],
    ["unrelated-key", "unknown"],
  ])("classifies %j as %s", (sessionKey, expected) => {
    const chatType: SessionKeyChatType = deriveSessionChatTypeFromKey(sessionKey);
    expect(chatType).toBe(expected);
  });

  it("honors plugin-supplied legacy fallbacks", () => {
    expect(
      deriveSessionChatTypeFromKey("acme:xyz", [
        (scopedSessionKey) => (scopedSessionKey === "acme:xyz" ? "group" : undefined),
      ]),
    ).toBe("group");
  });
});
