import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
  getActiveNativeAttempt,
  type EmbeddedAgentQueueHandle,
} from "../agents/embedded-agent-runner/run-state.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
  abortEmbeddedAgentRun,
  resolveActiveEmbeddedRunOwnerByRunId,
} from "../agents/embedded-agent-runner/runs.js";
import { testing as nativeTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import { SessionControllerAdmissionRequiredError } from "../agents/harness/errors.js";
import type { AgentHarnessAttemptParams } from "../plugin-sdk/agent-harness-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withSessionTurn } from "./session-controller.admission.js";
import type { ReplyBackendHandle, ReplyOperation } from "./session-controller.contracts.js";
import { abortActiveReplyRuns } from "./session-controller.js";
import { captureSessionTarget } from "./session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "./session-controller.mailbox.js";
import {
  beginReplyMessageInjectionTarget,
  captureReplyMessageInjectionTarget,
} from "./session-controller.message-injection.js";
import { waitForSessionRunEnd } from "./session-controller.native-runtime.js";
import { createReplyOperation } from "./session-controller.operation.js";
import { getActiveSessionRunCount, isSessionRunActive } from "./session-controller.queries.js";
import {
  getAttachedBackend,
  getSessionControllerEntryForOperation,
  getSessionControllerOperation,
} from "./session-controller.state.js";
import { testing as controllerTesting } from "./session-controller.test-support.js";

function handle(runId: string): EmbeddedAgentQueueHandle & ReplyBackendHandle {
  return {
    kind: "embedded",
    runId,
    queueMessage: vi.fn(async () => {}),
    isStreaming: () => true,
    isCompacting: () => false,
    abort: vi.fn(),
    cancel: vi.fn(),
  };
}

const sessionKey = "agent:main:controller-native";
const sessionId = "controller-native-session";
afterEach(() => {
  nativeTesting.resetActiveEmbeddedRuns();
  controllerTesting.resetSessionControllerForTest();
});

describe("controller/native admission boundary", () => {
  it.each([false, true])(
    "keeps the released turn kind while preserving direct injection policy (commit support=%s)",
    async (supportsTranscriptCommitWait) => {
      let released: NonNullable<AgentHarnessAttemptParams["replyOperation"]> | undefined;
      const native = { ...handle("direct-observation"), supportsTranscriptCommitWait };
      await withSessionTurn({ sessionKey, sessionId }, async (operation) => {
        if (!operation) {
          throw new Error("Expected an admitted native operation");
        }
        released = operation;
        const attachment = attachActiveEmbeddedRun(
          sessionId,
          native,
          sessionKey,
          undefined,
          "main",
          operation,
        );
        try {
          expect(released.turnKind).toBe("visible");
          expect(released.phase).toBe("running");
          const target = captureReplyMessageInjectionTarget(operation);
          if (!target) {
            throw new Error("Expected ordinary injection to remain available");
          }
          expect(native.queueMessage).not.toHaveBeenCalled();
          const ordinary = await beginReplyMessageInjectionTarget(target, "ordinary input");
          await expect(ordinary.outcome).resolves.toEqual({ status: "accepted" });
          expect(native.queueMessage).toHaveBeenCalledOnce();

          // Commit support is required only when the caller requests transcript waiting.
          const committed = await beginReplyMessageInjectionTarget(target, "committed input", {
            waitForTranscriptCommit: true,
          });
          await expect(committed.outcome).resolves.toEqual(
            supportsTranscriptCommitWait
              ? { status: "accepted" }
              : { status: "rejected", reason: "transcript_commit_wait_unsupported" },
          );
          expect(native.queueMessage).toHaveBeenCalledTimes(supportsTranscriptCommitWait ? 2 : 1);
        } finally {
          detachActiveEmbeddedRun(sessionId, native, undefined, undefined, undefined, attachment);
        }
      });
      expect(released?.turnKind).toBe("visible");
      expect(released?.phase).toBe("completed");
      expect(released?.result).toEqual({ kind: "completed" });
    },
  );

  it("borrows an input only in its admitted async context, not from a concurrent invocation", async () => {
    const input = reserveSessionControllerSource(sessionKey, { policy: { mode: "followup" } });
    const started = createDeferredCore();
    const finish = createDeferredCore();
    const admission = { sessionKey, sessionId, controllerInput: input };
    const duplicate = vi.fn(async () => {});
    const first = withSessionTurn(admission, async (operation) => {
      await withSessionTurn(admission, async (nested) => expect(nested).toBe(operation));
      started.resolve();
      await finish.promise;
    });
    try {
      await started.promise;
      await expect(withSessionTurn(admission, duplicate)).rejects.toThrow(/already.*admission/);
      expect(duplicate).not.toHaveBeenCalled();
      expect(getActiveSessionRunCount()).toBe(1);
    } finally {
      finish.resolve();
      await first;
      await input.settlement.promise;
    }
  });

  it("reserves direct work before backend registration and serializes another producer on that same turn", async () => {
    const release = createDeferredCore();
    const started = createDeferredCore();
    const secondStarted = vi.fn();
    const native = handle("first-native");
    let firstOperation: ReplyOperation | undefined;
    const first = withSessionTurn({ sessionKey, sessionId }, async (operation) => {
      firstOperation = operation;
      expect(getSessionControllerOperation(sessionKey)).toBe(operation);
      expect(isSessionRunActive(sessionId)).toBe(true);
      expect(operation?.phase).toBe("queued");
      expect(getActiveNativeAttempt(sessionId)).toBeUndefined();
      attachActiveEmbeddedRun(sessionId, native, sessionKey, undefined, "main", operation);
      expect(operation?.phase).toBe("running");
      started.resolve();
      await release.promise;
      detachActiveEmbeddedRun(sessionId, native);
    });
    await started.promise;
    const second = withSessionTurn({ sessionKey, sessionId }, async (operation) => {
      secondStarted();
      expect(operation).not.toBe(firstOperation);
      expect(getSessionControllerOperation(sessionKey)).toBe(operation);
    });
    await Promise.resolve();
    expect(secondStarted).not.toHaveBeenCalled();
    expect(getActiveSessionRunCount()).toBe(1);
    release.resolve();
    await Promise.all([first, second]);
    expect(secondStarted).toHaveBeenCalledOnce();
    expect(isSessionRunActive(sessionId)).toBe(false);
  });

  it("refuses unadmitted or stale registration even when native run IDs match", () => {
    const first = handle("reused-native-id");
    expect(() => attachActiveEmbeddedRun(sessionId, first, sessionKey)).toThrow(
      SessionControllerAdmissionRequiredError,
    );
    const old = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    attachActiveEmbeddedRun(sessionId, first, sessionKey, undefined, "main", old);
    detachActiveEmbeddedRun(sessionId, first);
    old.complete();
    const current = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    const replacement = handle("reused-native-id");
    attachActiveEmbeddedRun(sessionId, replacement, sessionKey, undefined, "main", current);
    expect(() =>
      attachActiveEmbeddedRun(sessionId, first, sessionKey, undefined, "main", old),
    ).toThrow(/admission/);
    detachActiveEmbeddedRun(sessionId, first);
    expect(getActiveNativeAttempt(sessionId)).toBe(replacement);
    expect(getSessionControllerOperation(sessionKey)).toBe(current);
    expect(replacement.cancel).not.toHaveBeenCalled();
    current.complete();
  });

  it("borrows one operation for retries and cannot let an old native detach retire its replacement", async () => {
    await withSessionTurn({ sessionKey, sessionId }, async (operation) => {
      const first = handle("reused-attempt");
      const second = handle("reused-attempt");
      const firstAttachment = attachActiveEmbeddedRun(
        sessionId,
        first,
        sessionKey,
        undefined,
        "main",
        operation,
      );
      if (!firstAttachment) {
        throw new Error("Missing first attachment");
      }
      expect(getSessionControllerEntryForOperation(operation!).attachment).toBe(firstAttachment);
      expect(ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get("reused-attempt")).toBe(firstAttachment);
      expect(getAttachedBackend(operation!)).toBe(first);
      expect(isSessionRunActive(sessionId)).toBe(true);
      expect(Boolean(getActiveNativeAttempt(sessionId)?.isStreaming())).toBe(true);
      expect(operation?.phase).toBe("running");
      expect(resolveActiveEmbeddedRunOwnerByRunId("reused-attempt")?.runId).toBe("reused-attempt");
      let firstSettled = false;
      void firstAttachment.settlement.promise.then(() => {
        firstSettled = true;
      });
      let secondAttachment: ReturnType<typeof attachActiveEmbeddedRun>;
      await withSessionTurn(
        { sessionKey, sessionId, replyOperation: operation },
        async (borrowed) => {
          expect(borrowed).toBe(operation);
          secondAttachment = attachActiveEmbeddedRun(
            sessionId,
            second,
            sessionKey,
            undefined,
            "main",
            borrowed,
          );
        },
      );
      if (!secondAttachment) {
        throw new Error("Missing replacement attachment");
      }
      expect(getSessionControllerEntryForOperation(operation!).attachment).toBe(secondAttachment);
      expect(ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get("reused-attempt")).toBe(secondAttachment);
      expect(getAttachedBackend(operation!)).toBe(second);
      detachActiveEmbeddedRun(sessionId, first);
      await Promise.resolve();
      expect(firstSettled).toBe(true);
      expect(getActiveNativeAttempt(sessionId)).toBe(second);
      expect(getSessionControllerOperation(sessionKey)).toBe(operation);
      expect(getActiveSessionRunCount()).toBe(1);
      expect(Boolean(getActiveNativeAttempt(sessionId)?.isStreaming())).toBe(true);
      expect(operation?.phase).toBe("running");
      detachActiveEmbeddedRun(sessionId, second, undefined, undefined, undefined, secondAttachment);
    });
    expect(getActiveSessionRunCount()).toBe(0);
    expect(isSessionRunActive(sessionId)).toBe(false);
    expect(getActiveNativeAttempt(sessionId)).toBeUndefined();
    expect(Boolean(getActiveNativeAttempt(sessionId)?.isStreaming())).toBe(false);
    expect(resolveActiveEmbeddedRunOwnerByRunId("reused-attempt")).toBeUndefined();
  });

  it("replaces the exact operation attachment when the session id is ambiguous", () => {
    const targetA = captureSessionTarget({
      storeScope: "/tmp/controller-native-a.sqlite",
      sessionKey,
      incarnation: sessionId,
    });
    const targetB = captureSessionTarget({
      storeScope: "/tmp/controller-native-b.sqlite",
      sessionKey,
      incarnation: sessionId,
    });
    const operationA = createReplyOperation({
      sessionKey,
      sessionId,
      target: targetA,
      resetTriggered: false,
    });
    const operationB = createReplyOperation({
      sessionKey,
      sessionId,
      target: targetB,
      resetTriggered: false,
    });
    const first = handle("ambiguous-a");
    const other = handle("ambiguous-b");
    const replacement = handle("ambiguous-a");
    const firstAttachment = attachActiveEmbeddedRun(
      sessionId,
      first,
      sessionKey,
      undefined,
      "main",
      operationA,
    );
    attachActiveEmbeddedRun(sessionId, other, sessionKey, undefined, "main", operationB);

    const replacementAttachment = attachActiveEmbeddedRun(
      sessionId,
      replacement,
      sessionKey,
      undefined,
      "main",
      operationA,
    );

    expect(replacementAttachment).not.toBe(firstAttachment);
    expect(getSessionControllerEntryForOperation(operationA).attachment).toBe(
      replacementAttachment,
    );
    expect(getSessionControllerEntryForOperation(operationB).attachment).toMatchObject({
      handle: other,
    });
    detachActiveEmbeddedRun(sessionId, first);
    expect(getSessionControllerEntryForOperation(operationA).attachment).toBe(
      replacementAttachment,
    );
    expect(ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get("ambiguous-a")).toBe(replacementAttachment);

    detachActiveEmbeddedRun(sessionId, replacement);
    detachActiveEmbeddedRun(sessionId, other);
    operationA.complete();
    operationB.complete();
  });

  it("does not include a synchronously admitted replacement in an already captured restart sweep", () => {
    const first = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    let successor: ReplyOperation | undefined;
    const replacement = handle("replacement-native");
    first.attachBackend({
      kind: "embedded",
      cancel: () => {
        first.complete();
        successor = createReplyOperation({
          sessionKey,
          sessionId: "replacement-session",
          resetTriggered: false,
        });
        attachActiveEmbeddedRun(
          "replacement-session",
          replacement,
          sessionKey,
          undefined,
          "main",
          successor,
        );
      },
    });
    first.setPhase("running");
    expect(abortActiveReplyRuns({ mode: "all" })).toBe(true);
    expect(getSessionControllerOperation(sessionKey)).toBe(successor);
    expect(successor?.result).toBeNull();
    expect(replacement.cancel).not.toHaveBeenCalled();
    successor?.complete();
  });

  it("cancels detached work by exact native identity and waits for its actual return", async () => {
    const native = handle("detached-abort");
    await withSessionTurn({ sessionId, detached: true }, async () => {
      attachActiveEmbeddedRun(sessionId, native);
      let settled = false;
      const ended = waitForSessionRunEnd(sessionId, null).then((value) => {
        settled = true;
        return value;
      });
      expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
      expect(native.abort).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(settled).toBe(false);
      detachActiveEmbeddedRun(sessionId, native);
      expect(await ended).toBe(true);
      expect(isSessionRunActive(sessionId)).toBe(false);
    });
  });

  it("retains native authority for detached work without projecting a session", async () => {
    const native = { ...handle("detached-run"), isAbortable: () => false };
    await withSessionTurn({ sessionId, detached: true }, async (operation) => {
      expect(operation).toBeUndefined();
      attachActiveEmbeddedRun(sessionId, native);
      expect(abortEmbeddedAgentRun(sessionId)).toBe(false);
      expect(native.abort).not.toHaveBeenCalled();
      expect(getActiveNativeAttempt(sessionId)).toBe(native);
      expect(isSessionRunActive(sessionId)).toBe(false);
      expect(getActiveSessionRunCount()).toBe(0);
      detachActiveEmbeddedRun(sessionId, native);
    });
  });

  it("hides detached attempts once a controller entry owns their session identity", async () => {
    const native = handle("detached-shadowed");
    await withSessionTurn({ sessionId, detached: true }, async () => {
      const attachment = attachActiveEmbeddedRun(sessionId, native);
      const input = reserveSessionControllerSource(sessionKey, {
        target: captureSessionTarget({
          storeScope: "/stores/detached-shadow.sqlite",
          sessionKey,
          incarnation: sessionId,
        }),
        policy: { mode: "followup" },
      });
      expect(getActiveNativeAttempt(sessionId)).toBeUndefined();
      detachActiveEmbeddedRun(sessionId, native, undefined, undefined, undefined, attachment);
      retireSessionControllerInput(input);
    });
  });
});
