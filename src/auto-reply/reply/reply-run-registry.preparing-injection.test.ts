import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import type {
  ReplyBackendHandle,
  ReplyMessageInjectionTarget,
  ReplyOperation,
} from "./reply-run-registry.contracts.js";
import { beginReplyMessageInjectionTarget } from "./reply-run-registry.message-injection.js";
import { createReplyOperation } from "./reply-run-registry.operation.js";
import { replyRunRegistry } from "./reply-run-registry.registry.js";
import { forceClearReplyOperation } from "./reply-run-registry.state.js";

const operations = new Set<ReplyOperation>();

afterEach(() => {
  for (const operation of operations) {
    operation.complete();
  }
  operations.clear();
  resetDiagnosticRunActivityForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function createOperation(sessionKey = "agent:main:preparing-steer") {
  const operation = createReplyOperation({
    sessionKey,
    sessionId: "preparing-session",
    resetTriggered: false,
  });
  operations.add(operation);
  return operation;
}

function capturePreparingTarget(operation: ReplyOperation) {
  const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key, {
    includePreparing: true,
  });
  if (!target?.waitForReady) {
    throw new Error("Expected a preparing injection target");
  }
  return { target, waitForReady: target.waitForReady.bind(target) };
}

function createBackend(runId = "first-backend") {
  const queueMessage = vi.fn(async () => {});
  const backend: ReplyBackendHandle = {
    kind: "embedded",
    runId,
    cancel: vi.fn(),
    messageInjection: { isAvailable: () => true, queueMessage },
  };
  return { backend, queueMessage };
}

function inject(target: ReplyMessageInjectionTarget) {
  return beginReplyMessageInjectionTarget(target, "prepared input").outcome;
}

describe("preparing reply injection targets", () => {
  it.each(["phase-first", "backend-first"] as const)(
    "requires both execution phase and backend publication (%s)",
    async (order) => {
      const operation = createOperation();
      const { backend, queueMessage } = createBackend();
      if (order === "backend-first") {
        operation.attachBackend(backend);
      }
      const { target, waitForReady } = capturePreparingTarget(operation);
      const waiting = waitForReady(new AbortController().signal);
      let published = false;
      void operation.backendReady.then(() => {
        published = true;
      });

      if (order === "phase-first") {
        operation.setPhase("running");
      }
      await Promise.resolve();
      expect(published).toBe(false);
      expect(queueMessage).not.toHaveBeenCalled();

      if (order === "phase-first") {
        operation.attachBackend(backend);
      } else {
        operation.setPhase("running");
      }
      await waiting;
      await expect(inject(target)).resolves.toEqual({ status: "accepted" });
      expect(queueMessage).toHaveBeenCalledExactlyOnceWith("prepared input", expect.any(Object));
      expect(target.runId).toBe("first-backend");
    },
  );

  it.each(["same backend", "replacement backend"] as const)(
    "retains the first ready backend through the injection boundary (%s)",
    async (outcome) => {
      const operation = createOperation();
      const { target, waitForReady } = capturePreparingTarget(operation);
      const first = createBackend();
      const replacement = createBackend("replacement-backend");
      operation.setPhase("running");
      operation.attachBackend(first.backend);
      await waitForReady(new AbortController().signal);

      if (outcome === "replacement backend") {
        operation.detachBackend(first.backend);
        operation.attachBackend(replacement.backend);
      }
      await expect(inject(target)).resolves.toMatchObject({
        status: outcome === "same backend" ? "accepted" : "rejected",
      });
      expect(first.queueMessage).toHaveBeenCalledTimes(outcome === "same backend" ? 1 : 0);
      expect(replacement.queueMessage).not.toHaveBeenCalled();
    },
  );

  it.each(["complete", "retained failure", "force clear", "abort", "rekey"] as const)(
    "settles a preparing reservation when its owner leaves (%s)",
    async (departure) => {
      vi.useFakeTimers();
      const operation = createOperation();
      const originalKey = operation.key;
      const { target, waitForReady } = capturePreparingTarget(operation);
      const waiting = waitForReady(new AbortController().signal);
      if (departure === "complete") {
        operation.complete();
      } else if (departure === "retained failure") {
        operation.retainFailureUntilComplete();
        operation.fail("run_failed", new Error("preparation failed"));
      } else if (departure === "force clear") {
        forceClearReplyOperation(operation);
      } else if (departure === "abort") {
        operation.abortByUser();
      } else {
        operation.updateSessionKey("agent:main:moved-preparing-steer");
      }
      await waiting;
      await expect(inject(target)).resolves.toMatchObject({ status: "rejected" });

      if (departure === "retained failure") {
        operation.complete();
      }
      const successor = createOperation(originalKey);
      const { backend, queueMessage } = createBackend("successor-backend");
      successor.setPhase("running");
      successor.attachBackend(backend);
      await expect(inject(target)).resolves.toMatchObject({ status: "rejected" });
      expect(queueMessage).not.toHaveBeenCalled();
    },
  );

  it("allows compaction lineage rotation and binds the original source after capture", async () => {
    const operation = createOperation();
    operation.setPhase("preflight_compacting");
    const { target, waitForReady } = capturePreparingTarget(operation);
    const { backend, queueMessage } = createBackend();
    const waiting = waitForReady(new AbortController().signal);

    operation.updateSessionId("compacted-session");
    operation.setPhase("running");
    replyRunRegistry.bindSourceTurnId(operation, "original-source-turn");
    operation.attachBackend(backend);

    await waiting;
    expect(target.sourceTurnId).toBe("original-source-turn");
    await expect(inject(target)).resolves.toEqual({ status: "accepted" });
    expect(queueMessage).toHaveBeenCalledOnce();
  });

  it("keeps preparing capture opt-in and does not manufacture an absent owner", () => {
    const operation = createOperation();
    expect(replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)).toBeUndefined();
    expect(
      replyRunRegistry.resolveCurrentMessageInjectionTarget("agent:main:no-owner", {
        includePreparing: true,
      }),
    ).toBeUndefined();
    capturePreparingTarget(operation);
    const { backend } = createBackend();
    operation.setPhase("running");
    operation.attachBackend(backend);
    expect(replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)).toMatchObject({
      runId: "first-backend",
    });
  });

  it("publishes readiness when an attached running owner resumes from global capacity wait", async () => {
    const operation = createOperation();
    operation.setPhase("running");
    operation.markWaitingForGlobalLane();
    const { target, waitForReady } = capturePreparingTarget(operation);
    const { backend, queueMessage } = createBackend();
    const waiting = waitForReady(new AbortController().signal);
    operation.attachBackend(backend);
    operation.markGlobalLaneWaitEnded();

    await waiting;
    await expect(inject(target)).resolves.toEqual({ status: "accepted" });
    expect(queueMessage).toHaveBeenCalledOnce();
  });

  it("cancels only the waiting source without withdrawing another source's reservation", async () => {
    const operation = createOperation();
    const cancelled = capturePreparingTarget(operation);
    const sibling = capturePreparingTarget(operation);
    const controller = new AbortController();
    const cancelledWait = cancelled.waitForReady(controller.signal);
    const cancellation = expect(cancelledWait).rejects.toMatchObject({ name: "AbortError" });
    const siblingWait = sibling.waitForReady(new AbortController().signal);
    controller.abort();
    await cancellation;

    const { backend, queueMessage } = createBackend();
    operation.setPhase("running");
    operation.attachBackend(backend);
    await siblingWait;
    await expect(inject(cancelled.target)).resolves.toMatchObject({ status: "rejected" });
    await expect(inject(sibling.target)).resolves.toEqual({ status: "accepted" });
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(operation.abortSignal.aborted).toBe(false);
  });
});
