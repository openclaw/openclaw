import { describe, expect, it, vi } from "vitest";
import {
  createAckReactionHandle,
  removeAckReactionHandleAfterReply,
  shouldAckReaction,
} from "./ack-reactions.js";

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
  const silent = { canDetectMention: false, effectiveWasMentioned: false };
  const direct = { ...silent, isDirect: true, isGroup: false, isMentionableGroup: false };
  const room = { inboundEventKind: "room_event" as const, effectiveWasMentioned: false };

  it("honors direct and group-all scopes", () => {
    expect(ack({ scope: "direct", ...direct })).toBe(true);
    expect(ack({ scope: "group-all", ...silent })).toBe(true);
  });
  it("skips when scope is off", () => {
    expect(ack({ scope: "off", isDirect: true })).toBe(false);
  });
  it.each([
    ["all", true],
    ["group-all", false],
  ] as const)("applies %s scope to ambient room events", (scope, expected) => {
    expect(ack({ scope, ...room })).toBe(expected);
  });
  it("defaults to group-mentions gating", () => {
    expect(ack({ scope: undefined })).toBe(true);
  });
  it("requires mention gating for group-mentions", () => {
    expect(ack({})).toBe(true);
    expect(ack({ canDetectMention: false })).toBe(false);
    expect(ack({ isMentionableGroup: false })).toBe(false);
    expect(ack({ effectiveWasMentioned: false })).toBe(false);
    expect(ack({ effectiveWasMentioned: false, shouldBypassMention: true })).toBe(true);
  });
});

function makeAck(overrides: Partial<Parameters<typeof createAckReactionHandle>[0]> = {}) {
  const params = {
    ackReactionValue: " 👀 ",
    send: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { ...params, handle: createAckReactionHandle(params) };
}

describe("createAckReactionHandle", () => {
  it("sends a trimmed ack and removes it after the reply", async () => {
    const { handle, send, remove } = makeAck();
    expect(handle?.ackReactionValue).toBe("👀");
    expect(handle?.remove).toBe(remove);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(handle?.ackReactionPromise).resolves.toBe(true);
    const onError = vi.fn();
    removeAckReactionHandleAfterReply({ removeAfterReply: true, onError, ackReaction: handle });
    await Promise.resolve();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("tracks a failed ack send without throwing", async () => {
    const error = new Error("nope");
    const onSendError = vi.fn();

    const { handle, remove } = makeAck({
      send: vi.fn().mockRejectedValue(error),
      onSendError,
    });

    await expect(handle?.ackReactionPromise).resolves.toBe(false);
    expect(onSendError).toHaveBeenCalledWith(error);
    removeAckReactionHandleAfterReply({ removeAfterReply: true, ackReaction: handle });
    await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();
  });

  it("skips empty ack values", () => {
    expect(makeAck({ ackReactionValue: " " }).handle).toBeNull();
  });
});
