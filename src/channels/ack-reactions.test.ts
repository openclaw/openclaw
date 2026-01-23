import { describe, expect, it } from "vitest";

import { shouldAckReaction } from "./ack-reactions.js";

describe("shouldAckReaction", () => {
  it("honors direct and group-all scopes", () => {
    expect(
      shouldAckReaction({
        scope: "direct",
        isDirect: true,
        isGroup: false,
        isMentionableGroup: false,
        requireMention: false,
        canDetectMention: false,
        effectiveWasMentioned: false,
      }),
    ).toBe(true);

    expect(
      shouldAckReaction({
        scope: "group-all",
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: false,
        canDetectMention: false,
        effectiveWasMentioned: false,
      }),
    ).toBe(true);
  });

  it("skips when scope is off or none", () => {
    expect(
      shouldAckReaction({
        scope: "off",
        isDirect: true,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: true,
        canDetectMention: true,
        effectiveWasMentioned: true,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        scope: "none",
        isDirect: true,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: true,
        canDetectMention: true,
        effectiveWasMentioned: true,
      }),
    ).toBe(false);
  });

  it("defaults to group-mentions gating", () => {
    expect(
      shouldAckReaction({
        scope: undefined,
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: true,
        canDetectMention: true,
        effectiveWasMentioned: true,
      }),
    ).toBe(true);
  });

  it("requires mention gating for group-mentions", () => {
    expect(
      shouldAckReaction({
        scope: "group-mentions",
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: false,
        canDetectMention: true,
        effectiveWasMentioned: true,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        scope: "group-mentions",
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: true,
        canDetectMention: false,
        effectiveWasMentioned: true,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        scope: "group-mentions",
        isDirect: false,
        isGroup: true,
        isMentionableGroup: false,
        requireMention: true,
        canDetectMention: true,
        effectiveWasMentioned: true,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        scope: "group-mentions",
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: true,
        canDetectMention: true,
        effectiveWasMentioned: true,
      }),
    ).toBe(true);

    expect(
      shouldAckReaction({
        scope: "group-mentions",
        isDirect: false,
        isGroup: true,
        isMentionableGroup: true,
        requireMention: true,
        canDetectMention: true,
        effectiveWasMentioned: false,
        shouldBypassMention: true,
      }),
    ).toBe(true);
  });
});
