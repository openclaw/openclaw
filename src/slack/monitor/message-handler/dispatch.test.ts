import { describe, expect, it } from "vitest";
import { shouldSkipPinnedMainLastRouteUpdate } from "./dispatch.js";

describe("shouldSkipPinnedMainLastRouteUpdate", () => {
  it("skips only mismatched writes to the main session", () => {
    expect(
      shouldSkipPinnedMainLastRouteUpdate({
        pinnedMainDmOwner: "owner-1",
        senderRecipient: "sender-2",
        targetSessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
      }),
    ).toBe(true);
  });

  it("allows session-scoped writes even when sender differs from pinned owner", () => {
    expect(
      shouldSkipPinnedMainLastRouteUpdate({
        pinnedMainDmOwner: "owner-1",
        senderRecipient: "sender-2",
        targetSessionKey: "agent:main:slack:direct:sender-2",
        mainSessionKey: "agent:main:main",
      }),
    ).toBe(false);
  });
});
