import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as activity from "../agents/media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../agents/media-generation-activity.test-support.js";
import * as background from "../agents/tools/media-generate-background-shared.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import * as messageRuntime from "../channels/message/runtime.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadTranscriptEvents, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { drainPendingSessionDelivery } from "../infra/session-delivery-queue-recovery.js";
import * as queue from "../infra/session-delivery-queue-storage.js";
import { beginSessionEffect } from "../sessions/session-controller.lifecycle.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
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
  const drain = drainOnce;
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
  it.each([
    "current",
    "replaced-after",
    "rotated-after",
    "store-after",
    "replaced-at-enqueue",
    "store-at-enqueue",
    "generation-at-enqueue",
  ] as const)("keeps successful queue admission bound to the requester: %s", (change) =>
    withMediaSession(async (fixture) => {
      const { state, wake, scope, queueContext, send, systemWake, drain } = fixture;
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
        await drain(entry.id);
        expect(await queue.loadPendingSessionDeliveries(queueContext)).toEqual([]);
        if (change === "current") {
          // Outbound custody carries the requester so a replay cannot outlive it.
          expect(send.mock.calls[0]?.[3]).toEqual(fixture.binding);
        }
      }
      const deliveryCount = change === "current" ? 1 : 0;
      // A retired requester never receives the media.
      expect(send).toHaveBeenCalledTimes(deliveryCount);
      expect(systemWake).not.toHaveBeenCalled();
      expect(await loadTranscriptEvents({ ...scope, sessionId: "replacement-requester" })).toEqual(
        [],
      );
    }),
  );
});
