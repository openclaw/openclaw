import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import { waitForReplyOperationBackend } from "./reply-run-registry.state.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";

describe("reply operation backend readiness", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
    resetDiagnosticRunActivityForTest();
  });

  it.each(["phase", "backend", "global-lane"] as const)(
    "waits for both startup facts (%s first)",
    async (first) => {
      const operation = createTestReplyOperation();
      const backend = { kind: "embedded" as const, cancel: vi.fn() };
      const markRunning = () => operation.setPhase("running");
      const attach = () => operation.attachBackend(backend);
      if (first === "global-lane") {
        markRunning();
        operation.markWaitingForGlobalLane();
        attach();
      } else {
        (first === "phase" ? markRunning : attach)();
      }
      const settled = vi.fn();
      const ready = waitForReplyOperationBackend(operation).then(settled);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      if (first === "global-lane") {
        operation.markGlobalLaneWaitEnded();
      } else {
        (first === "phase" ? attach : markRunning)();
      }
      await ready;
      expect(settled).toHaveBeenCalledExactlyOnceWith(true);
      operation.detachBackend(backend);
      await expect(waitForReplyOperationBackend(operation)).resolves.toBe(false);
      operation.complete();
    },
  );

  it("cancels a startup waiter without aborting the owner or another waiter", async () => {
    const operation = createTestReplyOperation();
    const source = new AbortController();
    const cancelled = waitForReplyOperationBackend(operation, source.signal);
    const retained = waitForReplyOperationBackend(operation);
    source.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(operation.abortSignal.aborted).toBe(false);
    expect(replyRunRegistry.get(operation.key)).toBe(operation);
    operation.attachBackend({ kind: "embedded", cancel: vi.fn() });
    operation.setPhase("running");
    await expect(retained).resolves.toBe(true);
    operation.complete();
  });

  it.each(["complete", "fail", "abort", "supersede"] as const)(
    "releases startup waiters when their owner ends via %s",
    async (outcome) => {
      const operation = createTestReplyOperation();
      const ready = waitForReplyOperationBackend(operation);
      if (outcome === "fail") {
        operation.fail("run_failed");
      } else if (outcome === "abort") {
        operation.abortByUser();
      } else if (outcome === "supersede") {
        operation.supersede();
      } else {
        operation.complete();
      }
      await expect(ready).resolves.toBe(false);
      operation.complete();
    },
  );

  it("keeps startup waiters bound to their key across rekey and replacement", async () => {
    const operation = createTestReplyOperation();
    const previousKey = operation.key;
    const oldWait = waitForReplyOperationBackend(operation);
    operation.updateSessionKey("agent:main:rekeyed");
    const movedWait = waitForReplyOperationBackend(operation);
    const replacement = createTestReplyOperation({ sessionKey: previousKey });
    replacement.setPhase("running");
    replacement.attachBackend({ kind: "embedded", cancel: vi.fn() });
    await expect(oldWait).resolves.toBe(false);
    operation.setPhase("running");
    operation.attachBackend({ kind: "embedded", cancel: vi.fn() });
    await expect(movedWait).resolves.toBe(true);
    operation.complete();
    replacement.complete();
  });

  it("does not revive an old startup waiter when its owner returns to the same key", async () => {
    const operation = createTestReplyOperation();
    const originalKey = operation.key;
    const retired = waitForReplyOperationBackend(operation);
    operation.updateSessionKey("agent:main:temporary-target");
    operation.updateSessionKey(originalKey);
    const current = waitForReplyOperationBackend(operation);
    operation.attachBackend({ kind: "embedded", cancel: vi.fn() });
    operation.setPhase("running");
    await expect(retired).resolves.toBe(false);
    await expect(current).resolves.toBe(true);
    operation.complete();
  });
});
