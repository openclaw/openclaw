import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findMediaGenerationOperation,
  getActiveMediaGenerationRunCount,
} from "../agents/media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../agents/media-generation-activity.test-support.js";
import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
} from "../agents/tools/media-generate-background-shared.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import * as messageRuntime from "../channels/message/runtime.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadTranscriptEvents, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as transcript from "../config/sessions/transcript.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { drainPendingSessionDelivery } from "../infra/session-delivery-queue-recovery.js";
import * as queueRuntime from "../infra/session-delivery-queue-runtime.js";
import * as queue from "../infra/session-delivery-queue-storage.js";
import { SessionDeliveryDeadLetteredError } from "../infra/session-delivery-queue.records.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
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
  run: (fixture: Awaited<ReturnType<typeof createMediaFixture>>) => Promise<void>,
  channel: "discord" | "webchat" = "discord",
) {
  await withOpenClawTestState({ prefix: "media-queue-binding-" }, async (state) => {
    const fixture = await createMediaFixture(state, channel);
    try {
      await run(fixture);
    } finally {
      fixture.lifecycle.failTaskRun({
        handle: fixture.handle,
        error: new Error("fixture cleanup"),
      });
    }
  });
}

async function createMediaFixture(state: OpenClawTestState, channel: "discord" | "webchat") {
  await state.writeConfig({ agents: { ownership: "explicit", entries: { main: {} } } });
  await captureRuntimeConfigAsyncReader()();
  const scope = {
    agentId: "main",
    sessionKey:
      channel === "webchat"
        ? "agent:main:media-binding"
        : "agent:main:discord:channel:media-binding",
    storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
  };
  await replaceSessionEntry(scope, {
    sessionId: "original-requester",
    lifecycleRevision: "original-lifecycle",
    updatedAt: 1,
  });
  const lifecycle = createMediaGenerationTaskLifecycle("image");
  const handle = await lifecycle.createTaskRun({
    sessionKey: scope.sessionKey,
    requesterAgentId: "main",
    prompt: "synthetic lighthouse",
    requesterOrigin:
      channel === "webchat"
        ? { channel: "webchat" }
        : { channel: "discord", to: "channel:media-binding" },
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
  const send = vi.spyOn(messageRuntime, "sendDurableMessageBatchCore").mockResolvedValue({
    status: "sent",
    results: [{ channel: "discord", messageId: "media-message" }],
  } as Awaited<ReturnType<typeof messageRuntime.sendDurableMessageBatchCore>>);
  const systemWake = vi.spyOn(sessionEvents, "enqueueSessionEventForHost");
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const drainOnce = (id: string) =>
    drainPendingSessionDelivery({
      id,
      queueContext,
      log,
      logLabel: "media binding proof",
      bypassBackoff: true,
      deliver: (entry) => deliverQueuedSessionDelivery({ entry, queueContext, deps: {} }),
    });
  // Host delivery settles first; the completion turn runs on the next drain.
  const drain = async (id: string) => {
    const before = await queue.loadPendingSessionDelivery(id, queueContext);
    const pending = await drainOnce(id);
    const mediaJustDelivered =
      (before?.kind === "agentTurn" ? (before.expectedMediaUrls?.length ?? 0) : 0) > 0 &&
      pending?.kind === "agentTurn" &&
      pending.expectedMediaUrls?.length === 0;
    return mediaJustDelivered ? await drainOnce(id) : pending;
  };
  const attachments = [{ type: "image" as const, path: mediaPath, mimeType: "image/png" }];
  const generate = () => ({
    provider: "synthetic",
    model: "fixture",
    count: 1,
    wakeResult: "generated lighthouse",
    attachments,
  });
  const wake = () =>
    lifecycle.wakeTaskCompletion({
      handle,
      status: "ok",
      statusLabel: "completed",
      result: "generated lighthouse",
      attachments,
    });
  const schedule = (run = async () => generate(), onWakeFailure = vi.fn()) => {
    const scheduled: Array<() => Promise<void>> = [];
    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle,
      scheduleBackgroundWork: (work) => scheduled.push(work),
      progressSummary: "Generating image",
      toolName: "image_generate",
      onWakeFailure,
      run,
    });
    return scheduled[0]!;
  };
  return {
    state,
    lifecycle,
    handle,
    scope,
    mediaPath,
    queueContext,
    dispatch,
    send,
    systemWake,
    drain,
    generate,
    wake,
    schedule,
    acquire: () =>
      beginSessionWorkAdmission({
        scope: scope.storePath,
        identities: [scope.sessionKey, "original-requester"],
        assertAllowed: () => {},
      }),
    events: () => loadTranscriptEvents({ ...scope, sessionId: "original-requester" }),
  };
}

describe("original requester media handoff", () => {
  it.each(["originating turn", "attempt-marker admission"] as const)(
    "keeps media queued while the %s owns requester work",
    async (ownerTiming) => {
      await withMediaSession(async ({ wake, acquire, queueContext, dispatch, drain }) => {
        let owner: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
        const markAttempt = queue.markSessionDeliveryAttemptStarted;
        if (ownerTiming === "attempt-marker admission") {
          vi.spyOn(queue, "markSessionDeliveryAttemptStarted").mockImplementationOnce(
            async (...args) => {
              owner = await acquire();
              return markAttempt(...args);
            },
          );
        } else {
          owner = await acquire();
        }
        let entryId: string | undefined;
        const complete = async () => {
          expect(await wake()).toEqual({ status: "queued" });
          const [entry] = await queue.loadPendingSessionDeliveries(queueContext);
          if (!entry) {
            throw new Error("Expected queued media completion");
          }
          entryId = entry.id;
          await drain(entry.id);
          const [pending] = await queue.loadPendingSessionDeliveries(queueContext);
          expect(pending).toMatchObject({ id: entry.id, retryCount: 0 });
          expect(pending?.deliveryStartedAt).toBeUndefined();
          expect(dispatch).not.toHaveBeenCalled();
        };
        try {
          // Scheduling may inherit the originating turn's async admission context.
          await (owner ? owner.run(complete) : complete());
        } finally {
          owner?.release();
        }
        if (!entryId) {
          throw new Error("Expected retained media completion id");
        }
        await drain(entryId);
        expect(dispatch).toHaveBeenCalledOnce();
        expect(await queue.loadPendingSessionDeliveries(queueContext)).toEqual([]);
      });
    },
  );

  it.each([
    "current",
    "replaced-after",
    "rotated-after",
    "store-after",
    "replaced-at-enqueue",
    "store-at-enqueue",
    "generation-at-enqueue",
    "store-during-dispatch",
  ] as const)("keeps successful queue admission bound to the requester: %s", async (change) => {
    await withMediaSession(
      async ({ state, wake, scope, queueContext, dispatch, send, systemWake, drain }) => {
        const mutate = async () => {
          if (change === "generation-at-enqueue") {
            rotateAgentEventLifecycleGeneration();
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
        const enqueueOriginal = queue.enqueueClaimedSessionDelivery;
        const enqueue = vi.spyOn(queue, "enqueueClaimedSessionDelivery");
        if (change.endsWith("at-enqueue")) {
          enqueue.mockImplementationOnce(async (...args) => {
            await mutate();
            return enqueueOriginal(...args);
          });
        }
        const result = await wake();
        const entries = await queue.loadPendingSessionDeliveries(queueContext);
        if (change.endsWith("at-enqueue")) {
          expect(result).toEqual({ status: "permanent_failure" });
          expect(enqueue).toHaveBeenCalledTimes(1);
          expect(entries).toEqual([]);
        } else {
          expect(result).toEqual({ status: "queued" });
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
            // Outbound custody carries the requester so a replay cannot outlive it.
            expect(send.mock.calls[0]?.[3]).toEqual({
              ...scope,
              sessionId: "original-requester",
              lifecycleRevision: "original-lifecycle",
            });
            expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
              agentId: "main",
              sessionKey: scope.sessionKey,
              expectedExistingSessionId: "original-requester",
              expectedExistingSessionLifecycleRevision: "original-lifecycle",
            });
          }
        }
        expect(dispatch).toHaveBeenCalledTimes(
          change === "current" || change === "store-during-dispatch" ? 1 : 0,
        );
        // A retired requester never receives the media.
        expect(send).toHaveBeenCalledTimes(
          change === "current" || change === "store-during-dispatch" ? 1 : 0,
        );
        expect(systemWake).not.toHaveBeenCalled();
        expect(
          await loadTranscriptEvents({ ...scope, sessionId: "replacement-requester" }),
        ).toEqual([]);
      },
    );
  });

  it("retries one refused queue admission without losing media when transcript retention is also unavailable", async () => {
    await withMediaSession(async ({ generate, schedule, queueContext, dispatch, drain }) => {
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
      const generated = vi.fn(async () => generate());
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const completion = schedule(generated)();
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
    });
  });

  it("ends bounded handoff without claiming durability when both storage paths remain unavailable", async () => {
    await withMediaSession(async ({ schedule, handle, mediaPath, queueContext }) => {
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
      await schedule(undefined, diagnostic)();
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

// Fixed provider and model I/O; admission, durable queue, recovery and transcript
// persistence run together so a busy requester cannot look like delivery failure.
describe("queued media completion past the handoff deadline", () => {
  it.each(["delivered", "delivery-failed", "generation-failed"] as const)(
    "waits for the original WebChat turn before settling: %s",
    async (outcome) => {
      await withMediaSession(
        async ({
          schedule,
          generate,
          acquire,
          events,
          handle,
          scope,
          mediaPath,
          queueContext,
          dispatch,
          drain,
        }) => {
          await fs.mkdir(path.dirname(mediaPath), { recursive: true });
          await fs.writeFile(
            mediaPath,
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV4kAAAAASUVORK5CYII=",
              "base64",
            ),
          );
          if (outcome === "delivery-failed") {
            dispatch.mockRejectedValueOnce(
              new SessionDeliveryDeadLetteredError("delivery permanently refused"),
            );
          } else if (outcome === "generation-failed") {
            dispatch.mockResolvedValue({
              status: "ok",
              result: {
                payloads: [{ text: "Generation failed." }],
                deliveryStatus: { status: "sent" },
              },
            });
          }
          const originalOwner = await acquire();
          const startedAt = Date.now();
          vi.useFakeTimers({ toFake: ["Date"] });
          const observedQueuedRetry = createDeferredCore();
          let scheduledCount = 0;
          let queueId: string | undefined;
          // Advance past the producer deadline while real recovery defers the row.
          // A repeated receipt or a terminal producer lets the baseline fail without hanging.
          vi.spyOn(queueRuntime, "scheduleSessionDelivery").mockImplementation(async (id) => {
            queueId = id;
            await drain(id);
            vi.setSystemTime(startedAt + 120_001);
            if (++scheduledCount > 1) {
              observedQueuedRetry.resolve();
            }
            return true;
          });
          const diagnostic = vi.fn();
          const generated = vi.fn(async () => {
            if (outcome === "generation-failed") {
              throw new Error("provider refused generation");
            }
            return { ...generate(), wakeResult: "Generated a synthetic lighthouse." };
          });
          const backgroundWork = originalOwner.run(schedule(generated, diagnostic));
          let beforeRelease: Awaited<ReturnType<typeof loadTranscriptEvents>>;
          let operationBeforeRelease;
          try {
            await Promise.race([backgroundWork, observedQueuedRetry.promise]);
            const pending = await queue.loadPendingSessionDeliveries(queueContext);
            expect(pending).toHaveLength(1);
            expect(pending[0]).toMatchObject({
              id: queueId,
              retryCount: 0,
              route: { channel: "webchat", to: scope.sessionKey },
            });
            expect(pending[0]?.deliveryStartedAt).toBeUndefined();
            expect(dispatch).not.toHaveBeenCalled();
            beforeRelease = await events();
            operationBeforeRelease = { ...findMediaGenerationOperation(handle.runId) };
          } finally {
            originalOwner.release();
          }
          if (!queueId) {
            throw new Error("Expected durable completion custody");
          }
          await drain(queueId);
          await backgroundWork;
          expect(generated).toHaveBeenCalledOnce();
          expect(dispatch).toHaveBeenCalledOnce();
          expect(await queue.loadPendingSessionDeliveries(queueContext)).toEqual([]);
          const afterRelease = await events();
          expect(beforeRelease).toEqual([]);
          expect(operationBeforeRelease).toMatchObject({
            status: "running",
            completionDelivery: "queued",
          });
          expect(operationBeforeRelease.terminalOutcome).toBeUndefined();
          const operation = findMediaGenerationOperation(handle.runId);
          expect(operation?.status).toBe(outcome === "generation-failed" ? "failed" : "succeeded");
          expect(operation?.terminalOutcome).toBeUndefined();
          if (outcome !== "generation-failed") {
            expect(
              afterRelease.filter((event) => isRecord(event) && event.type === "message"),
            ).toHaveLength(1);
          }
          if (outcome === "delivery-failed") {
            // The host already delivered the media; a refused follow-up turn
            // must not retain it a second time as undelivered.
            expect(JSON.stringify(afterRelease)).not.toContain(
              "completion delivery was not confirmed",
            );
          } else {
            expect(diagnostic).not.toHaveBeenCalled();
            if (outcome === "delivered") {
              expect(JSON.stringify(afterRelease)).toContain(
                '"openclawDisplayContent":[{"type":"image"',
              );
              await drain(queueId);
              expect(dispatch).toHaveBeenCalledOnce();
              expect(await events()).toEqual(afterRelease);
            }
          }
        },
        "webchat",
      );
    },
  );
});
