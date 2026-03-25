import { describe, expect, it } from "vitest";
import { resolveGroupSessionKey } from "./group.js";

describe("resolveGroupSessionKey", () => {
  it("prefers the real provider encoded in agent-prefixed thread session keys", () => {
    const resolution = resolveGroupSessionKey({
      From: "agent:builder:slack:channel:C0ALJBZC606:thread:1773810043.005839",
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "channel",
    } as never);

    expect(resolution).toEqual({
      key: "slack:channel:c0aljbzc606:thread:1773810043.005839",
      channel: "slack",
      id: "c0aljbzc606:thread:1773810043.005839",
      chatType: "channel",
    });
  });

  it("still falls back to provider context for non-group agent-prefixed keys", () => {
    const resolution = resolveGroupSessionKey({
      From: "agent:main:main",
      Provider: "slack",
      Surface: "slack",
      ChatType: "channel",
    } as never);

    expect(resolution).toEqual({
      key: "slack:channel:agent:main:main",
      channel: "slack",
      id: "agent:main:main",
      chatType: "channel",
    });
  });

  it("falls back to the provider hint when an agent-prefixed key does not encode a group surface", () => {
    const resolution = resolveGroupSessionKey({
      From: "agent:main:main",
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "channel",
    } as never);

    expect(resolution).toEqual({
      key: "webchat:channel:agent:main:main",
      channel: "webchat",
      id: "agent:main:main",
      chatType: "channel",
    });
  });
});
