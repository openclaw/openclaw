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
  const ack = (overrides: Partial<Parameters<typeof shouldAckReaction>[0]>) =>
    shouldAckReaction({ ...groupMentionsScope, ...overrides });

  it("honors direct and group-all scopes", () => {
    expect(
      ack({
        scope: "direct",
        isDirect: true,
        isGroup: false,
        isMentionableGroup: false,
        canDetectMention: false,
        effectiveWasMentioned: false,
      }),
    ).toBe(true);

    expect(ack({ scope: "group-all", canDetectMention: false, effectiveWasMentioned: false })).toBe(
      true,
    );
  });

  it("skips when scope is off", () => {
    expect(ack({ scope: "off", isDirect: true })).toBe(false);
  });

  it.each([
    ["all", true],
    ["group-all", false],
  ] as const)("applies %s scope to ambient room events", (scope, expected) => {
    expect(ack({ scope, inboundEventKind: "room_event", effectiveWasMentioned: false })).toBe(
      expected,
    );
  });

  it("defaults to group-mentions gating", () => {
    expect(ack({ scope: undefined })).toBe(true);
  });

  it("requires mention gating for group-mentions", () => {
    expect(shouldAckReaction(groupMentionsScope)).toBe(true);
    expect(ack({ canDetectMention: false })).toBe(false);
    expect(ack({ isMentionableGroup: false })).toBe(false);
    expect(ack({ effectiveWasMentioned: false })).toBe(false);
    expect(ack({ effectiveWasMentioned: false, shouldBypassMention: true })).toBe(true);
  });
});

describe("createAckReactionHandle", () => {
  it("tracks a successful ack send", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);

    const handle = createAckReactionHandle({ ackReactionValue: " 👀 ", send, remove });

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
