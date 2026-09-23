import { beforeEach, expect, it, vi } from "vitest";
import type { SessionDeliveryObservation } from "../../infra/session-delivery-queue-runtime.js";
import { resetGeneratedMediaTaskActivityForTests } from "../../tasks/generated-media-task-activity.test-support.js";
import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
} from "./media-generate-background-shared.js";

const subagentAnnounceDeliveryMocks = vi.hoisted(() => ({
  deliverSubagentAnnouncement: vi.fn(),
  loadRequesterSessionEntry: vi.fn(() => ({ entry: undefined })),
}));
const detachedTaskRuntimeMocks = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  createRunningTaskRun: vi.fn(() => ({ taskId: "queued-media-task" })),
  failTaskRunByRunId: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
}));
const observer = vi.hoisted(() => ({ controller: new AbortController(), drained: false }));
vi.mock("../../infra/session-delivery-queue-runtime.js", () => ({
  observeSessionDeliveryRuntime: async <T>(
    run: (observation: SessionDeliveryObservation) => Promise<T>,
  ) =>
    await run({
      signal: observer.controller.signal,
      canReconcileAfterDrain: () => observer.drained,
    }),
}));
vi.mock("../subagents/announce/subagent-announce-delivery.js", () => subagentAnnounceDeliveryMocks);
vi.mock("../../tasks/detached-task-runtime.js", () => detachedTaskRuntimeMocks);
vi.mock("../../tasks/cron-run-continuation-cleanup.js", () => ({
  removeCronRunContinuationSessionIfIdle: async () => {},
}));

beforeEach(() => {
  observer.controller = new AbortController();
  observer.drained = false;
  resetGeneratedMediaTaskActivityForTests();
  vi.clearAllMocks();
  subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockReset();
});

function createImageMediaLifecycle() {
  return createMediaGenerationTaskLifecycle({
    toolName: "image_generate",
    taskKind: "image_generation",
    label: "Image generation",
    queuedProgressSummary: "Queued image generation",
    generatedLabel: "image",
    failureProgressSummary: "Image generation failed",
    eventSource: "image_generation",
    announceType: "image generation task",
    completionLabel: "image",
  });
}

it.each([false, true])(
  "records initial queue custody when shutdown overlaps admission (generation fails: %s)",
  async (generationFails) => {
    const lifecycle = createImageMediaLifecycle();
    const onWakeFailure = vi.fn();
    let background: Promise<void> | undefined;
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockImplementation(async () => {
      observer.controller.abort();
      return { delivered: false, disposition: "session_queued" };
    });
    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: lifecycle.createTaskRun({ sessionKey: "agent:main:admission-stop", prompt: "proof" }),
      scheduleBackgroundWork: (work) => {
        background = work();
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure,
      run: async () => {
        if (generationFails) {
          throw new Error("original generation failure");
        }
        return { provider: "fixture", model: "image", count: 1, wakeResult: "ready" };
      },
    });
    await background;
    expect(detachedTaskRuntimeMocks.recordTaskRunProgressByRunId).toHaveBeenLastCalledWith(
      expect.objectContaining({ progressSummary: "Media task finished; completion queued" }),
    );
    expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
    expect(detachedTaskRuntimeMocks.failTaskRunByRunId).not.toHaveBeenCalled();
    expect(onWakeFailure).not.toHaveBeenCalled();
    expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledOnce();
  },
);

it.each([
  { generationFails: false, permanentReadFailure: false },
  { generationFails: true, permanentReadFailure: false },
  { generationFails: false, permanentReadFailure: true },
  { generationFails: true, permanentReadFailure: true },
])(
  "bounds post-drain receipt retries and settles the task (generation fails: $generationFails, permanent read failure: $permanentReadFailure)",
  async ({ generationFails, permanentReadFailure }) => {
    vi.useFakeTimers();
    let background: Promise<void> | undefined;
    try {
      const lifecycle = createImageMediaLifecycle();
      const onWakeFailure = vi.fn();
      const generationError = new Error("original generation failure");
      const readError = new Error("settled receipt is unavailable");
      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
        delivered: false,
        disposition: "session_queued",
      });
      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle: lifecycle.createTaskRun({ sessionKey: "agent:main:receipt-stop", prompt: "proof" }),
        scheduleBackgroundWork: (work) => {
          background = work();
        },
        progressSummary: "Generating image",
        toolName: "Image generation",
        onWakeFailure,
        run: async () => {
          if (generationFails) {
            throw generationError;
          }
          return {
            provider: "fixture",
            model: "image",
            count: 1,
            wakeResult: "ready",
            attachments: [{ type: "image" as const, path: "/tmp/retained-proof.png" }],
          };
        },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockReset();
      if (permanentReadFailure) {
        subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockRejectedValue(readError);
      } else {
        subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement
          .mockRejectedValueOnce(readError)
          .mockResolvedValue({ delivered: true, disposition: "delivered" });
      }
      observer.drained = true;
      observer.controller.abort();
      await vi.advanceTimersByTimeAsync(10_000);
      await background;

      expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(
        permanentReadFailure ? 5 : 2,
      );
      if (generationFails) {
        expect(detachedTaskRuntimeMocks.failTaskRunByRunId).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ error: generationError.message }),
        );
        expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
      } else {
        expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining(
            permanentReadFailure
              ? {
                  terminalOutcome: "blocked",
                  terminalSummary: expect.stringContaining(readError.message),
                }
              : { terminalOutcome: undefined },
          ),
        );
        expect(detachedTaskRuntimeMocks.failTaskRunByRunId).not.toHaveBeenCalled();
      }
      expect(onWakeFailure).toHaveBeenCalledTimes(permanentReadFailure ? 1 : 0);
      const attempts = subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(
        attempts,
      );
    } finally {
      observer.controller.abort();
      await vi.advanceTimersByTimeAsync(10_000);
      await background;
      vi.useRealTimers();
    }
  },
);

it.each([
  { handoff: "failed", generationFails: false },
  { handoff: "unconfirmed", generationFails: false },
  { handoff: "accepted", generationFails: false },
  { handoff: "failed", generationFails: true },
  { handoff: "unconfirmed", generationFails: true },
  { handoff: "accepted", generationFails: true },
])(
  "requires queue acceptance before deferring terminal state on shutdown ($handoff, generation fails: $generationFails)",
  async ({ handoff, generationFails }) => {
    vi.useFakeTimers();
    let background: Promise<void> | undefined;
    try {
      const lifecycle = createImageMediaLifecycle();
      const onWakeFailure = vi.fn();
      const generationError = new Error("original generation failure");
      let attempts = 0;
      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockImplementation(async () => {
        if (++attempts === 1 && handoff === "accepted") {
          return { delivered: false, disposition: "session_queued" };
        }
        observer.controller.abort(new Error("queue runtime stopped"));
        if (handoff === "unconfirmed") {
          return { delivered: false, reason: "completion_handoff_pending" };
        }
        throw new Error("handoff store unavailable");
      });
      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle: lifecycle.createTaskRun({
          sessionKey: "agent:main:handoff-proof",
          prompt: "proof",
        }),
        scheduleBackgroundWork: (work) => {
          background = work();
        },
        progressSummary: "Generating image",
        toolName: "Image generation",
        onWakeFailure,
        run: async () => {
          if (generationFails) {
            throw generationError;
          }
          return {
            provider: "fixture",
            model: "image",
            count: 1,
            wakeResult: "ready",
            attachments: [{ type: "image" as const, path: "/tmp/retained-proof.png" }],
          };
        },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await background;
      if (handoff === "accepted") {
        expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
        expect(detachedTaskRuntimeMocks.failTaskRunByRunId).not.toHaveBeenCalled();
        expect(onWakeFailure).not.toHaveBeenCalled();
      } else {
        expect(onWakeFailure).toHaveBeenCalledOnce();
        if (generationFails) {
          expect(detachedTaskRuntimeMocks.failTaskRunByRunId).toHaveBeenCalledWith(
            expect.objectContaining({ error: generationError.message }),
          );
          expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
        } else {
          expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).toHaveBeenCalledWith(
            expect.objectContaining({
              terminalOutcome: "blocked",
              terminalSummary: expect.stringContaining('path="/tmp/retained-proof.png"'),
            }),
          );
          expect(detachedTaskRuntimeMocks.failTaskRunByRunId).not.toHaveBeenCalled();
        }
      }
    } finally {
      observer.controller.abort();
      await background;
      vi.useRealTimers();
    }
  },
);

it.each([
  {
    generationFails: false,
    deliveryFails: false,
    stopAfterDelivery: false,
    retireBeforeRead: false,
  },
  {
    generationFails: false,
    deliveryFails: true,
    stopAfterDelivery: false,
    retireBeforeRead: false,
  },
  {
    generationFails: true,
    deliveryFails: false,
    stopAfterDelivery: false,
    retireBeforeRead: false,
  },
  { generationFails: true, deliveryFails: true, stopAfterDelivery: false, retireBeforeRead: false },
  {
    generationFails: false,
    deliveryFails: false,
    stopAfterDelivery: true,
    retireBeforeRead: false,
  },
  { generationFails: true, deliveryFails: false, stopAfterDelivery: true, retireBeforeRead: false },
  {
    generationFails: false,
    deliveryFails: false,
    stopAfterDelivery: false,
    retireBeforeRead: true,
  },
  { generationFails: false, deliveryFails: true, stopAfterDelivery: false, retireBeforeRead: true },
  { generationFails: true, deliveryFails: false, stopAfterDelivery: false, retireBeforeRead: true },
  { generationFails: true, deliveryFails: true, stopAfterDelivery: false, retireBeforeRead: true },
])(
  "preserves late settlement (generation fails: $generationFails, delivery fails: $deliveryFails, stop after delivery: $stopAfterDelivery, retire before read: $retireBeforeRead)",
  async ({ generationFails, deliveryFails, stopAfterDelivery, retireBeforeRead }) => {
    vi.useFakeTimers();
    let backgroundWork: Promise<void> | undefined;
    try {
      const scheduled: Array<() => Promise<void>> = [];
      const onWakeFailure = vi.fn();
      const generationError = new Error("provider returned no images");
      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
        delivered: false,
        path: "queued",
        disposition: "session_queued",
      });
      const lifecycle = createImageMediaLifecycle();
      const handle = lifecycle.createTaskRun({
        sessionKey: "agent:main:discord:channel:123",
        prompt: "delayed queue proof",
      });
      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle,
        scheduleBackgroundWork: (work) => scheduled.push(work),
        progressSummary: "Generating image",
        toolName: "Image generation",
        onWakeFailure,
        run: async () => {
          if (generationFails) {
            throw generationError;
          }
          return {
            provider: "openai",
            model: "gpt-image-1",
            count: 1,
            wakeResult: "generated",
            attachments: [{ type: "image" as const, path: "/tmp/retained-proof.png" }],
          };
        },
      });
      backgroundWork = scheduled[0]?.();
      await vi.advanceTimersByTimeAsync(122_000);

      expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
      expect(detachedTaskRuntimeMocks.failTaskRunByRunId).not.toHaveBeenCalled();
      expect(onWakeFailure).not.toHaveBeenCalled();
      expect(detachedTaskRuntimeMocks.recordTaskRunProgressByRunId).toHaveBeenLastCalledWith(
        expect.objectContaining({ progressSummary: "Media task finished; completion queued" }),
      );
      expect(
        detachedTaskRuntimeMocks.recordTaskRunProgressByRunId.mock.calls.length,
      ).toBeLessThanOrEqual(generationFails ? 3 : 4);

      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockImplementation(async () => {
        if (stopAfterDelivery) {
          observer.controller.abort();
        }
        return deliveryFails
          ? { delivered: false, path: "queued", disposition: "permanent_failure" }
          : { delivered: true, path: "queued", disposition: "delivered" };
      });
      if (retireBeforeRead) {
        observer.drained = true;
        observer.controller.abort();
      }
      await vi.advanceTimersByTimeAsync(2_000);
      await backgroundWork;
      if (generationFails) {
        expect(detachedTaskRuntimeMocks.failTaskRunByRunId).toHaveBeenCalledWith(
          expect.objectContaining({ error: generationError.message }),
        );
        expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
      } else {
        expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).toHaveBeenCalledWith(
          expect.objectContaining(
            deliveryFails
              ? {
                  terminalOutcome: "blocked",
                  terminalSummary: expect.stringContaining('path="/tmp/retained-proof.png"'),
                }
              : { terminalOutcome: undefined },
          ),
        );
        expect(detachedTaskRuntimeMocks.failTaskRunByRunId).not.toHaveBeenCalled();
      }
    } finally {
      // Join the admitted waiter before restoring the clock, including assertion failures.
      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
        delivered: true,
        path: "queued",
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await backgroundWork;
      vi.useRealTimers();
    }
  },
);

it.each([false, true])(
  "stops the local waiter on shutdown without failing accepted delivery (generation failed: %s)",
  async (generationFails) => {
    vi.useFakeTimers();
    let backgroundWork: Promise<void> | undefined;
    try {
      const scheduled: Array<() => Promise<void>> = [];
      const lifecycle = createImageMediaLifecycle();
      const onWakeFailure = vi.fn();
      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
        delivered: false,
        disposition: "session_queued",
      });
      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle: lifecycle.createTaskRun({
          sessionKey: "agent:main:shutdown-proof",
          prompt: "proof",
        }),
        scheduleBackgroundWork: (work) => scheduled.push(work),
        progressSummary: "Generating image",
        toolName: "Image generation",
        onWakeFailure,
        run: async () => {
          if (generationFails) {
            throw new Error("provider generation failed");
          }
          return { provider: "fixture", model: "image", count: 1, wakeResult: "ready" };
        },
      });
      backgroundWork = scheduled[0]?.();
      await vi.advanceTimersByTimeAsync(1_000);
      observer.controller.abort();
      await backgroundWork;
      const attempts = subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(
        attempts,
      );
      expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
      expect(detachedTaskRuntimeMocks.failTaskRunByRunId).not.toHaveBeenCalled();
      expect(onWakeFailure).not.toHaveBeenCalled();
    } finally {
      observer.controller.abort();
      await backgroundWork;
      vi.useRealTimers();
    }
  },
);
