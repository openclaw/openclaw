import { describe, expect, it } from "vitest";
import {
  cancelPendingConversationTurn,
  claimPendingConversationTurnReply,
  registerPendingConversationTurn,
} from "./conversation-turns.js";

function register(conversationRef = "conv_a", signal?: AbortSignal) {
  return registerPendingConversationTurn({
    conversationRef,
    sessionId: "session-main",
    timeoutMs: 5_000,
    signal,
  });
}

describe("conversation turn correlation", () => {
  it("returns the stable operation id with an exact reply claim", async () => {
    const pending = registerPendingConversationTurn({
      id: "turn-alias",
      conversationRef: "conv_alias",
      sessionId: "session-main",
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("outbound-alias");
    pending.markReady();

    const claim = await claimPendingConversationTurnReply({
      conversationRef: "conv_alias",
      sessionId: "session-main",
      messageId: "inbound-alias",
      replyToId: "outbound-alias",
      text: "alias reply",
    });

    expect(claim?.turnId).toBe("turn-alias");
    claim?.complete();
    await expect(pending.wait()).resolves.toMatchObject({ text: "alias reply" });
  });

  it("matches a reply to the exact outbound transport message", async () => {
    const pending = register();
    pending.setOutboundMessageId("outbound-1");
    pending.markReady();

    const claim = await claimPendingConversationTurnReply({
      conversationRef: "conv_a",
      sessionId: "session-main",
      messageId: "inbound-1",
      replyToId: "outbound-1",
      text: "hello from peer",
    });
    expect(claim).toBeDefined();
    claim?.complete({ transcriptMessageId: "transcript-1" });

    await expect(pending.wait()).resolves.toMatchObject({
      messageId: "inbound-1",
      replyToId: "outbound-1",
      text: "hello from peer",
      transcriptMessageId: "transcript-1",
    });
  });

  it("matches a reply that promotes the outbound message into its own thread", async () => {
    const pending = register("conv_parent");
    pending.setOutboundMessageId("outbound-thread-root");
    pending.markReady();

    const claim = await claimPendingConversationTurnReply({
      conversationRef: "conv_child",
      parentConversationRef: "conv_parent",
      sessionId: "session-main",
      messageId: "inbound-thread-reply",
      replyToId: "outbound-thread-root",
      threadId: "outbound-thread-root",
      text: "threaded hello",
    });

    expect(claim).toBeDefined();
    claim?.complete();
    await expect(pending.wait()).resolves.toMatchObject({
      conversationRef: "conv_child",
      replyToId: "outbound-thread-root",
      threadId: "outbound-thread-root",
    });
  });

  it("does not promote a reply thread from a different conversation in a shared session", async () => {
    const pending = register("conv_peer_a");
    pending.setOutboundMessageId("outbound-peer-a");
    pending.markReady();

    await expect(
      claimPendingConversationTurnReply({
        conversationRef: "conv_peer_b_thread",
        parentConversationRef: "conv_peer_b",
        sessionId: "session-main",
        messageId: "inbound-peer-b",
        replyToId: "outbound-peer-a",
        threadId: "outbound-peer-a",
        text: "reply from the wrong peer",
      }),
    ).resolves.toBeUndefined();

    pending.cancel();
    await expect(pending.wait()).resolves.toBeUndefined();
  });

  it("releases a failed persistence claim for a transport retry", async () => {
    const pending = register();
    pending.setOutboundMessageId("outbound-retry");
    pending.markReady();

    const first = await claimPendingConversationTurnReply({
      conversationRef: "conv_a",
      sessionId: "session-main",
      messageId: "inbound-retry-1",
      replyToId: "outbound-retry",
      text: "first delivery",
    });
    expect(first).toBeDefined();
    first?.release();

    const retry = await claimPendingConversationTurnReply({
      conversationRef: "conv_a",
      sessionId: "session-main",
      messageId: "inbound-retry-2",
      replyToId: "outbound-retry",
      text: "retried delivery",
    });
    expect(retry).toBeDefined();
    retry?.complete();
    await expect(pending.wait()).resolves.toMatchObject({
      messageId: "inbound-retry-2",
      text: "retried delivery",
    });
  });

  it("does not guess between concurrent uncorrelated turns", async () => {
    const first = register();
    const second = register();
    first.setOutboundMessageId("outbound-1");
    second.setOutboundMessageId("outbound-2");
    first.markReady();
    second.markReady();

    await expect(
      claimPendingConversationTurnReply({
        conversationRef: "conv_a",
        sessionId: "session-main",
        messageId: "inbound-unknown",
        text: "ambiguous",
      }),
    ).resolves.toBeUndefined();

    const exact = await claimPendingConversationTurnReply({
      conversationRef: "conv_a",
      sessionId: "session-main",
      messageId: "inbound-2",
      replyToId: "outbound-2",
      text: "second",
    });
    exact?.complete();
    await expect(second.wait()).resolves.toMatchObject({ text: "second" });
    first.cancel();
    await expect(first.wait()).resolves.toBeUndefined();
  });

  it("does not consume an unsolicited message when only one turn is pending", async () => {
    const pending = register();
    pending.setOutboundMessageId("outbound-1");
    pending.markReady();
    await expect(
      claimPendingConversationTurnReply({
        conversationRef: "conv_a",
        sessionId: "session-main",
        messageId: "inbound-1",
        text: "unsolicited",
      }),
    ).resolves.toBeUndefined();
    pending.cancel();
    await expect(pending.wait()).resolves.toBeUndefined();
  });

  it("cancels immediately when its caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const pending = register("conv_aborted", controller.signal);
    pending.setOutboundMessageId("never-sent");
    await expect(pending.wait()).resolves.toBeUndefined();
  });

  it("stops consuming replies after Gateway cancellation", async () => {
    const pending = registerPendingConversationTurn({
      id: "cancelled-turn",
      conversationRef: "conv_cancelled",
      sessionId: "session-main",
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("outbound-cancelled");
    pending.markReady();

    expect(cancelPendingConversationTurn("cancelled-turn")).toBe(true);
    await expect(pending.wait()).resolves.toBeUndefined();
    await expect(
      claimPendingConversationTurnReply({
        conversationRef: "conv_cancelled",
        sessionId: "session-main",
        messageId: "inbound-after-cancel",
        replyToId: "outbound-cancelled",
        text: "dispatch me normally",
      }),
    ).resolves.toBeUndefined();
    expect(cancelPendingConversationTurn("cancelled-turn")).toBe(false);
  });

  it("gates an exact reply until outbound context is durable", async () => {
    const pending = register();
    pending.setOutboundMessageId("outbound-fast");
    const claimPromise = claimPendingConversationTurnReply({
      conversationRef: "conv_a",
      sessionId: "session-main",
      messageId: "inbound-fast",
      replyToId: "outbound-fast",
      text: "fast reply",
    });

    pending.markReady();
    const claim = await claimPromise;
    expect(claim).toBeDefined();
    claim?.complete();
    await expect(pending.wait()).resolves.toMatchObject({ text: "fast reply" });
  });

  it("does not wait on an unknown reply id while outbound delivery is unresolved", async () => {
    const pending = registerPendingConversationTurn({
      conversationRef: "conv_unresolved",
      sessionId: "session-main",
      timeoutMs: 10_000,
    });

    await expect(
      claimPendingConversationTurnReply({
        conversationRef: "conv_unresolved",
        sessionId: "session-main",
        messageId: "inbound-older-reply",
        replyToId: "older-outbound-id",
        text: "unrelated reply",
      }),
    ).resolves.toBeUndefined();
    pending.cancel();
    await expect(pending.wait()).resolves.toBeUndefined();
  });

  it("keeps the configured timeout active until reply persistence completes", async () => {
    const pending = registerPendingConversationTurn({
      conversationRef: "conv_slow_persist",
      sessionId: "session-main",
      timeoutMs: 1,
    });
    pending.setOutboundMessageId("outbound-slow");
    pending.markReady();
    const claim = await claimPendingConversationTurnReply({
      conversationRef: "conv_slow_persist",
      sessionId: "session-main",
      messageId: "inbound-slow",
      replyToId: "outbound-slow",
      text: "arrived before timeout",
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    await expect(pending.wait()).resolves.toBeUndefined();
    claim?.complete();
  });
});
