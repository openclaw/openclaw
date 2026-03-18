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
});
