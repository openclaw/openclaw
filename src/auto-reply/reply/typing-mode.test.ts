import { describe, expect, it } from "vitest";

import { resolveTypingMode } from "./typing-mode.js";

describe("resolveTypingMode", () => {
  it("defaults to instant for direct chats", () => {
    expect(
      resolveTypingMode({
        configured: undefined,
        isGroupChat: false,
        wasMentioned: false,
        isHeartbeat: false,
      }),
    ).toBe("instant");
  });

  it("defaults to message for group chats without mentions", () => {
    expect(
      resolveTypingMode({
        configured: undefined,
        isGroupChat: true,
        wasMentioned: false,
        isHeartbeat: false,
      }),
    ).toBe("message");
  });

  it("defaults to instant for mentioned group chats", () => {
    expect(
      resolveTypingMode({
        configured: undefined,
        isGroupChat: true,
        wasMentioned: true,
        isHeartbeat: false,
      }),
    ).toBe("instant");
  });

  it("honors configured mode across contexts", () => {
    expect(
      resolveTypingMode({
        configured: "thinking",
        isGroupChat: false,
        wasMentioned: false,
        isHeartbeat: false,
      }),
    ).toBe("thinking");
    expect(
      resolveTypingMode({
        configured: "message",
        isGroupChat: true,
        wasMentioned: true,
        isHeartbeat: false,
      }),
    ).toBe("message");
  });

  it("forces never for heartbeat runs", () => {
    expect(
      resolveTypingMode({
        configured: "instant",
        isGroupChat: false,
        wasMentioned: false,
        isHeartbeat: true,
      }),
    ).toBe("never");
  });
});
