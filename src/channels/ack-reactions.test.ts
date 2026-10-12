import { describe, expect, it, vi } from "vitest";
import {
  createAckReactionHandle,
  removeAckReactionHandleAfterReply,
  removeAckReactionAfterReply,
  shouldAckReaction,
} from "./ack-reactions.js";

const flushMicrotasks = async () => {
  await Promise.resolve();
};

describe("shouldAckReaction", () => {
  const groupMentionsScope = {
    scope: "group-mentions" as const,
    isDirect: false,
    isGroup: true,
    isMentionableGroup: true,
    canDetectMention: true,
    effectiveWasMentioned: true,
  };

  it("honors direct and group-all scopes", () => {
    expect(
      shouldAckReaction({
        scope: "direct",
        isDirect: true,
        isGroup: false,
        isMentionableGroup: false,
        canDetectMention: false,
        effectiveWasMentioned: false,
      }),
    ).toBe(true);

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        scope: "group-all",
        canDetectMention: false,
        effectiveWasMentioned: false,
      }),
    ).toBe(true);
  });

  it("skips when scope is off", () => {
    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        scope: "off",
        isDirect: true,
      }),
    ).toBe(false);
  });

  it.each([
    ["all", true],
    ["group-all", false],
  ] as const)("applies %s scope to ambient room events", (scope, expected) => {
    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        scope,
        inboundEventKind: "room_event",
        effectiveWasMentioned: false,
      }),
    ).toBe(expected);
  });

  it("defaults to group-mentions gating", () => {
    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        scope: undefined,
      }),
    ).toBe(true);
  });

  it("requires mention gating for group-mentions", () => {
    // A group that answers every message still acks the ones addressing the
    // agent: whether the group requires a mention is a separate policy.
    expect(shouldAckReaction(groupMentionsScope)).toBe(true);

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        canDetectMention: false,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        isMentionableGroup: false,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        effectiveWasMentioned: false,
      }),
    ).toBe(false);

    expect(
      shouldAckReaction({
        ...groupMentionsScope,
        effectiveWasMentioned: false,
        shouldBypassMention: true,
      }),
    ).toBe(true);
  });
});

describe("createAckReactionHandle", () => {
  it("tracks a successful ack send", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);

    const handle = createAckReactionHandle({
      ackReactionValue: " 👀 ",
      send,
      remove,
    });

    expect(handle?.ackReactionValue).toBe("👀");
    expect(handle?.remove).toBe(remove);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(handle?.ackReactionPromise).resolves.toBe(true);
  });

  it("tracks a failed ack send without throwing", async () => {
    const error = new Error("nope");
    const onSendError = vi.fn();

    const handle = createAckReactionHandle({
      ackReactionValue: "👀",
      send: vi.fn().mockRejectedValue(error),
      remove: vi.fn().mockResolvedValue(undefined),
      onSendError,
    });

    await expect(handle?.ackReactionPromise).resolves.toBe(false);
    expect(onSendError).toHaveBeenCalledWith(error);
  });

  it("skips empty ack values", () => {
    const handle = createAckReactionHandle({
      ackReactionValue: " ",
      send: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    });

    expect(handle).toBeNull();
  });
});

describe("removeAckReactionAfterReply", () => {
  it("skips removal when ack did not happen", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    removeAckReactionAfterReply({
      removeAfterReply: true,
      ackReactionPromise: Promise.resolve(false),
      ackReactionValue: "👀",
      remove,
    });
    await flushMicrotasks();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("removeAckReactionHandleAfterReply", () => {
  it("removes through an ack handle", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    removeAckReactionHandleAfterReply({
      removeAfterReply: true,
      onError,
      ackReaction: {
        ackReactionPromise: Promise.resolve(true),
        ackReactionValue: "👀",
        remove,
      },
    });

    await flushMicrotasks();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
