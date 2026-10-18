import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createQueueSettings, createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import { completeFollowupRunLifecycle } from "../auto-reply/reply/queue/lifecycle.js";
import { clearFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  captureSessionControllerMailboxSummarySources,
  clearSessionControllerMailbox,
} from "./session-controller.mailbox-cleanup.js";
import { trackSessionControllerSourceWork } from "./session-controller.mailbox-source.js";
import {
  claimSessionControllerInput,
  getExistingSessionControllerMailbox,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  submitSessionControllerTask,
} from "./session-controller.mailbox.js";

it("notifies a native producer once when a full clear retains its pending cleanup", async () => {
  const key = `agent:main:mailbox-clear-native-${randomUUID()}`;
  const preceding = reserveSessionControllerSource(key, { policy: { mode: "followup" } });
  const cleanup = createDeferredCore();
  const events: string[] = [];
  const onCancelled = vi.fn(() => {
    events.push("cancelled");
  });
  const onSettled = vi.fn(() => {
    events.push("settling");
    return cleanup.promise;
  });
  const start = vi.fn();
  const admission = submitSessionControllerTask(key, { onCancelled, onSettled, start });
  const admissionResult = admission.catch((error: unknown) => error);
  const mailbox = preceding.mailbox;
  const input = mailbox.entries.find((entry) => entry !== preceding);
  if (!input) {
    throw new Error("Expected the queued native producer");
  }
  try {
    clearSessionControllerMailbox(mailbox, completeFollowupRunLifecycle);
    expect(onCancelled).toHaveBeenCalledOnce();
    expect(events).toEqual(["cancelled", "settling"]);
    expect(start).not.toHaveBeenCalled();
    expect(await admissionResult).toEqual(new Error("Session mailbox cleared"));
    expect(input.abortSignal.aborted).toBe(true);
    expect(mailbox.entries).toContain(input);

    clearSessionControllerMailbox(mailbox, completeFollowupRunLifecycle);
    expect(onCancelled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(mailbox.entries).toContain(input);
    cleanup.resolve();
    await input.settlement.promise;
    expect(mailbox.entries).not.toContain(input);
  } finally {
    cleanup.resolve();
    clearSessionControllerMailbox(mailbox, completeFollowupRunLifecycle);
    await input.settlement.promise;
  }
});

it.each([true, false])(
  "preserves unprocessed inputs after revocation (captured: %s)",
  async (captured) => {
    const key = `agent:main:mailbox-clear-${randomUUID()}`;
    const settings = createQueueSettings({ mode: "followup", cap: 2 });
    let current = true;
    const runs = ["first", "second", "third", "fourth"].map((prompt) => {
      const run = createQueueTestRun({ prompt });
      run.run.sessionKey = key;
      return run;
    });
    for (const run of runs) {
      enqueueFollowupRun(key, run, settings);
    }
    const inputs = runs.map((run) => {
      if (!run.controllerInput) {
        throw new Error("Expected an enqueued controller input");
      }
      return run.controllerInput;
    });
    const first = inputs[0]!;
    first.abortSignal.addEventListener("abort", () => {
      current = false;
    });
    const mailbox = first.mailbox;
    const remainingSummaries = captureSessionControllerMailboxSummarySources(mailbox).filter(
      (source) => source.controllerInput !== first,
    );
    const rawWork = createDeferredCore();
    trackSessionControllerSourceWork(first, rawWork.promise);
    try {
      expect(() =>
        clearSessionControllerMailbox(
          mailbox,
          completeFollowupRunLifecycle,
          captured ? inputs : undefined,
          () => {
            if (!current) {
              throw new Error("cancellation authority revoked");
            }
          },
        ),
      ).toThrow("cancellation authority revoked");
      expect(first.abortSignal.aborted).toBe(true);
      expect(first.retirementRequested).toBe(true);
      expect(mailbox.entries).toContain(first);
      for (const input of inputs.slice(1)) {
        expect(input.retirementRequested).not.toBe(true);
        expect(input.abortSignal.aborted).toBe(false);
        expect(mailbox.entries).toContain(input);
      }
      for (const run of runs.slice(1)) {
        expect(run.queueAbortSignal?.aborted).toBe(false);
      }
      expect(captureSessionControllerMailboxSummarySources(mailbox)).toEqual(remainingSummaries);
      rawWork.resolve();
      await first.settlement.promise;
      expect(mailbox.entries).not.toContain(first);
    } finally {
      rawWork.resolve();
      clearFollowupQueue(key, mailbox);
      await Promise.all(inputs.map((input) => input.settlement.promise));
    }
  },
);

it("keeps a reentrant successor outside the cleared mailbox generation", async () => {
  const key = `agent:main:mailbox-clear-reentrant-${randomUUID()}`;
  const first = createQueueTestRun({ prompt: "first" });
  const successor = createQueueTestRun({ prompt: "successor" });
  first.run.sessionKey = key;
  successor.run.sessionKey = key;
  const settings = createQueueSettings({ mode: "followup" });
  enqueueFollowupRun(key, first, settings);
  const input = first.controllerInput;
  if (!input) {
    throw new Error("Expected an enqueued controller input");
  }
  const mailbox = input.mailbox;
  input.abortSignal.addEventListener("abort", () => {
    enqueueFollowupRun(key, successor, settings);
  });
  try {
    clearSessionControllerMailbox(mailbox, completeFollowupRunLifecycle);
    const successorInput = successor.controllerInput;
    if (!successorInput) {
      throw new Error("Expected the reentrant successor to be enqueued");
    }
    expect(first.queueAbortSignal?.aborted).toBe(true);
    expect(successor.queueAbortSignal?.aborted).toBe(false);
    expect(successorInput.abortSignal.aborted).toBe(false);
    expect(successor.queueAbortSignal).not.toBe(first.queueAbortSignal);
    expect(mailbox.entries).not.toContain(input);
    expect(successorInput.mailbox.items).toEqual([successor]);
    expect(getExistingSessionControllerMailbox(key, successorInput.target)).toBe(
      successorInput.mailbox,
    );
    clearSessionControllerMailbox(mailbox, completeFollowupRunLifecycle, [input]);
    expect(successor.queueAbortSignal?.aborted).toBe(false);
    expect(successorInput.abortSignal.aborted).toBe(false);
    const claim = await claimSessionControllerInput(successor);
    expect(claim.sources).toEqual([successor]);
    releaseSessionControllerClaim(claim);
    await claim.settlement.promise;
  } finally {
    clearFollowupQueue(key, successor.controllerInput?.mailbox ?? mailbox);
  }
});
