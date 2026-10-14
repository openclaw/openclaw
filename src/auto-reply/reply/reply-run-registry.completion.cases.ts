import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  isReplyRunActiveForSessionId,
  replyRunRegistry,
  runAfterReplyOperationClear,
  waitForReplyOperationOwnerSettlement,
} from "./reply-run-registry.js";
import { expireStaleReplyOperation } from "./reply-run-registry.state.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";

export function registerReplyOperationCompletionCases(): void {
  it("runs registered callbacks after active state clears", () => {
    const operation = createTestReplyOperation({
      sessionId: "session-complete",
    });
    const afterClear = vi.fn(() => {
      expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
      expect(isReplyRunActiveForSessionId("session-complete")).toBe(false);
    });

    runAfterReplyOperationClear(operation, afterClear);
    operation.complete();

    expect(operation.result).toEqual({ kind: "completed" });
    expect(afterClear).toHaveBeenCalledTimes(1);
  });

  it("keeps owner settlement pending after stale expiry through its completion barrier", async () => {
    const operation = createTestReplyOperation({ sessionId: "session-stale-owner" });
    operation.setPhase("running");

    expect(expireStaleReplyOperation(operation, "stuck_recovery")).toBe(false);
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);

    const settlement = waitForReplyOperationOwnerSettlement(operation, 1_000);
    let settled = false;
    void settlement.then((value) => {
      settled = value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const { promise: completionBarrier, resolve: releaseCompletion } = createDeferred();
    operation.completeWithAfterClearBarrier(completionBarrier);
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseCompletion();
    await expect(settlement).resolves.toBe(true);
  });
}
