import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSessionControllerSourceSettlement } from "../../../sessions/session-controller.mailbox.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createQueueTestRun } from "../queue.test-helpers.js";
import { enqueueFollowupRun } from "./enqueue.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  markFollowupRunEnqueued,
} from "./lifecycle.js";
import { clearFollowupQueue } from "./state.js";

afterEach(() => vi.useRealTimers());

describe("followup lifecycle heartbeat", () => {
  it("keeps the public deferral callback free of internal observation arguments", async () => {
    const lifecycle = { onAdopted: vi.fn(), onDeferred: vi.fn() };
    const run = {
      ...createQueueTestRun({ prompt: "deferred callback" }),
      turnAdoptionLifecycle: lifecycle,
    };
    try {
      expect(markFollowupRunEnqueued(run)).toBe(true);
      expect(lifecycle.onDeferred).toHaveBeenCalledExactlyOnceWith();
    } finally {
      completeFollowupRunLifecycle(run);
      await captureSessionControllerSourceSettlement(run.controllerInput!);
    }
  });

  it("retains message-ID-deduped source custody until abandonment actually settles", async () => {
    const key = "agent:main:dedupe-abandonment";
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const onSettled = vi.fn();
    const run = createQueueTestRun({ prompt: "queued", messageId: "source-1" });
    run.run.agentId = "main";
    run.run.sessionKey = key;
    run.turnAdoptionLifecycle = {
      onAdopted: () => {},
      onAbandoned: async () => {
        entered.resolve();
        await release.promise;
      },
      onSettled,
    };
    enqueueFollowupRun(key, run, { mode: "followup" }, "message-id");
    const input = run.controllerInput!;
    try {
      clearFollowupQueue(key, input.mailbox);
      await entered.promise;
      expect(onSettled).not.toHaveBeenCalled();
      release.resolve();
      await captureSessionControllerSourceSettlement(input);
      expect(onSettled).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await captureSessionControllerSourceSettlement(input);
    }
  });
  it("settles source cleanup when deferral publication throws", async () => {
    const release = createDeferredCore();
    const failure = new Error("deferral publication failed");
    const onSettled = vi.fn(() => release.promise);
    const run = createQueueTestRun({ prompt: "failed publication" });
    run.turnAdoptionLifecycle = {
      onAdopted: () => {},
      onDeferred: () => {
        throw failure;
      },
      onSettled,
    };
    let settled = false;
    try {
      expect(() =>
        enqueueFollowupRun("agent:main:failed-publication", run, { mode: "followup" }),
      ).toThrow(failure);
      const completion = captureSessionControllerSourceSettlement(
        expectDefined(run.controllerInput, "failed publication source"),
      );
      void completion.then(() => {
        settled = true;
      });
      expect(onSettled).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      release.resolve();
      await completion;
      expect(settled).toBe(true);
    } finally {
      release.resolve();
      if (run.controllerInput) {
        await captureSessionControllerSourceSettlement(run.controllerInput);
      }
    }
  });
  it("joins already-started admission before settling source custody", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const lifecycle = {
      onAdopted: async () => {
        entered.resolve();
        await release.promise;
      },
      onAbandoned: vi.fn(),
      onSettled: vi.fn(),
    };
    const run = {
      ...createQueueTestRun({ prompt: "custody race" }),
      turnAdoptionLifecycle: lifecycle,
    };
    const admission = admitFollowupRunLifecycle(run);
    try {
      await entered.promise;
      completeFollowupRunLifecycle(run);
      expect(lifecycle.onSettled).not.toHaveBeenCalled();
      release.resolve();
      await admission;
      await captureSessionControllerSourceSettlement(run.controllerInput!);
      expect(lifecycle.onSettled).toHaveBeenCalledOnce();
      expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await admission;
    }
  });

  it.each(["admitted", "completed", "aborted"] as const)(
    "does not start renewal for an already %s lifecycle",
    async (state) => {
      vi.useFakeTimers();
      const abort = new AbortController();
      const lifecycle = {
        admission: "exclusive" as const,
        abortSignal: abort.signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onDeferredHeartbeat: vi.fn(),
        deferredHeartbeatIntervalMs: 100,
        onAbandoned: vi.fn(),
      };
      const run = {
        ...createQueueTestRun({ prompt: "heartbeat" }),
        turnAdoptionLifecycle: lifecycle,
      };
      if (state === "admitted") {
        await admitFollowupRunLifecycle(run);
      } else if (state === "completed") {
        completeFollowupRunLifecycle(run);
      } else {
        abort.abort();
      }
      try {
        markFollowupRunEnqueued(run);
        await vi.advanceTimersByTimeAsync(500);
        expect(lifecycle.onDeferredHeartbeat).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        completeFollowupRunLifecycle(run);
      }
    },
  );
});
