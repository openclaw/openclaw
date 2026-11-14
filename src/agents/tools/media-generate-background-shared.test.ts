import assert from "node:assert/strict";
import {
  admitMediaHandle,
  resetGeneratedMediaTaskActivityForTests,
} from "../media-generation-activity.test-support.js";
vi.mock("../media-generation-activity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media-generation-activity.js")>();
  const { observeMediaActivity } =
    await import("../media-generation-activity.observer.test-support.js");
  return { ...observeMediaActivity(actual, detachedTaskRuntimeMocks) };
});
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { createContext as createGatewayContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { hasPendingGeneratedMediaTaskForSessionKey } from "../media-generation-activity.js";
import { createRequesterTranscriptWriter } from "../test-helpers/requester-transcript-writer.test-support.js";

const subagentAnnounceDeliveryMocks = vi.hoisted(() => ({
  deliverSubagentAnnouncement: vi.fn(),
}));
const detachedTaskRuntimeMocks = vi.hoisted(() => ({
  completeOperation: vi.fn(),
  createOperation: vi.fn(() => ({ taskId: "task-pinned-route" })),
  failOperation: vi.fn(),
  recordProgress: vi.fn(),
}));

const requesterEntry = (context: DeliveryContext): SessionEntry => ({
  sessionId: "media-requester",
  updatedAt: 1,
  delivery: normalizeSessionDeliveryState({ context }),
});
const cronContinuationCleanupMocks = vi.hoisted(() => ({
  removeCronRunContinuationSessionIfIdle: vi.fn(async () => {}),
}));
const sessionMocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn<() => SessionEntry | undefined>(() => undefined),
}));

vi.mock("../subagents/announce/subagent-announce-delivery.js", () => subagentAnnounceDeliveryMocks);
// mock-isolation: Keep requester routing fixtures outside the session database.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: async (_scope: unknown, assertCurrent: () => void) => {
    assertCurrent();
    return sessionMocks.loadSessionEntry();
  },
  withSessionEntryReadOnlyInWorker: async (
    _scope: unknown,
    assertCurrent: () => void,
    consume: (read: { ok: true; value: SessionEntry | undefined }) => Promise<unknown>,
  ) => {
    assertCurrent();
    return consume({ ok: true, value: sessionMocks.loadSessionEntry() });
  },
}));
vi.mock("../../cron/run-continuation-cleanup.js", () => cronContinuationCleanupMocks);

import {
  createDefaultMediaGenerateBackgroundScheduler,
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
} from "./media-generate-background-shared.js";

function expectCall(mock: unknown, fields: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));
}

it("runs genuinely detached work outside request-scoped async context", async () => {
  const requestContext = new AsyncLocalStorage<string>();
  const completed = createDeferredCore();
  const observedContexts: Array<string | undefined> = [];
  const scheduler = createDefaultMediaGenerateBackgroundScheduler({
    toolName: "image_generate",
    onCrash: vi.fn(),
  });

  requestContext.run("matrix-monitor-task", () => {
    scheduler(async () => {
      observedContexts.push(requestContext.getStore());
      completed.resolve();
    });
  });

  await completed.promise;
  expect(observedContexts).toEqual([undefined]);
});

beforeEach(() => {
  resetGeneratedMediaTaskActivityForTests();
  subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockReset();
  detachedTaskRuntimeMocks.createOperation.mockClear();
  detachedTaskRuntimeMocks.completeOperation.mockClear();
  detachedTaskRuntimeMocks.failOperation.mockClear();
  detachedTaskRuntimeMocks.recordProgress.mockClear();
  cronContinuationCleanupMocks.removeCronRunContinuationSessionIfIdle.mockClear();
  sessionMocks.loadSessionEntry
    .mockReset()
    .mockReturnValue({ sessionId: "media-requester", updatedAt: 1 });
});

afterEach(() => {
  vi.useRealTimers();
  clearRuntimeConfigSnapshot();
});

function createImageMediaLifecycle() {
  setRuntimeConfigSnapshot({});
  return createMediaGenerationTaskLifecycle("image");
}

type ScheduleOptions = Parameters<typeof scheduleMediaGenerationTaskCompletion>[0];

function mockLifecycle() {
  return {
    createTaskRun: vi.fn(),
    recordTaskProgress: vi.fn(),
    completeTaskRun: vi.fn(),
    failTaskRun: vi.fn(),
    wakeTaskCompletion: vi.fn<ScheduleOptions["lifecycle"]["wakeTaskCompletion"]>(async () => ({
      status: "delivered",
    })),
  };
}

function imageHandle(
  suffix: string,
  overrides: Partial<Parameters<typeof admitMediaHandle>[0]> = {},
) {
  return admitMediaHandle({
    taskId: "task-image-" + suffix,
    runId: "tool:image_generate:" + suffix,
    requesterSessionKey: "agent:main:discord:channel:123",
    taskLabel: "proof image",
    ...overrides,
  });
}

function generatedImageResult() {
  return { provider: "openai", model: "gpt-image-1", count: 1, wakeResult: "generated" };
}

function scheduleImageCompletion(
  params: Pick<ScheduleOptions, "lifecycle" | "handle" | "scheduleBackgroundWork"> &
    Partial<ScheduleOptions>,
) {
  scheduleMediaGenerationTaskCompletion({
    progressSummary: "Generating image",
    toolName: "Image generation",
    onWakeFailure: vi.fn(),
    run: async () => generatedImageResult(),
    ...params,
  });
}

function completionFixture(handle: ScheduleOptions["handle"]) {
  const lifecycle = mockLifecycle();
  const onWakeFailure = vi.fn();
  const scheduled: Array<() => Promise<void>> = [];
  return {
    lifecycle,
    onWakeFailure,
    scheduled,
    schedule: (options: Partial<ScheduleOptions> = {}) =>
      scheduleImageCompletion({
        lifecycle,
        onWakeFailure,
        handle,
        scheduleBackgroundWork: (work) => scheduled.push(work),
        ...options,
      }),
  };
}

describe("media generation detachment admission", () => {
  it.each([
    ["agent:main:cron:daily-media", true],
    ["agent:main:cron:daily-media:run:run-123", false],
    [undefined, undefined],
  ] as const)("admits %s with detach=%s", async (sessionKey, detach) => {
    const handle = await createImageMediaLifecycle().createTaskRun({
      sessionKey,
      prompt: "a synthetic lighthouse",
    });
    expect(handle?.detach).toBe(detach);
  });

  it("keeps exact cron media inline until a CLI resume binding is durable", async () => {
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    const entry: SessionEntry = {
      sessionId: "run-123",
      updatedAt: 1,
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "running",
        cliExecutionProvider: "google-gemini-cli",
      },
    };
    sessionMocks.loadSessionEntry.mockReturnValue(entry);
    const lifecycle = createImageMediaLifecycle();
    expect((await lifecycle.createTaskRun({ sessionKey, prompt: "before binding" }))?.detach).toBe(
      false,
    );

    sessionMocks.loadSessionEntry.mockReturnValue({
      ...entry,
      updatedAt: 2,
      cliSessionBindings: {
        "google-gemini-cli": { sessionId: "native-gemini-session" },
      },
    });
    expect((await lifecycle.createTaskRun({ sessionKey, prompt: "after binding" }))?.detach).toBe(
      true,
    );
  });
});

describe("scheduleMediaGenerationTaskCompletion", () => {
  it("keeps detached completion bound to its original live Gateway instance", async () => {
    const gateway = createGatewayContext();
    let currentGateway: GatewayRequestContext | undefined = gateway;
    const lifecycle = createImageMediaLifecycle();
    const handle = await withPluginRuntimeGatewayContextResolver(
      () => currentGateway,
      () => lifecycle.createTaskRun({ sessionKey: "agent:main:media", prompt: "proof image" }),
    );
    assert(handle);
    const completed = createDeferredCore();
    const onWakeFailure = vi.fn();
    const onCrash = vi.fn((error: string) => completed.reject(new Error(error)));
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockImplementationOnce(
      async (params: { resolveGatewayContext?: () => GatewayRequestContext | undefined }) => {
        expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
        expect(params.resolveGatewayContext?.()).toBe(gateway);
        currentGateway = createGatewayContext();
        expect(params.resolveGatewayContext?.()).toBeUndefined();
        return { delivered: true, path: "direct" };
      },
    );

    scheduleImageCompletion({
      lifecycle: {
        ...lifecycle,
        completeTaskRun: (params) => {
          lifecycle.completeTaskRun(params);
          completed.resolve();
        },
      },
      handle,
      onWakeFailure,
      scheduleBackgroundWork: createDefaultMediaGenerateBackgroundScheduler({
        toolName: "image_generate",
        onCrash,
      }),
    });
    await completed.promise;

    expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledOnce();
    expect(onWakeFailure).not.toHaveBeenCalled();
    expect(onCrash).not.toHaveBeenCalled();
  });

  it("runs detached completion outside a disposed requester transcript owner", async () => {
    const sessionKey = "agent:qa:image-generate";
    let disposed = false;
    const backgroundReady = createDeferredCore();
    let scheduled: Promise<void> | undefined;
    const { requesterTranscriptWrite, withRequesterTranscriptWrite } =
      createRequesterTranscriptWriter(() => disposed);
    const freshTranscriptWrite = vi.fn(async () => {});
    const wakeTaskCompletion = vi.fn(async () => {
      await runWithOwnedSessionTranscriptWrite({ sessionKey }, freshTranscriptWrite);
      return { status: "delivered" as const };
    });
    const completeTaskRun = vi.fn();
    const lifecycle = {
      ...mockLifecycle(),
      completeTaskRun,
      wakeTaskCompletion,
    };
    const run = vi.fn(async () => generatedImageResult());

    await withOwnedSessionTranscriptWrites(
      { sessionKey, withTranscriptWrite: withRequesterTranscriptWrite },
      async () => {
        scheduleImageCompletion({
          lifecycle,
          handle: admitMediaHandle({
            taskId: "task-image-disposed-owner",
            runId: "tool:image_generate:disposed-owner",
            requesterSessionKey: sessionKey,
            taskLabel: "QA lighthouse",
          }),
          scheduleBackgroundWork: (work) => {
            // Register under the attempt owner, then execute after it is disposed.
            scheduled = backgroundReady.promise.then(work);
          },
          run,
        });
      },
    );

    disposed = true;
    backgroundReady.resolve();
    assert(scheduled, "expected scheduled media work");
    await scheduled;

    expect(requesterTranscriptWrite).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(freshTranscriptWrite).toHaveBeenCalledOnce();
    expect(wakeTaskCompletion).toHaveBeenCalledOnce();
    expect(completeTaskRun).toHaveBeenCalledOnce();
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
  });

  it("keeps a pending generated-media run fresh until scheduled work settles", async () => {
    vi.useFakeTimers();
    const runResult = createDeferredCore<ReturnType<typeof generatedImageResult>>();
    const { scheduled, schedule } = completionFixture(imageHandle("123"));
    schedule({ run: () => runResult.promise });

    const task = scheduled[0]?.();
    assert(task, "expected scheduled media work");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(detachedTaskRuntimeMocks.recordProgress).toHaveBeenCalledWith({
      runId: "tool:image_generate:123",
      progressSummary: "Generating image",
    });

    runResult.resolve(generatedImageResult());
    await task;
    const callsAfterCompletion = detachedTaskRuntimeMocks.recordProgress.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(detachedTaskRuntimeMocks.recordProgress).toHaveBeenCalledTimes(callsAfterCompletion);
  });

  it("keeps a generated media task active until completion delivery finishes", async () => {
    // Mark completion only after the requester wake has been attempted; otherwise
    // task status can say done before the visible media reaches the requester.
    const order: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const completeTaskRun = vi.fn(() => {
      order.push("complete");
    });
    const lifecycle = {
      ...mockLifecycle(),
      recordTaskProgress: vi.fn(() => {
        order.push("progress");
      }),
      completeTaskRun,
      wakeTaskCompletion: vi.fn(async () => {
        order.push("wake");
        expect(completeTaskRun).not.toHaveBeenCalled();
        return { status: "delivered" as const };
      }),
    };

    scheduleImageCompletion({
      lifecycle,
      handle: imageHandle("123"),
      scheduleBackgroundWork: (work) => scheduled.push(work),
      run: async () => {
        order.push("run");
        return generatedImageResult();
      },
    });

    expect(scheduled).toHaveLength(1);
    await scheduled[0]?.();

    expect(order).toEqual(["run", "progress", "wake", "complete"]);
    expectCall(lifecycle.recordTaskProgress, {
      progressSummary: "Generated media; delivering completion",
    });
    expectCall(lifecycle.completeTaskRun, {
      count: 1,
      terminalResult: undefined,
    });
  });

  it.each([
    {
      label: "delivered",
      delivery: { delivered: true, path: "direct" },
      requesterOrigin: undefined,
      mediaUrls: undefined,
      terminal: { status: "succeeded" },
    },
    {
      label: "stale",
      delivery: {
        delivered: false,
        path: "direct",
        reason: "completion_handoff_unavailable",
        error: "cron run continuation owner was lost during gateway restart",
      },
      requesterOrigin: { channel: "discord", to: "channel:123" },
      mediaUrls: ["/tmp/proof.png"],
      terminal: {
        terminalOutcome: "blocked",
      },
    },
  ])(
    "cleans one-shot cron after $label completion without raw fallback",
    async ({ delivery, requesterOrigin, mediaUrls, terminal }) => {
      const sessionKey = "agent:main:cron:one-shot:run:run-123";
      const scheduled: Array<() => Promise<void>> = [];
      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce(delivery);
      const lifecycle = createImageMediaLifecycle();
      const handle = await lifecycle.createTaskRun({
        sessionKey,
        requesterOrigin,
        prompt: "proof image",
      });
      assert(handle);
      scheduleImageCompletion({
        lifecycle,
        handle,
        scheduleBackgroundWork: (work) => scheduled.push(work),
        run: async () => ({
          ...generatedImageResult(),
          attachments: [{ type: "image" as const, path: "/tmp/proof.png" }],
          ...(mediaUrls ? { mediaUrls } : {}),
        }),
      });
      await scheduled[0]?.();
      expectCall(detachedTaskRuntimeMocks.completeOperation, terminal);
      expect(
        cronContinuationCleanupMocks.removeCronRunContinuationSessionIfIdle,
      ).toHaveBeenCalledWith(sessionKey);
    },
  );
  it("keeps pending cron media active until a handoff retry delivers it", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    const scheduled: Array<() => Promise<void>> = [];
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement
      .mockResolvedValueOnce({
        delivered: false,
        path: "none",
        reason: "completion_handoff_pending",
        error: "cron run continuation is not ready",
      })
      .mockResolvedValueOnce({ delivered: true, path: "direct" });
    const lifecycle = createImageMediaLifecycle();
    const handle = await lifecycle.createTaskRun({
      sessionKey,
      prompt: "proof image",
    });
    assert(handle);

    scheduleImageCompletion({
      lifecycle,
      handle,
      scheduleBackgroundWork: (work) => scheduled.push(work),
    });

    const backgroundWork = scheduled[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(1);
    expect(detachedTaskRuntimeMocks.completeOperation).not.toHaveBeenCalled();
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(true);

    await vi.advanceTimersByTimeAsync(249);
    expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await backgroundWork;

    expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(2);
    expect(detachedTaskRuntimeMocks.completeOperation).toHaveBeenCalledTimes(1);
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(false);
  });

  it("caps exponential pending-handoff retries until delivery succeeds", async () => {
    vi.useFakeTimers();
    let wakeAttempt = 0;
    const { lifecycle, onWakeFailure, scheduled, schedule } = completionFixture(
      imageHandle("pending"),
    );
    lifecycle.wakeTaskCompletion.mockImplementation(async () => {
      wakeAttempt += 1;
      return { status: wakeAttempt < 7 ? "pending" : "delivered" };
    });
    schedule();

    const backgroundWork = scheduled[0]?.();
    await vi.advanceTimersByTimeAsync(7_749);
    expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledTimes(6);
    expect(lifecycle.completeTaskRun).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await backgroundWork;
    expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledTimes(7);
    expect(lifecycle.recordTaskProgress).toHaveBeenCalledTimes(7);
    expectCall(lifecycle.completeTaskRun, {
      terminalResult: undefined,
    });
    expect(onWakeFailure).not.toHaveBeenCalled();
  });

  it.each([-60_000, 0, 60_000])(
    "stops pending handoff retries at the completion deadline when the wall clock jumps %i ms",
    async (wallClockJumpMs) => {
      vi.useFakeTimers();
      const { lifecycle, onWakeFailure, scheduled, schedule } = completionFixture(
        imageHandle("orphaned", {
          requesterSessionKey: "agent:main:cron:job:run:run-id",
        }),
      );
      lifecycle.wakeTaskCompletion.mockResolvedValue({ status: "pending" });
      schedule();

      const backgroundWork = scheduled[0]?.();
      assert(backgroundWork, "expected scheduled media work");
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(Date.now() + wallClockJumpMs);

      await vi.advanceTimersByTimeAsync(119_999);
      expect(lifecycle.completeTaskRun).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const settlement = await Promise.race([
        backgroundWork.then(() => "settled" as const),
        Promise.resolve().then(() => "pending" as const),
      ]);
      expect(settlement).toBe("settled");
      expectCall(lifecycle.completeTaskRun, {
        terminalResult: expect.objectContaining({ terminalOutcome: "blocked" }),
      });
      expect(onWakeFailure).toHaveBeenCalledWith(
        "Image generation completion wake failed after successful generation",
        expect.objectContaining({ taskId: "task-image-orphaned" }),
      );
      expect(lifecycle.wakeTaskCompletion.mock.calls.length).toBeLessThan(70);

      await backgroundWork;
    },
  );

  it("completes a generated media task when completion delivery cannot be confirmed", async () => {
    const { lifecycle, onWakeFailure, scheduled, schedule } = completionFixture(imageHandle("456"));
    lifecycle.wakeTaskCompletion.mockResolvedValue({ status: "permanent_failure" });
    schedule();

    await scheduled[0]?.();

    expect(onWakeFailure).toHaveBeenCalledWith(
      "Image generation completion delivery was not confirmed after successful generation",
      expect.objectContaining({
        runId: "tool:image_generate:456",
        taskId: "task-image-456",
      }),
    );
    expectCall(lifecycle.completeTaskRun, {
      count: 1,
      terminalResult: {
        terminalOutcome: "blocked",
      },
    });
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
    expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledTimes(1);
  });

  it("completes a generated media task when completion wake throws", async () => {
    const wakeError = new Error("requester wake failed");
    const { lifecycle, onWakeFailure, scheduled, schedule } = completionFixture(
      imageHandle("789", {
        requesterOrigin: { channel: "discord", to: "channel:123" },
      }),
    );
    lifecycle.wakeTaskCompletion.mockRejectedValueOnce(wakeError);
    schedule({
      run: async () => ({
        ...generatedImageResult(),
        attachments: [{ type: "image" as const, path: "/tmp/proof.png" }],
        mediaUrls: ["/tmp/proof.png"],
      }),
    });

    await scheduled[0]?.();

    expect(onWakeFailure).toHaveBeenCalledWith(
      "Image generation completion wake failed after successful generation",
      expect.objectContaining({
        error: wakeError,
        runId: "tool:image_generate:789",
        taskId: "task-image-789",
      }),
    );
    expectCall(lifecycle.completeTaskRun, {
      count: 1,
      terminalResult: {
        terminalOutcome: "blocked",
      },
    });
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
    expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledTimes(1);
  });

  it("still delivers completion when the post-generation progress update throws", async () => {
    const progressError = new Error("progress store failed");
    const { lifecycle, onWakeFailure, scheduled, schedule } = completionFixture(
      imageHandle("progress-error"),
    );
    lifecycle.recordTaskProgress.mockImplementation(() => {
      throw progressError;
    });
    schedule();

    await scheduled[0]?.();

    expect(onWakeFailure).toHaveBeenCalledWith(
      "Image generation completion progress update failed",
      expect.objectContaining({
        error: progressError,
        runId: "tool:image_generate:progress-error",
        taskId: "task-image-progress-error",
      }),
    );
    expectCall(lifecycle.wakeTaskCompletion, {
      status: "ok",
      result: "generated",
    });
    expect(lifecycle.completeTaskRun).toHaveBeenCalled();
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
  });

  it("fails the media task when generation itself fails", async () => {
    const generationError = new Error("provider returned no images");
    const wakePending = createDeferredCore();
    const { lifecycle, scheduled, schedule } = completionFixture(imageHandle("generation-error"));
    lifecycle.wakeTaskCompletion.mockImplementation(async () => {
      await wakePending.promise;
      return { status: "delivered" };
    });
    schedule({
      run: async () => {
        throw generationError;
      },
    });

    const backgroundWork = scheduled[0]?.();
    await vi.waitFor(() => expect(lifecycle.wakeTaskCompletion).toHaveBeenCalled());
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
    wakePending.resolve();
    await backgroundWork;

    expect(lifecycle.failTaskRun).toHaveBeenCalledOnce();
    expectCall(lifecycle.wakeTaskCompletion, {
      status: "error",
      result: "provider returned no images",
    });
    expect(lifecycle.completeTaskRun).not.toHaveBeenCalled();
  });
});

describe("createMediaGenerationTaskLifecycle", () => {
  it("tracks pending media when the detached runtime does not mirror core tasks", async () => {
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    const lifecycle = createImageMediaLifecycle();

    const handle = await lifecycle.createTaskRun({
      sessionKey,
      prompt: "proof image",
    });
    expect(handle).not.toBeNull();
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(true);

    lifecycle.failTaskRun({ handle });
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(false);
  });

  it("pins a missing requester target from session state when the task starts", async () => {
    const original = { channel: "telegram", to: "5866004662", accountId: "bot-1" };
    sessionMocks.loadSessionEntry.mockReturnValue(requesterEntry(original));
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: true,
    });
    const lifecycle = createImageMediaLifecycle();

    const handle = await lifecycle.createTaskRun({
      sessionKey: "agent:main:telegram:5866004662",
      requesterOrigin: { channel: "telegram" },
      prompt: "proof image",
    });
    expect(handle?.requesterOrigin).toEqual(original);

    sessionMocks.loadSessionEntry.mockReturnValue(
      requesterEntry({ channel: "telegram", to: "other-peer", accountId: "bot-1" }),
    );
    await lifecycle.wakeTaskCompletion({
      handle,
      status: "ok",
      statusLabel: "completed successfully",
      result: "generated",
    });
    expectCall(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement, {
      completionDirectOrigin: original,
    });
  });

  it.each([
    [
      "another account",
      "shared",
      { channel: "telegram", to: "peer-b", accountId: "bot-b" },
      { channel: "telegram", accountId: "bot-a" },
      { channel: "telegram", to: undefined, accountId: "bot-a" },
    ],
    [
      "account-only origin",
      "shared",
      { channel: "telegram", to: "peer-b", accountId: "bot-b" },
      { accountId: "bot-a" },
      { channel: undefined, to: undefined, accountId: "bot-a" },
    ],
    [
      "different target thread",
      "room-a",
      { channel: "telegram", to: "room-b", threadId: 99 },
      { channel: "telegram", to: "room-a" },
      { channel: "telegram", to: "room-a", accountId: undefined },
    ],
    [
      "internal origin",
      "room-a",
      { channel: "telegram", to: "room-a", accountId: "bot-1" },
      { channel: "webchat" },
      { channel: "telegram", to: "room-a", accountId: "bot-1" },
    ],
  ] satisfies Array<[string, string, DeliveryContext, DeliveryContext, DeliveryContext]>)(
    "pins only eligible session routing: %s",
    async (label, key, stored, requesterOrigin, expected) => {
      sessionMocks.loadSessionEntry.mockReturnValue(requesterEntry(stored));
      const handle = await createImageMediaLifecycle().createTaskRun({
        sessionKey: "agent:main:telegram:" + key,
        requesterOrigin,
        prompt: label === "account-only origin" ? "account-only proof image" : "proof image",
      });
      expect(handle?.requesterOrigin).toEqual(expected);
    },
  );
  it.each([
    {
      suffix: "terminal",
      delivery: {
        delivered: false,
        path: "direct",
        disposition: "ambiguous",
        error: "generated media direct delivery failed after partial upload",
      },
      outcome: "delivered",
      mediaUrls: undefined,
    },
    {
      suffix: "abandoned",
      delivery: {
        delivered: false,
        path: "none",
        reason: "requester_abandoned",
        error: "requester session abandoned after timeout",
      },
      outcome: "permanent_failure",
      mediaUrls: ["/tmp/proof.png"],
    },
    {
      suffix: "timeout",
      delivery: { delivered: false, path: "direct", error: "gateway request timeout for agent" },
      outcome: "permanent_failure",
      mediaUrls: ["/tmp/proof.png"],
    },
  ])(
    "settles $suffix completion without resending media",
    async ({ suffix, delivery, outcome, mediaUrls }) => {
      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce(delivery);
      await expect(
        createImageMediaLifecycle().wakeTaskCompletion({
          handle: imageHandle(suffix, {
            requesterOrigin: { channel: "discord", to: "channel:123" },
          }),
          status: "ok",
          statusLabel: "completed successfully",
          result: "generated",
          ...(mediaUrls ? { mediaUrls } : {}),
        }),
      ).resolves.toEqual({ status: outcome });
    },
  );

  it("includes MEDIA directives in music completion wake prompts for session-only delivery", async () => {
    const origin = { channel: "webchat", to: "session:dashboard" };
    subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValueOnce({
      delivered: true,
    });
    const lifecycle = createMediaGenerationTaskLifecycle("music");

    await expect(
      lifecycle.wakeTaskCompletion({
        handle: admitMediaHandle({
          taskId: "task-music-webchat",
          runId: "tool:music_generate:webchat",
          requesterSessionKey: "agent:main:dashboard:music-session",
          taskLabel: "night-drive synthwave",
          requesterOrigin: origin,
        }),
        status: "ok",
        statusLabel: "completed successfully",
        result: 'Generated 1 track.\n- path="/tmp/generated-night-drive.mp3"',
        attachments: [
          {
            type: "audio",
            path: "/tmp/generated-night-drive.mp3",
            mimeType: "audio/mpeg",
            name: "generated-night-drive.mp3",
          },
        ],
      }),
    ).resolves.toEqual({ status: "delivered" });

    expectCall(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement, {
      requesterSessionKey: "agent:main:dashboard:music-session",
      requesterSessionOrigin: origin,
      completionDirectOrigin: origin,
      sourceTool: "music_generate",
      bestEffortDeliver: true,
    });
    const announceParams = subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mock
      .calls[0]?.[0] as { triggerMessage?: string; internalEvents?: unknown[] } | undefined;
    expect(announceParams?.triggerMessage).toContain("MEDIA:/tmp/generated-night-drive.mp3");
    expect(announceParams?.internalEvents).toEqual([
      expect.objectContaining({
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
        attachments: [
          expect.objectContaining({
            path: "/tmp/generated-night-drive.mp3",
          }),
        ],
      }),
    ]);
  });
});
