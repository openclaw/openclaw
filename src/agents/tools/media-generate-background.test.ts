import assert from "node:assert/strict";
vi.mock("../media-generation-activity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media-generation-activity.js")>();
  const { observeMediaActivity } =
    await import("../media-generation-activity.observer.test-support.js");
  return { ...observeMediaActivity(actual, taskExecutorMocks) };
});
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { resolveGeneratedMediaSessionDeliveryRoute } from "../subagents/announce/subagent-announce-origin.js";
import {
  createMediaCompletionFixture,
  expectFallbackMediaAnnouncement,
  resetMediaBackgroundMocks,
} from "./media-generate-background.test-support.js";
const taskExecutorMocks = vi.hoisted(() => ({
  createOperation: vi.fn(),
  recordProgress: vi.fn(),
  completeOperation: vi.fn(),
  failOperation: vi.fn(),
}));
const announceDeliveryMocks = vi.hoisted(() => ({
  deliverSubagentAnnouncement: vi.fn(),
}));
const sessionMocks = vi.hoisted((): { entry: SessionEntry } => ({
  entry: { sessionId: "media-requester", updatedAt: 1 },
}));
const announce = announceDeliveryMocks.deliverSubagentAnnouncement;

vi.mock("../subagents/announce/subagent-announce-delivery.js", () => announceDeliveryMocks);
// mock-isolation: Keep the session database outside this routing fixture.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: async (_scope: unknown, assertCurrent: () => void) => {
    assertCurrent();
    return sessionMocks.entry;
  },
  withSessionEntryReadOnlyInWorker: async (
    _scope: unknown,
    assertCurrent: () => void,
    consume: (read: { ok: true; value: SessionEntry }) => Promise<unknown>,
  ) => {
    assertCurrent();
    return consume({ ok: true, value: sessionMocks.entry });
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
  resetMediaBackgroundMocks({ taskExecutorMocks, announceDeliveryMocks });
  setRuntimeConfigSnapshot({});
  taskExecutorMocks.createOperation.mockReturnValue({ taskId: "task-123" });
  announce.mockResolvedValue({ delivered: true, path: "direct" });
  resetAgentEventsForTest();
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
  resetAgentEventsForTest();
  sessionMocks.entry = { sessionId: "media-requester", updatedAt: 1 };
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
  return createMediaCompletionFixture({
    runId: `tool:${kind}_generate:abc`,
    taskLabel: `${kind} generation`,
    result,
    mediaUrls,
  });
}

function setDelivery(to: string, accountId: string) {
  sessionMocks.entry.delivery = normalizeSessionDeliveryState({
    context: { channel: "telegram", to, accountId },
  });
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

it("wakes the original conversation with generated attachments and visible-reply guidance", async () => {
  const attachments = (
    [
      ["audio", "audio/mpeg", "night-drive.mp3"],
      ["image", "image/png", "night-drive-cover.png"],
    ] as const
  ).map(([type, mimeType, name]) => ({ type, mimeType, name, path: `/tmp/generated-${name}` }));
  const path = "/tmp/generated-preview.png";
  const completed = completion("music", `Generated a track and cover art.\nMEDIA:${path}`, [path]);
  await musicGenerationTaskLifecycle.wakeTaskCompletion({
    ...completed,
    attachments,
  });
  expectFallbackMediaAnnouncement({
    deliverAnnouncementMock: announce,
    requesterSessionKey: completed.handle.requesterSessionKey,
    channel: "discord",
    to: "channel:1",
    source: "music_generation",
    announceType: "music generation task",
    resultMediaPath: `MEDIA:${path}`,
    mediaUrls: [path, ...attachments.map((attachment) => attachment.path)],
  });
  const event = expectReplyInstruction([
    "do not send them again",
    "Check the result against what the user asked for",
    "generate again with adjusted parameters",
    "current visible-reply contract",
  ]);
  expect(event?.attachments).toEqual(attachments);
});
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
  expect(getAgentRunContext(handle.runId)?.lastActiveAt).toBeGreaterThanOrEqual(beforeProgress);
  videoGenerationTaskLifecycle.failTaskRun({
    handle,
  });
  expect(getAgentRunContext(handle.runId)).toBeUndefined();
});

it("keeps active video generation failure wakes agent-mediated", async () => {
  announce.mockResolvedValue({ delivered: true, path: "steered" });
  await videoGenerationTaskLifecycle.wakeTaskCompletion({
    ...completion("video", "All video generation models failed."),
    status: "error",
    statusLabel: "failed",
  });
  expect(announce).toHaveBeenCalledTimes(1);
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
    const lifecycle = {
      createTaskRun: vi.fn(async () => {
        if (phase === "admission") {
          throw error;
        }
        return null;
      }),
      recordTaskProgress: vi.fn(),
      completeTaskRun: vi.fn(),
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn(async () => ({ status: "delivered" as const })),
    };
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
