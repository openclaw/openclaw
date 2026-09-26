import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  findMediaGenerationOperation,
  getActiveMediaGenerationRunCount,
} from "../agents/media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../agents/media-generation-activity.test-support.js";
import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
} from "../agents/tools/media-generate-background-shared.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import * as transcript from "../config/sessions/transcript.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { drainPendingSessionDelivery } from "../infra/session-delivery-queue-recovery.js";
import * as queueRuntime from "../infra/session-delivery-queue-runtime.js";
import * as queue from "../infra/session-delivery-queue-storage.js";
import * as systemEvents from "../infra/system-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as recoveryRuntime from "./server-recovery-runtime-context.js";
import { deliverQueuedSessionDelivery } from "./server-restart-sentinel.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetGeneratedMediaTaskActivityForTests();
});

async function withMediaSession(
  run: (fixture: {
    state: OpenClawTestState;
    lifecycle: ReturnType<typeof createMediaGenerationTaskLifecycle>;
    handle: NonNullable<
      Awaited<ReturnType<ReturnType<typeof createMediaGenerationTaskLifecycle>["createTaskRun"]>>
    >;
    scope: { agentId: string; sessionKey: string; storePath: string };
    queueContext: ReturnType<typeof captureOpenClawStateWorkerContext>;
    mediaPath: string;
    dispatch: MockInstance<typeof recoveryRuntime.dispatchGatewayLifecycleMethod>;
    systemWake: MockInstance<typeof systemEvents.enqueueSystemEvent>;
    drain: (id: string) => ReturnType<typeof drainPendingSessionDelivery>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ prefix: "media-queue-binding-" }, async (state) => {
    await state.writeConfig({ agents: { ownership: "explicit", entries: { main: {} } } });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:media-binding",
      storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
    };
    await replaceSessionEntry(scope, {
      sessionId: "original-requester",
      lifecycleRevision: "original-lifecycle",
      updatedAt: 1,
    });
    const lifecycle = createMediaGenerationTaskLifecycle({
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
    const handle = await lifecycle.createTaskRun({
      sessionKey: scope.sessionKey,
      requesterAgentId: "main",
      prompt: "synthetic lighthouse",
      requesterOrigin: { channel: "discord", to: "channel:media-binding" },
    });
    if (!handle) {
      throw new Error("Expected admitted media operation");
    }
    const mediaPath = state.statePath("media", "lighthouse.png");
    const queueContext = captureOpenClawStateWorkerContext();
    const dispatch = vi.spyOn(recoveryRuntime, "dispatchGatewayLifecycleMethod").mockResolvedValue({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: [mediaPath] }],
        deliveryStatus: { status: "sent" },
      },
    });
    const systemWake = vi.spyOn(systemEvents, "enqueueSystemEvent");
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const drain = (id: string) =>
      drainPendingSessionDelivery({
        id,
        queueContext,
        log,
        logLabel: "media binding proof",
        bypassBackoff: true,
        deliver: (entry) => deliverQueuedSessionDelivery({ entry, queueContext, deps: {} }),
      });
    try {
      await run({
        state,
        lifecycle,
        handle,
        scope,
        mediaPath,
        queueContext,
        dispatch,
        systemWake,
        drain,
      });
    } finally {
      lifecycle.failTaskRun({ handle, error: new Error("fixture cleanup") });
    }
  });
}

describe("original requester media handoff", () => {
  it.each([
    "current",
    "replaced-before",
    "rotated-before",
    "deleted-before",
    "replaced-after",
    "rotated-after",
    "store-after",
    "replaced-at-enqueue",
    "store-at-enqueue",
    "generation-at-enqueue",
    "store-during-dispatch",
  ] as const)("keeps successful queue admission bound to the requester: %s", async (change) => {
    await withMediaSession(
      async ({
        state,
        lifecycle,
        handle,
        scope,
        mediaPath,
        queueContext,
        dispatch,
        systemWake,
        drain,
      }) => {
        const mutate = async () => {
          if (change === "generation-at-enqueue") {
            rotateAgentEventLifecycleGeneration();
          } else if (change === "deleted-before") {
            await deleteSessionEntryLifecycle({
              storePath: scope.storePath,
              agentId: scope.agentId,
              target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
              archiveTranscript: false,
            });
          } else if (change.startsWith("store")) {
            const replacementStore = state.statePath("replacement", "sessions.json");
            await replaceSessionEntry(
              { ...scope, storePath: replacementStore },
              {
                sessionId: "original-requester",
                lifecycleRevision: "original-lifecycle",
                updatedAt: 2,
              },
            );
            setRuntimeConfigSnapshot({
              agents: { ownership: "explicit", entries: { main: {} } },
              session: { store: replacementStore },
            });
          } else {
            await replaceSessionEntry(scope, {
              sessionId: change.startsWith("replaced")
                ? "replacement-requester"
                : "original-requester",
              lifecycleRevision: "replacement-lifecycle",
              updatedAt: 2,
            });
          }
        };
        if (change.endsWith("before")) {
          await mutate();
        }
        const enqueueOriginal = queue.enqueueClaimedSessionDelivery;
        const enqueue = vi.spyOn(queue, "enqueueClaimedSessionDelivery");
        if (change.endsWith("at-enqueue")) {
          enqueue.mockImplementationOnce(async (...args) => {
            await mutate();
            return enqueueOriginal(...args);
          });
        }
        const result = await lifecycle.wakeTaskCompletion({
          handle,
          status: "ok",
          statusLabel: "completed",
          result: "generated lighthouse",
          attachments: [{ type: "image", path: mediaPath, mimeType: "image/png" }],
        });
        const entries = await queue.loadPendingSessionDeliveries(queueContext);
        if (change.endsWith("before") || change.endsWith("at-enqueue")) {
          expect(result).toEqual({ status: "permanent_failure" });
          expect(enqueue).toHaveBeenCalledTimes(change.endsWith("at-enqueue") ? 1 : 0);
          expect(entries).toEqual([]);
        } else {
          expect(result).toEqual({ status: "pending" });
          expect(entries).toHaveLength(1);
          const entry = entries[0]!;
          expect(entry).toMatchObject({
            requesterBinding: {
              ...scope,
              sessionId: "original-requester",
              lifecycleRevision: "original-lifecycle",
            },
          });
          if (change.endsWith("after")) {
            await mutate();
          }
          if (change === "store-during-dispatch") {
            dispatch.mockImplementationOnce(async (_method, _params, options) => {
              await mutate();
              options?.assertAdmissionCurrent?.();
              throw new Error("retired requester was allowed through Gateway admission");
            });
          }
          await drain(entry.id);
          expect(await queue.loadPendingSessionDeliveries(queueContext)).toEqual([]);
          if (change === "current") {
            expect(dispatch).toHaveBeenCalledOnce();
            expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
              agentId: "main",
              sessionKey: scope.sessionKey,
              expectedExistingSessionId: "original-requester",
              expectedExistingSessionLifecycleRevision: "original-lifecycle",
            });
          }
        }
        if (change === "store-during-dispatch") {
          expect(dispatch).toHaveBeenCalledOnce();
        } else if (change !== "current") {
          expect(dispatch).not.toHaveBeenCalled();
        }
        expect(systemWake).not.toHaveBeenCalled();
        expect(
          await loadTranscriptEvents({ ...scope, sessionId: "replacement-requester" }),
        ).toEqual([]);
      },
    );
  });

  it("retries one refused queue admission without losing media when transcript retention is also unavailable", async () => {
    await withMediaSession(
      async ({ lifecycle, handle, mediaPath, queueContext, dispatch, drain }) => {
        const firstRefused = createDeferredCore();
        const queueSettled = createDeferredCore();
        const enqueue = vi.spyOn(queue, "enqueueClaimedSessionDelivery");
        enqueue.mockImplementationOnce(async () => {
          firstRefused.resolve();
          throw new Error("temporary queue write refusal");
        });
        vi.spyOn(queueRuntime, "scheduleSessionDelivery").mockImplementation(async (id) => {
          await drain(id);
          queueSettled.resolve();
          return true;
        });
        vi.spyOn(transcript, "appendAssistantMessageToSessionTranscript").mockRejectedValue(
          new Error("temporary retention refusal"),
        );
        const scheduled: Array<() => Promise<void>> = [];
        const generated = vi.fn(async () => ({
          provider: "synthetic",
          model: "fixture",
          count: 1,
          wakeResult: "generated lighthouse",
          attachments: [{ type: "image" as const, path: mediaPath, mimeType: "image/png" }],
        }));
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        scheduleMediaGenerationTaskCompletion({
          lifecycle,
          handle,
          scheduleBackgroundWork: (work) => scheduled.push(work),
          progressSummary: "Generating image",
          toolName: "image_generate",
          onWakeFailure: vi.fn(),
          run: generated,
        });
        const completion = scheduled[0]!();
        await firstRefused.promise;
        await vi.advanceTimersByTimeAsync(250);
        await Promise.race([
          queueSettled.promise,
          completion.then(() => {
            throw new Error("media completion ended without durable queue custody");
          }),
        ]);
        await vi.advanceTimersByTimeAsync(500);
        await completion;
        expect(generated).toHaveBeenCalledOnce();
        expect(dispatch).toHaveBeenCalledOnce();
        expect(new Set(enqueue.mock.calls.map(([payload]) => payload.idempotencyKey)).size).toBe(1);
        expect(await queue.loadPendingSessionDeliveries(queueContext)).toEqual([]);
        expect(getActiveMediaGenerationRunCount()).toBe(0);
      },
    );
  });

  it("ends bounded handoff without claiming durability when both storage paths remain unavailable", async () => {
    await withMediaSession(async ({ lifecycle, handle, mediaPath, queueContext }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const startedAt = Date.now();
      vi.spyOn(queue, "enqueueClaimedSessionDelivery").mockImplementation(async () => {
        vi.setSystemTime(startedAt + 120_001);
        throw new Error("queue remains unavailable");
      });
      vi.spyOn(transcript, "appendAssistantMessageToSessionTranscript").mockRejectedValue(
        new Error("transcript remains unavailable"),
      );
      const diagnostic = vi.fn();
      const scheduled: Array<() => Promise<void>> = [];
      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle,
        scheduleBackgroundWork: (work) => scheduled.push(work),
        progressSummary: "Generating image",
        toolName: "image_generate",
        onWakeFailure: diagnostic,
        run: async () => ({
          provider: "synthetic",
          model: "fixture",
          count: 1,
          wakeResult: "generated lighthouse",
          attachments: [{ type: "image", path: mediaPath, mimeType: "image/png" }],
        }),
      });
      await scheduled[0]!();
      expect(getActiveMediaGenerationRunCount()).toBe(0);
      expect(await queue.loadPendingSessionDeliveries(queueContext)).toEqual([]);
      expect(findMediaGenerationOperation(handle.runId)).toMatchObject({
        terminalOutcome: "blocked",
        terminalSummary: expect.stringContaining(mediaPath),
      });
      expect(diagnostic).toHaveBeenCalledWith(
        "image_generate blocked completion retention failed",
        expect.objectContaining({ error: expect.any(Error) }),
      );
    });
  });
});
