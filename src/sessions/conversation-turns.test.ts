import { expect, it } from "vitest";
import {
  cancelPendingConversationTurn,
  claimPendingConversationTurnReply,
  registerPendingConversationTurn,
} from "./conversation-turns.js";

function register(overrides: Partial<Parameters<typeof registerPendingConversationTurn>[0]> = {}) {
  return registerPendingConversationTurn({
    agentId: "main",
    conversationRef: "conv_a",
    sessionId: "session-main",
    timeoutMs: 5_000,
    ...overrides,
  });
}

function ready(outbound: string, overrides: Parameters<typeof register>[0] = {}) {
  const turn = register(overrides);
  turn.setOutboundMessageId(outbound);
  turn.markReady();
  return turn;
}

function claimReply(overrides: Partial<Parameters<typeof claimPendingConversationTurnReply>[0]>) {
  return claimPendingConversationTurnReply({
    agentId: "main",
    conversationRef: "conv_a",
    sessionId: "session-main",
    messageId: "inbound-1",
    text: "hello from peer",
    ...overrides,
  });
}

it.each(["complete", "release"] as const)(
  "does not let a released claim %s a successor claim",
  async (operation) => {
    const pending = ready("outbound-claim");
    const reply = (messageId: string) =>
      claimReply({ messageId, replyToId: "outbound-claim", text: messageId });
    try {
      const released = await reply("released-reply");
      expect(released).toBeDefined();
      released!.release();
      const successor = await reply("successor-reply");
      expect(successor).toBeDefined();
      released![operation]();
      if (operation === "release") {
        expect(await reply("third-reply")).toBeUndefined();
      }
      successor!.complete();
      await expect(pending.wait()).resolves.toMatchObject({ messageId: "successor-reply" });
    } finally {
      pending.cancel();
    }
  },
);

it("matches a reply to the exact outbound transport message", async () => {
  const pending = ready("outbound-1");
  const claim = await claimReply({ replyToId: "outbound-1" });
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
  const pending = ready("outbound-thread-root", { conversationRef: "conv_parent" });

  const claim = await claimReply({
    conversationRef: "conv_child",
    parentConversationRef: "conv_parent",
    replyToId: "outbound-thread-root",
    threadId: "outbound-thread-root",
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
  const pending = ready("outbound-peer-a", { conversationRef: "conv_peer_a" });

  await expect(
    claimReply({
      conversationRef: "conv_peer_b_thread",
      parentConversationRef: "conv_peer_b",
      replyToId: "outbound-peer-a",
      threadId: "outbound-peer-a",
    }),
  ).resolves.toBeUndefined();

  pending.cancel();
  await expect(pending.wait()).resolves.toBeUndefined();
});

it("does not guess between concurrent uncorrelated turns", async () => {
  const first = ready("outbound-1");
  const second = ready("outbound-2");

  await expect(claimReply({})).resolves.toBeUndefined();

  const exact = await claimReply({
    replyToId: "outbound-2",
    text: "second",
  });
  exact?.complete();
  await expect(second.wait()).resolves.toMatchObject({ text: "second" });
  first.cancel();
  await expect(first.wait()).resolves.toBeUndefined();
});

it("claims an exact reply without visiting unrelated pending turns", async () => {
  const turns = Array.from({ length: 64 }, (_, index) =>
    ready(`outbound-${index}`, {
      agentId: `agent-${index % 4}`,
      id: `turn-${index}`,
      conversationRef: `conv-${(index * 7) % 13}`,
      sessionId: `session-${(index * 11) % 17}`,
    }),
  );
  const registry: Map<unknown, unknown> | undefined = Object.getOwnPropertyDescriptor(
    globalThis,
    Symbol.for("openclaw.pendingConversationTurns"),
  )?.value;
  if (!registry) {
    throw new Error("pending-turn registry was not initialized");
  }
  const valuesDescriptor = Object.getOwnPropertyDescriptor(registry, "values");
  registry.values = () => {
    throw new Error("exact reply scanned the global pending-turn registry");
  };
  try {
    const target = 37;
    const claim = await claimReply({
      agentId: `agent-${target % 4}`,
      conversationRef: `conv-${(target * 7) % 13}`,
      sessionId: `session-${(target * 11) % 17}`,
      replyToId: `outbound-${target}`,
    });
    expect(claim?.turnId).toBe(`turn-${target}`);
    claim?.complete();
  } finally {
    if (valuesDescriptor) {
      Object.defineProperty(registry, "values", valuesDescriptor);
    } else {
      Reflect.deleteProperty(registry, "values");
    }
    for (const turn of turns) {
      turn.cancel();
    }
  }
});

it("isolates outbound id collisions and claims the oldest eligible turn", async () => {
  const collision = {
    agentId: "collision-agent",
    conversationRef: "collision-conv",
    sessionId: "collision-session",
  };
  const registerCollision = (id: string, sessionId = collision.sessionId) =>
    ready("provider-collision", { ...collision, id, sessionId });
  const wrongSession = registerCollision("wrong-session", "other-session");
  registerCollision("oldest-eligible");
  const newerEligible = registerCollision("newer-eligible");
  const claim = await claimReply({ ...collision, replyToId: "provider-collision" });
  expect(claim?.turnId).toBe("oldest-eligible");
  claim?.complete();
  wrongSession.cancel();
  newerEligible.cancel();
});

it("retires replaced and timed-out outbound index entries before turn id reuse", async () => {
  const replaced = register({ id: "replaced-turn", conversationRef: "conv_replaced" });
  replaced.setOutboundMessageId("outbound-old");
  replaced.setOutboundMessageId("outbound-new");
  replaced.markReady();
  await expect(
    claimReply({
      conversationRef: "conv_replaced",
      replyToId: "outbound-old",
    }),
  ).resolves.toBeUndefined();

  const retired = { id: "retired-turn", conversationRef: "conv_retired" };
  const expired = ready("outbound-retired", { ...retired, timeoutMs: 0 });
  await expect(expired.wait()).resolves.toBeUndefined();
  ready("outbound-retired", retired);
  const claim = await claimReply({
    conversationRef: "conv_retired",
    replyToId: "outbound-retired",
  });
  expect(claim?.turnId).toBe("retired-turn");
  claim?.complete();
  replaced.cancel();
});

it("cancels immediately when its caller is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const pending = register({ conversationRef: "conv_aborted", signal: controller.signal });
  pending.setOutboundMessageId("never-sent");
  await expect(pending.wait()).resolves.toBeUndefined();
});

it("stops consuming replies after Gateway cancellation", async () => {
  const pending = ready("outbound-cancelled", {
    id: "cancelled-turn",
    conversationRef: "conv_cancelled",
  });

  expect(cancelPendingConversationTurn({ agentId: "main", id: "cancelled-turn" })).toBe(true);
  await expect(pending.wait()).resolves.toBeUndefined();
  await expect(
    claimReply({
      conversationRef: "conv_cancelled",
      replyToId: "outbound-cancelled",
    }),
  ).resolves.toBeUndefined();
  expect(cancelPendingConversationTurn({ agentId: "main", id: "cancelled-turn" })).toBe(false);
});

it("ignores delayed handle writes after a turn id is reused", async () => {
  const identity = { id: "reused-turn", conversationRef: "conv_reused" };
  const first = register(identity);
  first.cancel();
  await expect(first.wait()).resolves.toBeUndefined();

  const replacement = register(identity);
  first.setOutboundMessageId("outbound-stale");
  first.markReady();
  replacement.setOutboundMessageId("outbound-current");
  replacement.markReady();

  const claim = await claimReply({
    conversationRef: "conv_reused",
    replyToId: "outbound-current",
    text: "current reply",
  });
  expect(claim).toBeDefined();
  claim?.complete();
  await expect(replacement.wait()).resolves.toMatchObject({ text: "current reply" });
});

it("isolates equal turn IDs between agents", async () => {
  const identity = {
    id: "shared-turn",
    conversationRef: "conv_shared",
    sessionId: "session-shared",
  };
  const first = register({ ...identity, agentId: "first-agent" });
  const second = register({ ...identity, agentId: "second-agent" });
  first.setOutboundMessageId("outbound-first");
  second.setOutboundMessageId("outbound-second");
  first.markReady();
  second.markReady();

  expect(cancelPendingConversationTurn({ agentId: "first-agent", id: "shared-turn" })).toBe(true);
  await expect(first.wait()).resolves.toBeUndefined();
  const claim = await claimReply({
    agentId: "second-agent",
    conversationRef: "conv_shared",
    sessionId: "session-shared",
    replyToId: "outbound-second",
    text: "second reply",
  });
  claim?.complete();
  await expect(second.wait()).resolves.toMatchObject({ text: "second reply" });
});

it("gates an exact reply until outbound context is durable", async () => {
  const pending = register();
  pending.setOutboundMessageId("outbound-fast");
  const claimPromise = claimReply({
    replyToId: "outbound-fast",
    text: "fast reply",
  });

  pending.markReady();
  const claim = await claimPromise;
  expect(claim).toBeDefined();
  claim?.complete();
  await expect(pending.wait()).resolves.toMatchObject({ text: "fast reply" });
});

it("keeps the configured timeout active until reply persistence completes", async () => {
  const pending = ready("outbound-slow", { conversationRef: "conv_slow_persist", timeoutMs: 1 });
  const claim = await claimReply({
    conversationRef: "conv_slow_persist",
    replyToId: "outbound-slow",
  });
  expect(claim).toBeDefined();
  await expect(pending.wait()).resolves.toBeUndefined();
  claim?.complete();
});
