import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getSessionControllerOperation,
  resolveActiveReplyOperationForSessionId,
  runAfterReplyOperationClear,
  waitForReplyOperationOwnerSettlement,
} from "../../sessions/session-controller.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";

export function registerReplyOperationCompletionCases(): void {
  it("runs registered callbacks after active state clears", () => {
    const operation = createTestReplyOperation({
      sessionId: "session-complete",
    });
    const afterClear = vi.fn(() => {
      expect(getSessionControllerOperation("agent:main:main")).toBeUndefined();
      expect(resolveActiveReplyOperationForSessionId("session-complete")).toBeUndefined();
    });

    runAfterReplyOperationClear(operation, afterClear);
    operation.complete();

    expect(operation.result).toEqual({ kind: "completed" });
    expect(afterClear).toHaveBeenCalledTimes(1);
  });

  it("keeps owner settlement pending after stale expiry through its completion barrier", async () => {
    const operation = createTestReplyOperation({ sessionId: "session-stale-owner" });
    operation.setPhase("running");

    expect(operation.abortForStall()).toBe(true);
    expect(getSessionControllerOperation("agent:main:main")).toBe(operation);

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
