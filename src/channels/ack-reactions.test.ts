import { afterEach, describe, expect, it, vi } from "vitest";
import { sleep } from "../utils.ts";
import {
  _clearPendingAckRemovals,
  _getPendingAckRemovalsSize,
  flushPendingAckRemovals,
  registerPendingAckRemoval,
  removeAckReactionAfterReply,
  shouldAckReaction,
  shouldAckReactionForWhatsApp,
} from "./ack-reactions.js";

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

describe("shouldAckReactionForWhatsApp", () => {
  it("respects direct and group modes", () => {
    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: true,
        isGroup: false,
        directEnabled: true,
        groupMode: "mentions",
        wasMentioned: false,
        groupActivated: false,
      }),
    ).toBe(true);

    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: true,
        isGroup: false,
        directEnabled: false,
        groupMode: "mentions",
        wasMentioned: false,
        groupActivated: false,
      }),
    ).toBe(false);

    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: false,
        isGroup: true,
        directEnabled: true,
        groupMode: "always",
        wasMentioned: false,
        groupActivated: false,
      }),
    ).toBe(true);

    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: false,
        isGroup: true,
        directEnabled: true,
        groupMode: "never",
        wasMentioned: true,
        groupActivated: true,
      }),
    ).toBe(false);
  });

  it("honors mentions or activation for group-mentions", () => {
    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: false,
        isGroup: true,
        directEnabled: true,
        groupMode: "mentions",
        wasMentioned: true,
        groupActivated: false,
      }),
    ).toBe(true);

    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: false,
        isGroup: true,
        directEnabled: true,
        groupMode: "mentions",
        wasMentioned: false,
        groupActivated: true,
      }),
    ).toBe(true);

    expect(
      shouldAckReactionForWhatsApp({
        emoji: "👀",
        isDirect: false,
        isGroup: true,
        directEnabled: true,
        groupMode: "mentions",
        wasMentioned: false,
        groupActivated: false,
      }),
    ).toBe(false);
  });
});

describe("pending ack removal registry", () => {
  afterEach(() => {
    _clearPendingAckRemovals();
  });

  it("registers and flushes a pending removal", () => {
    const remove = vi.fn();
    registerPendingAckRemoval("ts-1", remove);
    expect(_getPendingAckRemovalsSize()).toBe(1);

    flushPendingAckRemovals(["ts-1"]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(_getPendingAckRemovalsSize()).toBe(0);
  });

  it("flushes multiple pending removals at once", () => {
    const remove1 = vi.fn();
    const remove2 = vi.fn();
    registerPendingAckRemoval("ts-1", remove1);
    registerPendingAckRemoval("ts-2", remove2);

    flushPendingAckRemovals(["ts-1", "ts-2"]);
    expect(remove1).toHaveBeenCalledTimes(1);
    expect(remove2).toHaveBeenCalledTimes(1);
    expect(_getPendingAckRemovalsSize()).toBe(0);
  });

  it("ignores undefined and unknown messageIds without error", () => {
    const remove = vi.fn();
    registerPendingAckRemoval("ts-1", remove);

    flushPendingAckRemovals([undefined, "unknown-id"]);
    expect(remove).not.toHaveBeenCalled();
    expect(_getPendingAckRemovalsSize()).toBe(1);
  });

  it("does not invoke a removal twice on repeated flush", () => {
    const remove = vi.fn();
    registerPendingAckRemoval("ts-1", remove);

    flushPendingAckRemovals(["ts-1"]);
    flushPendingAckRemovals(["ts-1"]);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("latest registration wins for duplicate messageId", () => {
    const remove1 = vi.fn();
    const remove2 = vi.fn();
    registerPendingAckRemoval("ts-1", remove1);
    registerPendingAckRemoval("ts-1", remove2);

    flushPendingAckRemovals(["ts-1"]);
    expect(remove1).not.toHaveBeenCalled();
    expect(remove2).toHaveBeenCalledTimes(1);
  });
});

describe("removeAckReactionAfterReply", () => {
  it("removes only when ack succeeded", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    removeAckReactionAfterReply({
      removeAfterReply: true,
      ackReactionPromise: Promise.resolve(true),
      ackReactionValue: "👀",
      remove,
      onError,
    });
    await sleep(0);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("skips removal when ack did not happen", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    removeAckReactionAfterReply({
      removeAfterReply: true,
      ackReactionPromise: Promise.resolve(false),
      ackReactionValue: "👀",
      remove,
    });
    await sleep(0);
    expect(remove).not.toHaveBeenCalled();
  });

  it("skips when not configured", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    removeAckReactionAfterReply({
      removeAfterReply: false,
      ackReactionPromise: Promise.resolve(true),
      ackReactionValue: "👀",
      remove,
    });
    await sleep(0);
    expect(remove).not.toHaveBeenCalled();
  });
});
