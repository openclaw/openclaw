import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as activity from "../agents/media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../agents/media-generation-activity.test-support.js";
import * as completionSource from "../agents/subagents/announce/subagent-announce-controller-source.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import * as background from "../agents/tools/media-generate-background-shared.js";
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
import { createGrayscaleAlphaPngBuffer } from "../plugin-sdk/test-helpers/image-fixtures.js";
import { beginSessionEffect } from "../sessions/session-controller.lifecycle.js";
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
      fixture.dispose();
    }
  });
}

async function createMediaFixture(state: OpenClawTestState, channel: "discord" | "webchat") {
  const config = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
  await state.writeConfig(config);
  await captureRuntimeConfigAsyncReader()();
  const scope = {
    agentId: "main",
    sessionKey: `agent:main:${channel === "webchat" ? "" : "discord:channel:"}media-binding`,
    storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
  };
  const original = {
    sessionId: "original-requester",
    lifecycleRevision: "original-lifecycle",
  };
  const binding = { ...scope, ...original };
  await replaceSessionEntry(scope, { ...original, updatedAt: 1 });
  const lifecycle = background.createMediaGenerationTaskLifecycle("image");
  const handle = await lifecycle.createTaskRun({
    sessionKey: scope.sessionKey,
    requesterAgentId: "main",
    prompt: "synthetic lighthouse",
    requesterOrigin:
      channel === "webchat"
        ? { channel: "webchat" }
        : { channel: "discord", to: "channel:media-binding" },
  });
  assert(handle, "Expected admitted media operation");
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
    background.scheduleMediaGenerationTaskCompletion({
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
    dispose: () => lifecycle.failTaskRun({ handle }),
    scope,
    binding,
    original,
    config,
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
      beginSessionEffect({
        scope: scope.storePath,
        identities: [scope.sessionKey, "original-requester"],
        assertAllowed: () => {},
      }),
    events: () => loadTranscriptEvents({ ...scope, sessionId: "original-requester" }),
    pending: () => queue.loadPendingSessionDeliveries(queueContext),
    operation: () => activity.findMediaGenerationOperation(handle.runId),
  };
}

describe("original requester media handoff", () => {
  it("retains queued media completion without charging retries until its source can reserve", () =>
    withMediaSession(async ({ scope, binding, queueContext, drain, pending, dispatch, send }) => {
      const deadlineAt = Date.now() + 60_000;
      const completionOwner: SubagentRunRecord = {
        runId: "run-deferred-completion",
        childSessionKey: "agent:main:subagent:deferred-completion",
        requesterSessionKey: scope.sessionKey,
        requesterAgentId: scope.agentId,
        requesterStorePath: scope.storePath,
        requesterDisplayKey: "main",
        task: "generate media",
        cleanup: "keep",
        createdAt: 1,
        execution: { status: "terminal", startedAt: 2, endedAt: 3, outcome: { status: "ok" } },
      };
      const id = await queue.enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: scope.sessionKey,
          requesterBinding: binding,
          message: "generated image ready",
          messageId: "image:deferred-completion:agent-loop",
          route: { channel: "discord", to: "channel:media-binding", chatType: "channel" },
          inputProvenance: { kind: "inter_session", sourceTool: "image_generate" },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: [],
          owner: {
            kind: "subagent_completion",
            runId: completionOwner.runId,
            taskId: completionOwner.runId,
            generation: 0,
            deadlineAt,
          },
        },
        queueContext,
      );
      completionOwner.delivery = { status: "in_progress", queueId: id, generation: 0, deadlineAt };
      vi.spyOn(completionSource, "reserveSubagentCompletionControllerSource").mockResolvedValueOnce(
        undefined,
      );
      const markAttempt = vi.spyOn(queue, "markSessionDeliveryAttemptStarted");
      subagentRuns.set(completionOwner.runId, completionOwner);
      try {
        const deferredAt = Date.now();
        const deferred = await drain(id);
        expect(dispatch).not.toHaveBeenCalled();
        expect(markAttempt).not.toHaveBeenCalled();
        expect(deferred).toMatchObject({ id, message: "generated image ready", retryCount: 0 });
        expect(deferred?.availableAt).toBeGreaterThan(deferredAt);
        expect(deferred?.deliveryStartedAt).toBeUndefined();

        await expect(drain(id)).resolves.toBeNull();
        await expect(drain(id)).resolves.toBeNull();
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch.mock.calls[0]?.[1]?.controllerInput).toBeDefined();
        expect(send).not.toHaveBeenCalled();
        expect(await pending()).toEqual([]);
      } finally {
        subagentRuns.delete(completionOwner.runId);
      }
    }));

  it("keeps media queued when requester work starts at attempt-marker admission", () =>
    withMediaSession(async ({ wake, acquire, pending, dispatch, drain }) => {
      let owner: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
      const markAttempt = queue.markSessionDeliveryAttemptStarted;
      vi.spyOn(queue, "markSessionDeliveryAttemptStarted").mockImplementationOnce(
        async (...args) => {
          owner = await acquire();
          return markAttempt(...args);
        },
      );
      let entryId: string;
      try {
        expect(await wake()).toEqual({ status: "queued" });
        const [entry] = await pending();
        assert(entry, "Expected queued media completion");
        entryId = entry.id;
        await drain(entryId);
        const [queued] = await pending();
        expect(queued).toMatchObject({ id: entryId, retryCount: 0 });
        expect(queued?.deliveryStartedAt).toBeUndefined();
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        owner?.release();
      }
      await drain(entryId);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(await pending()).toEqual([]);
    }));

  it.each([
    "current",
    "replaced-after",
    "rotated-after",
    "store-after",
    "replaced-at-enqueue",
    "store-at-enqueue",
    "generation-at-enqueue",
    "store-during-dispatch",
  ] as const)("keeps successful queue admission bound to the requester: %s", (change) =>
    withMediaSession(async (fixture) => {
      const { state, wake, scope, queueContext, dispatch, send, systemWake, drain } = fixture;
      const mutate = async () => {
        if (change === "generation-at-enqueue") {
          rotateAgentEventLifecycleGeneration();
        } else if (change.startsWith("store")) {
          const replacementStore = state.statePath("replacement", "sessions.json");
          await replaceSessionEntry(
            { ...scope, storePath: replacementStore },
            { ...fixture.original, updatedAt: 2 },
          );
          setRuntimeConfigSnapshot({
            ...fixture.config,
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
        expect(entry).toMatchObject({ requesterBinding: fixture.binding });
        if (change.endsWith("after")) {
          await mutate();
        }
        if (change === "store-during-dispatch") {
          dispatch.mockImplementationOnce(async (_params, options) => {
            await mutate();
            options?.assertAdmissionCurrent?.();
            throw new Error("retired requester was allowed through Gateway admission");
          });
        }
        await drain(entry.id);
        expect(await queue.loadPendingSessionDeliveries(queueContext)).toEqual([]);
        if (change === "current") {
          // Outbound custody carries the requester so a replay cannot outlive it.
          expect(send.mock.calls[0]?.[3]).toEqual(fixture.binding);
          expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
            agentId: "main",
            sessionKey: scope.sessionKey,
            expectedExistingSessionId: "original-requester",
            expectedExistingSessionLifecycleRevision: "original-lifecycle",
          });
        }
      }
      const deliveryCount = change === "current" || change === "store-during-dispatch" ? 1 : 0;
      expect(dispatch).toHaveBeenCalledTimes(deliveryCount);
      // A retired requester never receives the media.
      expect(send).toHaveBeenCalledTimes(deliveryCount);
      expect(systemWake).not.toHaveBeenCalled();
      expect(await loadTranscriptEvents({ ...scope, sessionId: "replacement-requester" })).toEqual(
        [],
      );
    }),
  );

  it.each(["retry", "exhaust"] as const)("retains media through storage refusal: %s", (mode) =>
    withMediaSession(async (f) => {
      const firstRefused = createDeferredCore();
      const queueSettled = createDeferredCore();
      const enqueue = vi.spyOn(queue, "enqueueClaimedSessionDelivery");
      const exhausted = mode === "exhaust";
      vi.useFakeTimers({ toFake: exhausted ? ["Date"] : ["setTimeout", "clearTimeout", "Date"] });
      const startedAt = Date.now();
      enqueue[exhausted ? "mockImplementation" : "mockImplementationOnce"](async () => {
        if (exhausted) {
          vi.setSystemTime(startedAt + 120_001);
        }
        firstRefused.resolve();
        throw new Error(exhausted ? "queue remains unavailable" : "temporary queue write refusal");
      });
      vi.spyOn(transcript, "appendAssistantMessageToSessionTranscript").mockRejectedValue(
        new Error(exhausted ? "transcript remains unavailable" : "temporary retention refusal"),
      );
      if (!exhausted) {
        vi.spyOn(queueRuntime, "scheduleSessionDelivery").mockImplementation(async (id) => {
          await f.drain(id);
          queueSettled.resolve();
          return true;
        });
      }
      const generated = vi.fn(async () => f.generate());
      const diagnostic = vi.fn();
      const completion = f.schedule(generated, diagnostic)();
      if (!exhausted) {
        await firstRefused.promise;
        await vi.advanceTimersByTimeAsync(250);
        await Promise.race([
          queueSettled.promise,
          completion.then(() => {
            throw new Error("media completion ended without durable queue custody");
          }),
        ]);
        await vi.advanceTimersByTimeAsync(500);
      }
      await completion;
      expect(activity.getActiveMediaGenerationRunCount()).toBe(0);
      expect(await f.pending()).toEqual([]);
      if (exhausted) {
        expect(f.operation()).toMatchObject({
          terminalOutcome: "blocked",
        });
        expect(diagnostic).toHaveBeenCalledWith(
          "image_generate blocked completion retention failed",
          expect.objectContaining({ error: expect.any(Error) }),
        );
      } else {
        expect(generated).toHaveBeenCalledOnce();
        expect(f.dispatch).toHaveBeenCalledOnce();
        expect(new Set(enqueue.mock.calls.map(([payload]) => payload.idempotencyKey)).size).toBe(1);
      }
    }),
  );
});

// Fixed provider and model I/O; admission, durable queue, recovery and transcript
// persistence run together so a busy requester cannot look like delivery failure.
describe("queued media completion past the handoff deadline", () => {
  it.each(["delivered", "delivery-failed", "generation-failed"] as const)(
    "waits for the original WebChat turn before settling: %s",
    (outcome) =>
      withMediaSession(async (f) => {
        await fs.mkdir(path.dirname(f.mediaPath), { recursive: true });
        await fs.writeFile(f.mediaPath, createGrayscaleAlphaPngBuffer(1, 1));
        if (outcome === "delivery-failed") {
          f.dispatch.mockRejectedValueOnce(
            new SessionDeliveryDeadLetteredError("delivery permanently refused"),
          );
        } else if (outcome === "generation-failed") {
          f.dispatch.mockResolvedValue({
            status: "ok",
            result: {
              payloads: [{ text: "Generation failed." }],
              deliveryStatus: { status: "sent" },
            },
          });
        }
        const originalOwner = await f.acquire();
        const startedAt = Date.now();
        vi.useFakeTimers({ toFake: ["Date"] });
        const observedQueuedRetry = createDeferredCore();
        let scheduledCount = 0;
        let queueId: string | undefined;
        // Advance past the producer deadline while real recovery defers the row.
        // A repeated receipt or a terminal producer lets the baseline fail without hanging.
        vi.spyOn(queueRuntime, "scheduleSessionDelivery").mockImplementation(async (id) => {
          queueId = id;
          await f.drain(id);
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
          return { ...f.generate(), wakeResult: "Generated a synthetic lighthouse." };
        });
        const scheduled = f.schedule(generated, diagnostic);
        // Launch under the original context; its scope does not own the background job's completion.
        const { backgroundWork } = await originalOwner.run(async () => ({
          backgroundWork: scheduled(),
        }));
        try {
          await Promise.race([backgroundWork, observedQueuedRetry.promise]);
          const pending = await f.pending();
          expect(pending).toHaveLength(1);
          expect(pending[0]).toMatchObject({
            id: queueId,
            retryCount: 0,
            route: { channel: "webchat", to: f.scope.sessionKey },
          });
          expect(pending[0]?.deliveryStartedAt).toBeUndefined();
          expect(f.dispatch).not.toHaveBeenCalled();
          expect(await f.events()).toEqual([]);
          expect(f.operation()).toMatchObject({ status: "running", completionDelivery: "queued" });
          expect(f.operation()?.terminalOutcome).toBeUndefined();
        } finally {
          originalOwner.release();
          await originalOwner.released;
        }
        assert(queueId, "Expected durable completion custody");
        await f.drain(queueId);
        await backgroundWork;
        expect(generated).toHaveBeenCalledOnce();
        expect(f.dispatch).toHaveBeenCalledOnce();
        expect(await f.pending()).toEqual([]);
        const afterRelease = await f.events();
        const serialized = JSON.stringify(afterRelease);
        const operation = f.operation();
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
          expect(serialized).not.toContain("completion delivery was not confirmed");
        } else {
          expect(diagnostic).not.toHaveBeenCalled();
          if (outcome === "delivered") {
            expect(serialized).toContain('"openclawDisplayContent":[{"type":"image"');
            await f.drain(queueId);
            expect(f.dispatch).toHaveBeenCalledOnce();
            expect(await f.events()).toEqual(afterRelease);
          }
        }
      }, "webchat"),
  );
});
