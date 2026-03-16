import { describe, expect, it } from "vitest";
import {
  resolveFutureThreadParentSessionKey,
  resolveTelegramThreadParentSessionKey,
} from "./session-key-utils.js";

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

  it("derives parent for Telegram DM main-scoped thread keys when channel hint is telegram", () => {
    expect(
      resolveTelegramThreadParentSessionKey({
        sessionKey: "agent:main:main:thread:123456789:42",
        channelHint: "telegram",
      }),
    ).toBe("agent:main:main");
  });

  it("returns null for main-scoped thread keys without telegram channel hint", () => {
    expect(
      resolveTelegramThreadParentSessionKey({
        sessionKey: "agent:main:main:thread:123456789:42",
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

describe("resolveFutureThreadParentSessionKey", () => {
  it("uses explicit parent session key for non-suffixed thread session keys", () => {
    expect(
      resolveFutureThreadParentSessionKey({
        sessionKey: "agent:main:discord:channel:thread123",
        parentSessionKey: "agent:main:discord:channel:parent456",
      }),
    ).toBe("agent:main:discord:channel:parent456");
  });

  it("falls back to suffix-derived parent for non-Telegram thread keys", () => {
    expect(
      resolveFutureThreadParentSessionKey({
        sessionKey: "agent:main:slack:channel:c123:thread:1700000000.000100",
      }),
    ).toBe("agent:main:slack:channel:c123");
  });

  it("returns null for ambiguous main-scoped non-Telegram thread keys", () => {
    expect(
      resolveFutureThreadParentSessionKey({
        sessionKey: "agent:main:main:thread:123456789:42",
      }),
    ).toBeNull();
  });

  it("returns null for explicit parent on ambiguous main-scoped non-Telegram thread keys", () => {
    expect(
      resolveFutureThreadParentSessionKey({
        sessionKey: "agent:main:main:thread:123456789:42",
        parentSessionKey: "agent:main:main",
      }),
    ).toBeNull();
  });

  it("keeps Telegram main-scoped thread behavior when channel hint is telegram", () => {
    expect(
      resolveFutureThreadParentSessionKey({
        sessionKey: "agent:main:main:thread:123456789:42",
        channelHint: "telegram",
      }),
    ).toBe("agent:main:main");
  });
});
