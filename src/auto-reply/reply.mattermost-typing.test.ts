import { describe, expect, it } from "vitest";
import { resolveTypingTtlMsForContext } from "./reply/get-reply.js";

describe("resolveTypingTtlMsForContext", () => {
  it("disables typing TTL for Mattermost direct messages", () => {
    expect(
      resolveTypingTtlMsForContext({
        Provider: "mattermost",
        Surface: "mattermost",
        ChatType: "direct",
      }),
    ).toBe(0);
  });

  it("keeps the default typing TTL for Mattermost channel messages", () => {
    expect(
      resolveTypingTtlMsForContext({
        Provider: "mattermost",
        Surface: "mattermost",
        ChatType: "channel",
      }),
    ).toBeUndefined();
  });

  it("keeps the default typing TTL for non-Mattermost direct messages", () => {
    expect(
      resolveTypingTtlMsForContext({
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "direct",
      }),
    ).toBeUndefined();
  });
});
