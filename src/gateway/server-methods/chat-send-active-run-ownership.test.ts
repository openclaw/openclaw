import { describe, expect, it } from "vitest";
import {
  createChatSendActiveRunOwnership,
  shouldFinalizeChatSendAsNonAgent,
  shouldTerminalizeDeferredChatSend,
} from "./chat-send-active-run-ownership.js";

describe("shouldFinalizeChatSendAsNonAgent", () => {
  it("keeps gateway fallback for plain non-agent replies", () => {
    expect(
      shouldFinalizeChatSendAsNonAgent({
        agentRunStarted: false,
        queuedFollowupEnqueued: false,
        activeRunTurnAdopted: false,
      }),
    ).toBe(true);
  });

  it("skips fallback after a steered turn is adopted by the active run", () => {
    expect(
      shouldFinalizeChatSendAsNonAgent({
        agentRunStarted: false,
        queuedFollowupEnqueued: false,
        activeRunTurnAdopted: true,
      }),
    ).toBe(false);
  });

  it("skips fallback when a followup was queued behind the active run", () => {
    expect(
      shouldFinalizeChatSendAsNonAgent({
        agentRunStarted: false,
        queuedFollowupEnqueued: true,
        activeRunTurnAdopted: false,
      }),
    ).toBe(false);
  });

  it("skips fallback once an agent run owns the turn", () => {
    expect(
      shouldFinalizeChatSendAsNonAgent({
        agentRunStarted: true,
        queuedFollowupEnqueued: false,
        activeRunTurnAdopted: false,
      }),
    ).toBe(false);
  });
});

describe("shouldTerminalizeDeferredChatSend", () => {
  it("terminalizes steered and queued admissions", () => {
    expect(
      shouldTerminalizeDeferredChatSend({
        queuedFollowupEnqueued: false,
        activeRunTurnAdopted: true,
      }),
    ).toBe(true);
    expect(
      shouldTerminalizeDeferredChatSend({
        queuedFollowupEnqueued: true,
        activeRunTurnAdopted: false,
      }),
    ).toBe(true);
  });

  it("leaves ordinary agent dispatches to their own finalizers", () => {
    expect(
      shouldTerminalizeDeferredChatSend({
        queuedFollowupEnqueued: false,
        activeRunTurnAdopted: false,
      }),
    ).toBe(false);
  });
});

describe("createChatSendActiveRunOwnership", () => {
  it("tracks steered adoption for post-dispatch decisions", () => {
    const ownership = createChatSendActiveRunOwnership();
    ownership.markActiveRunTurnAdopted();
    expect(ownership.shouldFinalizeAsNonAgent(false)).toBe(false);
    expect(ownership.shouldTerminalize()).toBe(true);
  });
});
