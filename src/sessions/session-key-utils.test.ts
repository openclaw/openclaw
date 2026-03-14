import { describe, expect, it } from "vitest";
import { resolveTelegramThreadParentSessionKey } from "./session-key-utils.js";

describe("resolveTelegramThreadParentSessionKey", () => {
  it("returns the derived parent for Telegram forum topics", () => {
    expect(
      resolveTelegramThreadParentSessionKey({
        sessionKey: "agent:main:telegram:group:-100123:topic:77",
      }),
    ).toBe("agent:main:telegram:group:-100123");
  });

  it("returns the derived parent for Telegram DM threaded sessions", () => {
    expect(
      resolveTelegramThreadParentSessionKey({
        sessionKey: "agent:main:telegram:default:direct:123:thread:987:42",
      }),
    ).toBe("agent:main:telegram:default:direct:123");
  });

  it("prefers explicit parent session key when provided", () => {
    expect(
      resolveTelegramThreadParentSessionKey({
        sessionKey: "agent:main:telegram:group:-100123:topic:77",
        parentSessionKey: "agent:main:telegram:group:-100123:topic:1",
      }),
    ).toBe("agent:main:telegram:group:-100123:topic:1");
  });

  it("returns null for non-Telegram sessions", () => {
    expect(
      resolveTelegramThreadParentSessionKey({
        sessionKey: "agent:main:discord:channel:123:thread:77",
      }),
    ).toBeNull();
  });

  it("returns null for Telegram non-thread sessions", () => {
    expect(
      resolveTelegramThreadParentSessionKey({
        sessionKey: "agent:main:telegram:group:-100123",
      }),
    ).toBeNull();
  });

  it("ignores explicit parent when it is a different Telegram chat scope", () => {
    expect(
      resolveTelegramThreadParentSessionKey({
        sessionKey: "agent:main:telegram:group:-100123:topic:77",
        parentSessionKey: "agent:main:telegram:group:-200456",
      }),
    ).toBe("agent:main:telegram:group:-100123");
  });

  it("ignores explicit parent when it is non-Telegram", () => {
    expect(
      resolveTelegramThreadParentSessionKey({
        sessionKey: "agent:main:telegram:group:-100123:topic:77",
        parentSessionKey: "agent:main:discord:channel:1",
      }),
    ).toBe("agent:main:telegram:group:-100123");
  });
});
