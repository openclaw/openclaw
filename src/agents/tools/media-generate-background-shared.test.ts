import assert from "node:assert/strict";
import {
  admitMediaHandle,
  resetGeneratedMediaTaskActivityForTests,
} from "../media-generation-activity.test-support.js";
vi.mock("../media-generation-activity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media-generation-activity.js")>();
  const { observeMediaActivity } =
    await import("../media-generation-activity.observer.test-support.js");
  return { ...observeMediaActivity(actual, taskExecutorMocks) };
});
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
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { hasPendingGeneratedMediaTaskForSessionKey } from "../media-generation-activity.js";
import { resolveGeneratedMediaSessionDeliveryRoute } from "../subagents/announce/subagent-announce-origin.js";
import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
} from "./media-generate-background-shared.js";
const taskExecutorMocks = vi.hoisted(() => ({
  createOperation: vi.fn(),
  recordProgress: vi.fn(),
  completeOperation: vi.fn(),
  failOperation: vi.fn(),
}));
const announceDeliveryMocks = vi.hoisted(() => ({
  deliverSubagentAnnouncement: vi.fn(),
}));
const sessionMocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn<() => SessionEntry | undefined>(),
}));
const cronContinuationCleanupMocks = vi.hoisted(() => ({
  removeCronRunContinuationSessionIfIdle: vi.fn(async () => {}),
}));
// mock-isolation: Observe completion cleanup without opening unrelated cron state.
vi.mock("../../cron/run-continuation-cleanup.js", () => cronContinuationCleanupMocks);
const announce = announceDeliveryMocks.deliverSubagentAnnouncement;

// mock-isolation: Record completion routing without delivering messages.
vi.mock("../subagents/announce/subagent-announce-delivery.js", () => announceDeliveryMocks);
// mock-isolation: Keep the session database outside this routing fixture.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: async (
    _scope: unknown,
    assertCurrent: () => void,
    consume: (read: { ok: true; value: SessionEntry | undefined }) => Promise<unknown>,
  ) => {
    assertCurrent();
    return consume({ ok: true, value: sessionMocks.loadSessionEntry() });
  },
}));

const {
  imageGenerationTaskLifecycle,
  musicGenerationTaskLifecycle,
  videoGenerationTaskLifecycle,
  runMediaGenerationTask,
  prepareMediaGenerationTask,
} = await import("./media-generate-background.js");

beforeEach(() => {
  resetGeneratedMediaTaskActivityForTests();
  for (const mock of [...Object.values(taskExecutorMocks), announce]) {
    mock.mockReset();
  }
  sessionMocks.loadSessionEntry
    .mockReset()
    .mockReturnValue({ sessionId: "media-requester", updatedAt: 1 });
  cronContinuationCleanupMocks.removeCronRunContinuationSessionIfIdle.mockClear();
  setRuntimeConfigSnapshot({});
  taskExecutorMocks.createOperation.mockReturnValue({ taskId: "task-123" });
  announce.mockResolvedValue({ delivered: true, path: "direct" });
  resetAgentEventsForTest();
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
  resetAgentEventsForTest();
});

function expectReplyInstruction(required: string[]) {
  const events: unknown = announce.mock.calls[0]?.[0]?.internalEvents;
  assert(Array.isArray(events), "Expected delivered internal events");
  const event: Record<string, unknown> | undefined = events.at(0);
  const instruction = String(event?.replyInstruction);
  for (const text of [...required, "Keep internal task/session details private"]) {
    expect(instruction).toContain(text);
  }
  for (const text of ['message(action="send")', "NO_REPLY", "MEDIA:"]) {
    expect(instruction).not.toContain(text);
  }
  return event;
}

function completion(kind: "image" | "music" | "video", result: string, mediaUrls?: string[]) {
  return {
    handle: admitMediaHandle({
      taskId: "task-123",
      runId: `tool:${kind}_generate:abc`,
      requesterSessionKey: "agent:main:discord:direct:123",
      requesterOrigin: { channel: "discord", to: "channel:1", threadId: "thread-1" },
      taskLabel: `${kind} generation`,
    }),
    status: "ok" as const,
    statusLabel: "completed successfully",
    result,
    ...(mediaUrls ? { mediaUrls } : {}),
  };
}

function setDelivery(to: string, accountId: string) {
  sessionMocks.loadSessionEntry.mockReturnValue(
    requesterEntry({ channel: "telegram", to, accountId }),
  );
}

it.each([
  [undefined, "webchat"],
  [{ kind: "external_user" }, "webchat"],
  [{ kind: "internal_system", sourceTool: "cron" }, "telegram"],
  [{ kind: "inter_session", sourceTool: "sessions_send" }, "telegram"],
] satisfies Array<[InputProvenance | undefined, string]>)(
  "routes a prepared WebChat media task with provenance %j to %s",
  async (inputProvenance, channel) => {
    setDelivery("test-room", "test-bot");
    let backgroundWork: (() => Promise<void>) | undefined;
    const run = vi.fn(async () => ({
      provider: "openai",
      model: "gpt-image-1",
      count: 1,
      wakeResult: "generated",
      contentText: "generated",
      details: {},
    }));
    const cfg: OpenClawConfig = {
      agents: { defaults: { mediaModels: { image: { primary: "openai/gpt-image-1" } } } },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    await prepareMediaGenerationTask({
      generationLabel: "image",
      cfg,
      args: { prompt: "synthetic provenance proof" },
      options: { inputProvenance },
      acquire: async () => undefined,
      resolveProviders: () => [],
      findDuplicate: async () => undefined,
      prepare: async ({ prompt }) => ({
        kind: "task",
        params: {
          lifecycle: imageGenerationTaskLifecycle,
          sessionKey: "agent:main:main",
          requesterOrigin: {
            channel: "webchat",
            ...(channel === "webchat"
              ? { to: "stale-peer", accountId: "test-bot", threadId: "stale-thread" }
              : {}),
          },
          prompt,
          requestKey: "provenance-proof",
          scheduleBackgroundWork: (work) => {
            backgroundWork = work;
          },
          onFailure: vi.fn(),
          run,
        },
      }),
    });
    assert(backgroundWork);
    setDelivery("changed-room", "changed-bot");
    await backgroundWork();
    expect(run).toHaveBeenCalledOnce();
    expect(announce).toHaveBeenCalledOnce();
    const delivered = announce.mock.calls[0]?.[0];
    assert(delivered);
    expect(
      resolveGeneratedMediaSessionDeliveryRoute({
        ...delivered,
        sessionKey: "agent:main:main",
      }).route,
    ).toEqual({
      channel,
      chatType: "direct",
      ...(channel === "webchat"
        ? { to: "agent:main:main" }
        : { to: "test-room", accountId: "test-bot" }),
    });
  },
);

it.each([
  "agent:main:discord:direct:123",
  "agent:main:discord:channel:C123",
  "agent:main:whatsapp:123@g.us",
  "agent:main:dashboard:music-session",
])(
  "gives %s tool-agnostic visible-reply guidance with every generated attachment",
  async (requesterSessionKey) => {
    const attachments = (
      [
        ["audio", "audio/mpeg", "night-drive.mp3"],
        ["image", "image/png", "night-drive-cover.png"],
      ] as const
    ).map(([type, mimeType, name]) => ({ type, mimeType, name, path: `/tmp/generated-${name}` }));
    const completed = completion("music", "Generated a track and cover art.");
    const requesterOrigin = requesterSessionKey.includes("dashboard")
      ? { channel: "webchat", to: "session:dashboard" }
      : completed.handle.requesterOrigin;
    const outcome = await musicGenerationTaskLifecycle.wakeTaskCompletion({
      ...completed,
      attachments,
      handle: { ...completed.handle, requesterSessionKey, requesterOrigin },
    });
    expect(outcome).toEqual({ status: "delivered" });
    const event = expectReplyInstruction([
      "do not send them again",
      "Check the result against what the user asked for",
      "generate again with adjusted parameters",
      "current visible-reply contract",
    ]);
    expect(event?.attachments).toEqual(attachments);
    expect(event?.mediaUrls).toEqual(attachments.map(({ path }) => path));
    expect(announce.mock.calls[0]?.[0]).toMatchObject({
      requesterSessionKey,
      requesterSessionOrigin: requesterOrigin,
      completionDirectOrigin: requesterOrigin,
      sourceTool: "music_generate",
      bestEffortDeliver: true,
      expectsCompletionMessage: true,
    });
    expect(announce.mock.calls[0]?.[0]?.triggerMessage).toContain(`MEDIA:${attachments[0]!.path}`);
  },
);
it("keeps the detached video tool run context registered until terminal status", async () => {
  const handle = await videoGenerationTaskLifecycle.createTaskRun({
    sessionKey: "agent:main:discord:channel:123",
    prompt: "friendly lobster surfing",
    providerId: "fal",
  });
  assert(handle, "expected video generation task handle");
  expect(handle.runId).toMatch(/^tool:video_generate:/);
  expect(getAgentRunContext(handle.runId)?.sessionKey).toBe("agent:main:discord:channel:123");
  const beforeProgress = Date.now();
  videoGenerationTaskLifecycle.recordTaskProgress({
    handle,
    progressSummary: "Generating video",
  });
  expect(taskExecutorMocks.recordProgress.mock.calls[0]?.[0]).toMatchObject({
    runId: handle.runId,
    progressSummary: "Generating video",
  });
  expect(getAgentRunContext(handle.runId)?.lastActiveAt).toBeGreaterThanOrEqual(beforeProgress);
  videoGenerationTaskLifecycle.failTaskRun({
    handle,
  });
  expect(getAgentRunContext(handle.runId)).toBeUndefined();
});

it.each(["image", "video"] as const)("keeps %s failure wakes agent-mediated", async (kind) => {
  announce.mockResolvedValue(
    kind === "video"
      ? { delivered: true, path: "steered" }
      : {
          delivered: false,
          path: "direct",
          reason: "generated_media_missing",
          error: "completion agent did not deliver generated media",
        },
  );
  const outcome = await createMediaGenerationTaskLifecycle(kind).wakeTaskCompletion({
    ...completion(kind, "provider failed"),
    status: "error",
    statusLabel: "failed",
  });
  expect(outcome).toEqual({ status: kind === "video" ? "delivered" : "permanent_failure" });
  expect(announce).toHaveBeenCalledOnce();
  expectReplyInstruction([
    "retry with adjusted parameters",
    "tell the user briefly what failed",
    "do not copy the internal event text verbatim",
  ]);
});
it.each(["admission", "generation"] as const)(
  "awaits cleanup and retains both errors after %s fails",
  async (phase) => {
    const error = new Error(phase);
    const cleanupError = new Error("cleanup failed");
    const cleanupStarted = createDeferredCore();
    const finishCleanup = createDeferredCore();
    const release = vi.fn(async () => {
      cleanupStarted.resolve();
      await finishCleanup.promise;
      throw cleanupError;
    });
    const lifecycle = mockLifecycle();
    lifecycle.createTaskRun.mockImplementation(async () => {
      if (phase === "admission") {
        throw error;
      }
      return null;
    });
    const run = vi.fn(async () => {
      throw error;
    });
    const scheduleBackgroundWork = vi.fn();
    const observed = vi.fn();
    const outcome = runMediaGenerationTask({
      lifecycle,
      generationLabel: "image",
      prompt: "synthetic cleanup proof",
      requestKey: "cleanup-proof",
      scheduleBackgroundWork,
      onFailure: vi.fn(),
      resources: {
        run: async <T>(work: () => T | Promise<T>) => await work(),
        release,
      },
      run,
    }).catch(observed);
    await cleanupStarted.promise;
    expect(observed).not.toHaveBeenCalled();
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
    finishCleanup.resolve();
    await outcome;
    expect(release).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: `Media ${phase} and cleanup failed`,
        errors: [error, cleanupError],
        cause: error,
      }),
    );
    expect(run).toHaveBeenCalledTimes(phase === "generation" ? 1 : 0);
    expect(lifecycle.failTaskRun).toHaveBeenCalledTimes(phase === "generation" ? 1 : 0);
    expect(lifecycle.completeTaskRun).not.toHaveBeenCalled();
    expect(scheduleBackgroundWork).not.toHaveBeenCalled();
  },
);

const requesterEntry = (context: DeliveryContext): SessionEntry => ({
  sessionId: "media-requester",
  updatedAt: 1,
  delivery: normalizeSessionDeliveryState({ context }),
});

function expectCall(mock: unknown, fields: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));
}

function createImageMediaLifecycle() {
  setRuntimeConfigSnapshot({});
  return createMediaGenerationTaskLifecycle("image");
}

type ScheduleOptions = Parameters<typeof scheduleMediaGenerationTaskCompletion>[0];

function mockLifecycle() {
  return {
    createTaskRun: vi.fn<ScheduleOptions["lifecycle"]["createTaskRun"]>(),
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
  params: Pick<ScheduleOptions, "lifecycle" | "handle"> & Partial<ScheduleOptions>,
) {
  let scheduled: (() => Promise<void>) | undefined;
  scheduleMediaGenerationTaskCompletion({
    progressSummary: "Generating image",
    toolName: "Image generation",
    onWakeFailure: vi.fn(),
    run: async () => generatedImageResult(),
    scheduleBackgroundWork: (work) => {
      scheduled = work;
    },
    ...params,
  });
  return () => {
    assert(scheduled, "expected scheduled media work");
    return scheduled();
  };
}

function completionFixture(handle: ScheduleOptions["handle"]) {
  const lifecycle = mockLifecycle();
  const onWakeFailure = vi.fn();
  return {
    lifecycle,
    onWakeFailure,
    start: (options: Partial<ScheduleOptions> = {}) =>
      scheduleImageCompletion({
        lifecycle,
        onWakeFailure,
        handle,
        ...options,
      })(),
  };
}

describe("media generation detachment admission", () => {
  it.each([
    ["agent:main:cron:daily-media", true, true],
    ["agent:main:cron:daily-media:run:run-123", false, true],
    [undefined, undefined, false],
  ] as const)("admits %s with detach=%s", async (sessionKey, detach, bindCli) => {
    const lifecycle = createImageMediaLifecycle();
    expect((await lifecycle.createTaskRun({ sessionKey, prompt: "before binding" }))?.detach).toBe(
      detach,
    );
    if (!bindCli) {
      return;
    }
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
    expect((await lifecycle.createTaskRun({ sessionKey, prompt: "before binding" }))?.detach).toBe(
      detach,
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
  it("runs detached completion outside a disposed requester transcript owner", async () => {
    const sessionKey = "agent:qa:image-generate";
    let disposed = false;
    const backgroundReady = createDeferredCore();
    let scheduled: Promise<void> | undefined;
    const requesterTranscriptWrite = vi.fn();
    const withRequesterTranscriptWrite = async <T>(operation: () => Promise<T> | T): Promise<T> => {
      requesterTranscriptWrite();
      if (disposed) {
        throw new Error("attempt disposed before transcript write");
      }
      return await operation();
    };
    const freshTranscriptWrite = vi.fn(async () => {});
    const wakeTaskCompletion = vi.fn(async () => {
      await runWithOwnedSessionTranscriptWrite({ sessionKey }, freshTranscriptWrite);
      return { status: "delivered" as const };
    });
    const lifecycle = {
      ...mockLifecycle(),
      wakeTaskCompletion,
    };
    const run = vi.fn(async () => generatedImageResult());

    await withOwnedSessionTranscriptWrites(
      { sessionKey, withTranscriptWrite: withRequesterTranscriptWrite },
      async () => {
        scheduleImageCompletion({
          lifecycle,
          handle: imageHandle("disposed-owner", {
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
    expect(lifecycle.completeTaskRun).toHaveBeenCalledOnce();
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
  });

  it("keeps a pending generated-media run fresh until scheduled work settles", async () => {
    vi.useFakeTimers();
    const runResult = createDeferredCore<ReturnType<typeof generatedImageResult>>();
    const task = completionFixture(imageHandle("123")).start({ run: () => runResult.promise });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(taskExecutorMocks.recordProgress).toHaveBeenCalledWith({
      runId: "tool:image_generate:123",
      progressSummary: "Generating image",
    });

    runResult.resolve(generatedImageResult());
    await task;
    const callsAfterCompletion = taskExecutorMocks.recordProgress.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(taskExecutorMocks.recordProgress).toHaveBeenCalledTimes(callsAfterCompletion);
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
      announce.mockResolvedValueOnce(delivery);
      const lifecycle = createImageMediaLifecycle();
      const handle = await lifecycle.createTaskRun({
        sessionKey,
        requesterOrigin,
        prompt: "proof image",
      });
      assert(handle);
      await scheduleImageCompletion({
        lifecycle,
        handle,
        run: async () => ({
          ...generatedImageResult(),
          attachments: [{ type: "image" as const, path: "/tmp/proof.png" }],
          ...(mediaUrls ? { mediaUrls } : {}),
        }),
      })();
      expectCall(taskExecutorMocks.completeOperation, terminal);
      expect(
        cronContinuationCleanupMocks.removeCronRunContinuationSessionIfIdle,
      ).toHaveBeenCalledWith(sessionKey);
    },
  );
  it.each([
    ["first retry", 2, 249],
    ["capped backoff", 7, 7_749],
    ["deadline", Infinity, 120_000],
  ] as const)("keeps pending cron media active until %s", async (ending, attempts, elapsed) => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    let wakes = 0;
    announce.mockImplementation(async () =>
      ++wakes < attempts
        ? {
            delivered: false,
            path: "none",
            reason: "completion_handoff_pending",
            error: "cron run continuation is not ready",
          }
        : { delivered: true, path: "direct" },
    );
    const lifecycle = createImageMediaLifecycle();
    const handle = await lifecycle.createTaskRun({ sessionKey, prompt: "proof image" });
    assert(handle);
    const complete = vi.spyOn(lifecycle, "completeTaskRun");
    const progress = vi.spyOn(lifecycle, "recordTaskProgress");
    const onWakeFailure = vi.fn();
    const backgroundWork = scheduleImageCompletion({ lifecycle, handle, onWakeFailure })();
    await vi.advanceTimersByTimeAsync(0);
    expect(announce).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(true);
    await vi.advanceTimersByTimeAsync(elapsed);
    if (ending !== "deadline") {
      expect(announce).toHaveBeenCalledTimes(attempts - 1);
      expect(complete).not.toHaveBeenCalled();
      expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
    }
    await backgroundWork;
    expect(complete).toHaveBeenCalledOnce();
    expect(taskExecutorMocks.completeOperation).toHaveBeenCalledOnce();
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(false);
    if (ending !== "deadline") {
      expect(announce).toHaveBeenCalledTimes(attempts);
      expect(progress).toHaveBeenCalledTimes(attempts);
      expectCall(complete, { terminalResult: undefined });
      expect(onWakeFailure).not.toHaveBeenCalled();
    } else {
      expect(announce.mock.calls.length).toBeLessThan(70);
      expectCall(complete, {
        terminalResult: expect.objectContaining({ terminalOutcome: "blocked" }),
      });
      expect(onWakeFailure).toHaveBeenCalledWith(
        "Image generation completion wake failed after successful generation",
        expect.objectContaining({ taskId: handle.taskId }),
      );
    }
  });

  it.each(["delivered", "unconfirmed", "wake-error", "progress-error", "generation-error"])(
    "settles generated media after %s in delivery order",
    async (phase) => {
      const generationError = new Error("provider returned no images");
      const wakeError = new Error("requester wake failed");
      const progressError = new Error("progress store failed");
      const wakePending = createDeferredCore();
      const order: string[] = [];
      const handle = imageHandle(
        phase,
        phase === "wake-error"
          ? { requesterOrigin: { channel: "discord", to: "channel:123" } }
          : {},
      );
      const { lifecycle, onWakeFailure, start } = completionFixture(handle);
      lifecycle.completeTaskRun.mockImplementation(() => {
        order.push("complete");
      });
      lifecycle.recordTaskProgress.mockImplementation(() => {
        order.push("progress");
        if (phase === "progress-error") {
          throw progressError;
        }
      });
      lifecycle.wakeTaskCompletion.mockImplementation(async () => {
        order.push("wake");
        expect(lifecycle.completeTaskRun).not.toHaveBeenCalled();
        if (phase === "generation-error") {
          await wakePending.promise;
        }
        if (phase === "wake-error") {
          throw wakeError;
        }
        return { status: phase === "unconfirmed" ? "permanent_failure" : "delivered" };
      });
      const task = start({
        run: async () => {
          order.push("run");
          if (phase === "generation-error") {
            throw generationError;
          }
          return {
            ...generatedImageResult(),
            ...(phase === "wake-error"
              ? {
                  attachments: [{ type: "image" as const, path: "/tmp/proof.png" }],
                  mediaUrls: ["/tmp/proof.png"],
                }
              : {}),
          };
        },
      });
      if (phase === "generation-error") {
        await vi.waitFor(() => expect(lifecycle.wakeTaskCompletion).toHaveBeenCalled());
        expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
        wakePending.resolve();
      }
      await task;
      expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledOnce();
      expectCall(lifecycle.wakeTaskCompletion, {
        status: phase === "generation-error" ? "error" : "ok",
        result: phase === "generation-error" ? generationError.message : "generated",
      });
      if (phase === "generation-error") {
        expect(lifecycle.failTaskRun).toHaveBeenCalledOnce();
        expect(lifecycle.completeTaskRun).not.toHaveBeenCalled();
        return;
      }
      expect(order).toEqual(["run", "progress", "wake", "complete"]);
      expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
      expectCall(lifecycle.recordTaskProgress, {
        progressSummary: "Generated media; delivering completion",
      });
      expectCall(lifecycle.completeTaskRun, {
        count: 1,
        terminalResult:
          phase === "wake-error" || phase === "unconfirmed"
            ? {
                terminalOutcome: "blocked",
                terminalSummary:
                  phase === "wake-error"
                    ? expect.stringContaining(wakeError.message)
                    : "Required completion delivery failed before reaching the requester: completion delivery was not confirmed after successful generation.",
              }
            : undefined,
      });
      if (phase === "delivered") {
        return;
      }
      const message =
        phase === "progress-error"
          ? "completion progress update failed"
          : phase === "wake-error"
            ? "completion wake failed after successful generation"
            : "completion delivery was not confirmed after successful generation";
      expect(onWakeFailure).toHaveBeenCalledWith(
        "Image generation " + message,
        expect.objectContaining({
          taskId: handle.taskId,
          runId: handle.runId,
          ...(phase === "wake-error"
            ? { error: wakeError }
            : phase === "progress-error"
              ? { error: progressError }
              : {}),
        }),
      );
    },
  );
});

describe("createMediaGenerationTaskLifecycle", () => {
  it("pins a missing requester target from session state when the task starts", async () => {
    const original = { channel: "telegram", to: "5866004662", accountId: "bot-1" };
    sessionMocks.loadSessionEntry.mockReturnValue(requesterEntry(original));
    announce.mockResolvedValueOnce({
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
    expectCall(announce, {
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
      announce.mockResolvedValueOnce(delivery);
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
});
