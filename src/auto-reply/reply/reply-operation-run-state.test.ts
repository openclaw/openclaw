import { describe, expect, it, vi } from "vitest";
import { readCurrentTurnReplyCompletion } from "../../agents/current-turn-reply-completion.js";
import { createReplyTurnLedger } from "./dispatch-from-config.turn-ledger.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { createReplyOperationCompletionFixture } from "./reply-operation-completion.test-support.js";
import {
  recordReplyOperationAgentTurn,
  resolveReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { createReplyOperation } from "./reply-run-registry.js";

function createOwner() {
  return createReplyOperation({
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    resetTriggered: false,
  });
}

describe("reply operation current-turn completion", () => {
  it.each(["confirmed", "ambiguous", "pending"] as const)(
    "keeps authenticated %s separate from observed delivery",
    async (mode) => {
      const fixture = await createReplyOperationCompletionFixture(mode);
      const owner = createOwner();
      const state: ReplyOperationRunState = {};
      const deliver = vi.fn(async () => {});
      const dispatcher = createReplyDispatcher({ deliver });
      const ledger = createReplyTurnLedger(dispatcher);
      try {
        recordReplyOperationAgentTurn([state], owner, { kind: "rejected" }, fixture.receipt);
        ledger.recordCurrentTurnReplyCompletion(state.currentTurnReplyCompletion);
        expect(resolveReplyOperationAgentTurn(state)).toBe("failed");
        expect(ledger.mayHaveDelivered()).toBe(true);
        expect(ledger.canAttemptFallback()).toBe(false);
        expect(ledger.hasObservedDelivery()).toBe(mode === "confirmed");
        expect(ledger.hasPendingDelivery()).toBe(mode === "pending");
        expect(state.currentTurnReplyCompletion).not.toHaveProperty("sourceReplyDelivered");
        expect(fixture.receipt.sourceReplyDelivered).toBe(mode === "confirmed" ? true : undefined);
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        await fixture.settle();
        owner.complete();
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
    },
  );

  it("retains same-owner pending settlement through cleanup but clears it for a fresh owner", async () => {
    const fixture = await createReplyOperationCompletionFixture("pending");
    const owner = createOwner();
    let nextOwner: ReturnType<typeof createOwner> | undefined;
    const state: ReplyOperationRunState = {};
    const dispatcher = createReplyDispatcher({ deliver: async () => {} });
    const ledger = createReplyTurnLedger(dispatcher);
    try {
      recordReplyOperationAgentTurn([state], owner, { kind: "aborted" }, fixture.receipt);
      const carrier = state.currentTurnReplyCompletion;
      recordReplyOperationAgentTurn([state], owner);
      expect(state.currentTurnReplyCompletion).toBe(carrier);
      ledger.recordCurrentTurnReplyCompletion(carrier);
      expect(ledger.hasPendingDelivery()).toBe(true);
      await fixture.settle();
      expect(readCurrentTurnReplyCompletion(carrier)).toBe("ambiguous");
      expect(ledger.hasPendingDelivery()).toBe(false);
      expect(ledger.hasObservedDelivery()).toBe(false);
      expect(ledger.canAttemptFallback()).toBe(false);
      recordReplyOperationAgentTurn([state], undefined);
      expect(state.currentTurnReplyCompletion).toBeUndefined();
      recordReplyOperationAgentTurn([state], owner, { kind: "rejected" }, fixture.receipt);
      owner.complete();
      nextOwner = createOwner();
      recordReplyOperationAgentTurn([state], nextOwner, { kind: "rejected" });
      ledger.recordCurrentTurnReplyCompletion(state.currentTurnReplyCompletion);
      expect(state.currentTurnReplyCompletion).toBeUndefined();
      expect(ledger.canAttemptFallback()).toBe(true);
      expect(readCurrentTurnReplyCompletion(carrier)).toBe("ambiguous");
    } finally {
      await fixture.settle();
      owner.complete();
      nextOwner?.complete();
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
    }
  });

  it.each(["pre-dispatch", "forged", "spread"] as const)(
    "does not give %s metadata authority to suppress a fallback",
    async (mode) => {
      const fixture = await createReplyOperationCompletionFixture(mode);
      const owner = createOwner();
      const state: ReplyOperationRunState = {};
      const dispatcher = createReplyDispatcher({ deliver: async () => {} });
      const ledger = createReplyTurnLedger(dispatcher);
      try {
        const original = structuredClone(fixture.receipt);
        recordReplyOperationAgentTurn([state], owner, { kind: "rejected" }, fixture.receipt);
        ledger.recordCurrentTurnReplyCompletion(state.currentTurnReplyCompletion);
        expect(readCurrentTurnReplyCompletion(state.currentTurnReplyCompletion)).toBeUndefined();
        expect(ledger.mayHaveDelivered()).toBe(false);
        expect(ledger.hasObservedDelivery()).toBe(false);
        expect(ledger.canAttemptFallback()).toBe(true);
        expect(fixture.receipt).toEqual(original);
      } finally {
        await fixture.settle();
        owner.complete();
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
    },
  );
});
