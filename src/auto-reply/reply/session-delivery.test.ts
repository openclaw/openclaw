import { describe, expect, it } from "vitest";
import { resolveSessionDeliveryRoute } from "./session-delivery.js";

const mainRoute = { sessionKey: "agent:samantha:main", isInterSession: true };

describe("inter-session lastRoute preservation (fixes #54441)", () => {
  it("inter-session message does NOT overwrite established Discord lastChannel", () => {
    expect(
      resolveSessionDeliveryRoute({
        originatingChannelRaw: "webchat",
        persistedLastChannel: "discord",
        sessionKey: "agent:samantha:main",
        isInterSession: true,
      }).channel,
    ).toBe("discord");
  });

  it("inter-session message does NOT overwrite established external lastTo", () => {
    expect(
      resolveSessionDeliveryRoute({
        originatingChannelRaw: "webchat",
        originatingToRaw: "session:somekey",
        toRaw: "session:somekey",
        persistedLastTo: "channel:1234567890",
        persistedLastChannel: "discord",
        ...mainRoute,
      }).to,
    ).toBe("channel:1234567890");
  });

  it("regular Discord user message DOES update lastChannel normally", () => {
    expect(
      resolveSessionDeliveryRoute({
        originatingChannelRaw: "discord",
        persistedLastChannel: "discord",
        sessionKey: "agent:main:discord:channel:123",
        isInterSession: false,
      }).channel,
    ).toBe("discord");
  });

  it("inter-session on a NEW session (no persisted external route) may set webchat", () => {
    const result = resolveSessionDeliveryRoute({
      ...mainRoute,
      originatingChannelRaw: "webchat",
      persistedLastChannel: undefined,
    }).channel;
    expect(["webchat", undefined]).toContain(result);
  });

  it("inter-session on session with no persisted lastTo preserves session route", () => {
    const result = resolveSessionDeliveryRoute({
      originatingChannelRaw: "webchat",
      originatingToRaw: "session:somekey",
      toRaw: "session:somekey",
      persistedLastTo: undefined,
      persistedLastChannel: undefined,
      sessionKey: "agent:samantha:main",
      isInterSession: true,
    }).to;
    // No external route — falls through to normal resolution
    expect(["session:somekey", undefined]).toContain(result);
  });
});

describe("internal turns on a channel-only external route (#203484)", () => {
  it.each([false, true])(
    "keeps the session key out of the Telegram target (inter-session: %s)",
    (isInterSession) => {
      // A route stored with a channel but no target must not adopt the WebChat turn's
      // session-key address; that pair makes every later completion fail at Telegram.
      expect(
        resolveSessionDeliveryRoute({
          originatingChannelRaw: "webchat",
          originatingToRaw: "agent:main:build",
          persistedLastChannel: "telegram",
          sessionKey: "agent:main:build",
          isInterSession,
        }),
      ).toEqual({ channel: "telegram", to: undefined });
    },
  );

  it("still takes the target from an external turn on that route", () => {
    expect(
      resolveSessionDeliveryRoute({
        originatingChannelRaw: "telegram",
        originatingToRaw: "telegram:12345",
        persistedLastChannel: "telegram",
        sessionKey: "agent:main:build",
      }),
    ).toEqual({ channel: "telegram", to: "telegram:12345" });
  });
});

describe("session delivery direct-session routing overrides", () => {
  it.each(["agent:main:direct:user-1", "agent:main:telegram:account-a:direct:123456:topic:ops"])(
    "preserves persisted external route when webchat accesses channel-peer session %s (fixes #47745)",
    (sessionKey) => {
      // Webchat/dashboard viewing an external-channel session must not overwrite
      // the delivery route — subagents must still deliver to the original channel.
      expect(
        resolveSessionDeliveryRoute({
          originatingChannelRaw: "webchat",
          originatingToRaw: "session:dashboard",
          persistedLastChannel: "telegram",
          persistedLastTo: "123456",
          sessionKey,
        }),
      ).toEqual({ channel: "telegram", to: "123456" });
    },
  );

  it.each(["agent:main:subagent:worker:direct:user-1"])(
    "keeps persisted external routes for malformed direct-like key %s",
    (sessionKey) => {
      expect(
        resolveSessionDeliveryRoute({
          originatingChannelRaw: "webchat",
          originatingToRaw: "session:dashboard",
          persistedLastChannel: "telegram",
          persistedLastTo: "group:12345",
          sessionKey,
        }),
      ).toEqual({ channel: "telegram", to: "group:12345" });
    },
  );
});
