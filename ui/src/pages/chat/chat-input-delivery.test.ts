import { createSessionProjection } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import { createState } from "./chat-gateway.test-support.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { readChatInputDelivery } from "./chat-thread-items.ts";
import { publishChatSessionProjection } from "./history-merge.ts";
import { applyChatCacheSnapshot } from "./session-message-cache.ts";

function userMessage(runId: string, seq = 1) {
  return {
    role: "user",
    content: [{ type: "text", text: "Use the corrected numbers." }],
    __openclaw: { id: runId, idempotencyKey: `${runId}:user`, seq },
  };
}

function receipt(delivery: "read" | "unconfirmed" | "not-steered" = "read", seq = 1) {
  return {
    state: "input" as const,
    sessionKey: "main",
    runId: "source",
    targetRunId: "active",
    delivery,
    seq,
  };
}

describe("live steering input receipts", () => {
  it("marks only the exact source message read without taking over the active run", () => {
    const unrelated = userMessage("other", 2);
    const state = createState({
      chatRunId: "active",
      chatMessages: [userMessage("source"), unrelated],
    });
    expect(handleChatGatewayEvent(state, receipt())).toBe("input");
    expect(state.chatRunId).toBe("active");
    expect(state.chatMessages[0]).toMatchObject({
      __openclaw: { inputDelivery: { delivery: "read", targetRunId: "active" } },
    });
    expect(state.chatMessages[1]).toBe(unrelated);
  });

  it("does not mistake a transcript row or acknowledgement for Read", () => {
    const source = userMessage("source");
    const state = createState({ chatRunId: "active", chatMessages: [source] });
    handleChatGatewayEvent(state, {
      state: "status",
      sessionKey: "main",
      runId: "source",
      phase: "preparing_context",
      seq: 1,
    });
    expect(state.chatMessages[0]).toBe(source);
    expect(source["__openclaw"]).not.toHaveProperty("inputDelivery");
  });
  it("keeps rejected and uncertain outcomes distinct and never downgrades positive evidence", () => {
    const state = createState({ chatRunId: "active", chatMessages: [userMessage("source")] });
    handleChatGatewayEvent(state, receipt("not-steered", 1));
    expect(readChatInputDelivery(state.chatMessages[0])).toBe("not-steered");
    handleChatGatewayEvent(state, receipt("unconfirmed", 3));
    handleChatGatewayEvent(state, receipt("read", 2));
    expect(readChatInputDelivery(state.chatMessages[0])).toBe("unconfirmed");
    handleChatGatewayEvent(state, receipt("read", 4));
    const read = state.chatMessages[0];
    handleChatGatewayEvent(state, receipt("not-steered", 5));
    expect(state.chatMessages[0]).toBe(read);
    expect(readChatInputDelivery(read)).toBe("read");
  });

  it("ignores another session and does not claim a run when none is active", () => {
    const source = userMessage("source");
    const state = createState({ chatMessages: [source] });
    expect(handleChatGatewayEvent(state, { ...receipt(), sessionKey: "another" })).toBeNull();
    expect(state.chatMessages[0]).toBe(source);
    handleChatGatewayEvent(state, receipt());
    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
    expect(readChatInputDelivery(state.chatMessages[0])).toBe("read");
  });

  it("retains an early receipt through canonical replacement and reconnect history", () => {
    const state = createState({ currentSessionId: "physical", chatRunId: "active" });
    handleChatGatewayEvent(state, receipt());
    const scope = { sessionKey: "main", sessionId: "physical" };
    publishChatSessionProjection(state, createSessionProjection(scope, [userMessage("source")]));
    expect(readChatInputDelivery(state.chatMessages[0])).toBe("read");
    state.connectionEpoch = 2;
    publishChatSessionProjection(state, createSessionProjection(scope, [userMessage("source")]));
    expect(readChatInputDelivery(state.chatMessages[0])).toBe("read");
  });

  it.each([
    { sessionKey: "other", sessionId: "physical", activeLeafEntryId: null },
    { sessionKey: "main", sessionId: "replacement", activeLeafEntryId: null },
  ])("clears live evidence when the physical session scope changes: %j", (nextScope) => {
    const state = createState({
      currentSessionId: "physical",
      chatDisplayedLeafEntryId: null,
      chatMessages: [userMessage("source")],
    });
    handleChatGatewayEvent(state, receipt());
    publishChatSessionProjection(state, createSessionProjection(nextScope, state.chatMessages));
    expect(readChatInputDelivery(state.chatMessages[0])).toBeNull();
  });

  it("does not reconstruct a read receipt in a new pane or after reload", () => {
    const state = createState({ chatMessages: [userMessage("source")] });
    handleChatGatewayEvent(state, receipt());
    const cachedMessages = state.chatMessages;
    expect(readChatInputDelivery(cachedMessages[0])).toBe("read");
    const reloaded = createState();
    applyChatCacheSnapshot(reloaded, {
      messages: cachedMessages,
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: null,
    });
    expect(readChatInputDelivery(reloaded.chatMessages[0])).toBeNull();
    expect(readChatInputDelivery(cachedMessages[0])).toBe("read");
  });

  it("bounds receipts that arrive before their messages without polling", () => {
    const state = createState();
    for (let index = 0; index < 257; index++) {
      handleChatGatewayEvent(state, { ...receipt(), runId: String(index) });
    }
    publishChatSessionProjection(
      state,
      createSessionProjection({ sessionKey: "main" }, [userMessage("0"), userMessage("256", 2)]),
    );
    expect(readChatInputDelivery(state.chatMessages[0])).toBeNull();
    expect(readChatInputDelivery(state.chatMessages[1])).toBe("read");
  });

  it("does no transcript work for duplicate/out-of-order receipts on a long transcript", () => {
    let metadataReads = 0;
    const messages = Array.from({ length: 2000 }, (_, index) => {
      const message = userMessage(index === 1999 ? "source" : String(index), index + 1);
      const metadata = message["__openclaw"];
      Object.defineProperty(message, "__openclaw", {
        get: () => {
          metadataReads++;
          return metadata;
        },
        enumerable: true,
      });
      return message;
    });
    const state = createState({ chatMessages: messages });
    handleChatGatewayEvent(state, receipt("unconfirmed", 3));
    const published = state.chatMessages;
    metadataReads = 0;
    for (let index = 0; index < 50; index++) {
      handleChatGatewayEvent(state, receipt("unconfirmed", 3));
      handleChatGatewayEvent(state, receipt("read", 2));
    }
    expect(metadataReads).toBe(0);
    expect(state.chatMessages).toBe(published);
    expect(state.chatMessages[0]).toBe(messages[0]);
  });

  it("adds no transcript reads to ordinary streaming after a receipt", () => {
    function fixture() {
      let reads = 0;
      const messages = Array.from({ length: 2000 }, (_, index) => {
        const message = userMessage(index === 1999 ? "source" : String(index), index + 1);
        const metadata = message["__openclaw"];
        Object.defineProperty(message, "__openclaw", {
          get: () => {
            reads++;
            return metadata;
          },
          enumerable: true,
        });
        return message;
      });
      return {
        state: createState({ chatRunId: "active", chatMessages: messages }),
        reads: () => reads,
        reset: () => {
          reads = 0;
        },
      };
    }
    const baseline = fixture();
    const withReceipt = fixture();
    handleChatGatewayEvent(withReceipt.state, receipt());
    const delta = (seq: number) => ({
      state: "delta" as const,
      sessionKey: "main",
      runId: "active",
      seq,
      deltaText: "x",
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(seq) }] },
    });
    handleChatGatewayEvent(baseline.state, delta(1));
    handleChatGatewayEvent(withReceipt.state, delta(1));
    baseline.reset();
    withReceipt.reset();
    for (let seq = 2; seq <= 21; seq++) {
      handleChatGatewayEvent(baseline.state, delta(seq));
      handleChatGatewayEvent(withReceipt.state, delta(seq));
    }
    expect(withReceipt.reads()).toBeLessThanOrEqual(baseline.reads());
    expect(readChatInputDelivery(withReceipt.state.chatMessages.at(-1))).toBe("read");
  });
  it("retains source-specific read evidence when canonical history advances its leaf", () => {
    const state = createState({ currentSessionId: "physical", chatDisplayedLeafEntryId: "leaf-a" });
    const source = userMessage("source");
    applyChatCacheSnapshot(state, {
      messages: [source],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "physical",
      displayedLeafEntryId: "leaf-a",
    });
    handleChatGatewayEvent(state, receipt());
    applyChatCacheSnapshot(state, {
      messages: [
        source,
        {
          role: "assistant",
          content: [{ type: "text", text: "Continuing with the correction." }],
          __openclaw: { id: "leaf-b", seq: 2 },
        },
      ],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "physical",
      displayedLeafEntryId: "leaf-b",
    });
    expect(readChatInputDelivery(state.chatMessages[0])).toBe("read");
  });

  it("does not lend a retained receipt to another branch's different source", () => {
    const state = createState({
      currentSessionId: "physical",
      chatDisplayedLeafEntryId: "leaf-a",
      chatMessages: [userMessage("source")],
    });
    handleChatGatewayEvent(state, receipt());
    applyChatCacheSnapshot(state, {
      messages: [userMessage("different-source")],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "physical",
      displayedLeafEntryId: "branch-b",
    });
    expect(readChatInputDelivery(state.chatMessages[0])).toBeNull();
    applyChatCacheSnapshot(state, {
      messages: [userMessage("source")],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "physical",
      displayedLeafEntryId: "leaf-a",
    });
    expect(readChatInputDelivery(state.chatMessages[0])).toBe("read");
  });
});
