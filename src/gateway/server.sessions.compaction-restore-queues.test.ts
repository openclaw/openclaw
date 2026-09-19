import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import * as embeddedRuns from "../agents/embedded-agent-runner/runs.js";
import * as cleanup from "../auto-reply/reply/queue/cleanup.js";
import { scheduleFollowupDrain } from "../auto-reply/reply/queue/drain.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import { getExistingFollowupQueue } from "../auto-reply/reply/queue/state.js";
import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  CommandLaneClearedError,
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { rpcReq } from "./test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

// The shared Gateway fixture stubs cleanup and embedded waits. This regression
// uses the production owners, including their real 15-second settlement budgets.
beforeEach(async () => {
  const realCleanup = await vi.importActual<typeof cleanup>("../auto-reply/reply/queue/cleanup.js");
  // Resolve after the shared fixture registers mocks; static imports retain the earlier module.
  const cleanupModule = await import("../auto-reply/reply/queue/cleanup.js");
  vi.spyOn(cleanupModule, "clearSessionQueues").mockImplementation(realCleanup.clearSessionQueues);
  const realRuns = await vi.importActual<typeof embeddedRuns>(
    "../agents/embedded-agent-runner/runs.js",
  );
  const runsModule = await import("../agents/embedded-agent-runner/runs.js");
  vi.spyOn(runsModule, "isEmbeddedAgentRunActive").mockImplementation(
    realRuns.isEmbeddedAgentRunActive,
  );
  vi.spyOn(runsModule, "abortEmbeddedAgentRun").mockImplementation(realRuns.abortEmbeddedAgentRun);
  vi.spyOn(runsModule, "waitForEmbeddedAgentRunEnd").mockImplementation(
    realRuns.waitForEmbeddedAgentRunEnd,
  );
});

afterEach(() => vi.restoreAllMocks());

async function seedCheckpoint() {
  const { dir, storePath } = await createSessionStoreDir();
  const sessionId = randomUUID();
  const sessionKey = "agent:main:main";
  const target = { agentId: "main", sessionKey, sessionId, storePath };
  await upsertSessionEntryCore(target, sessionStoreEntry(sessionId));
  const prefix = await appendTranscriptMessage(target, {
    message: { role: "user", content: "checkpoint prefix", timestamp: Date.now() },
  });
  if (!prefix) {
    throw new Error("checkpoint fixture needs a stored transcript boundary");
  }
  const boundary = prefix.messageId;
  await patchSessionEntryCore(target, () => ({
    compactionCheckpoints: [
      {
        checkpointId: "restore-queue-checkpoint",
        sessionKey,
        sessionId,
        createdAt: Date.now(),
        reason: "manual",
        preCompaction: { sessionId, leafId: boundary },
        postCompaction: { sessionId, leafId: boundary },
      },
    ],
  }));
  await appendTranscriptMessage(target, {
    message: { role: "user", content: "after checkpoint", timestamp: Date.now() },
  });
  return { dir, target };
}

function queuedFollowup(
  target: { agentId: string; sessionId: string; sessionKey: string },
  dir: string,
  messageId: string,
): FollowupRun {
  return {
    messageId,
    prompt: messageId,
    enqueuedAt: Date.now(),
    run: {
      agentId: target.agentId,
      agentDir: dir,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionFile: target.sessionId,
      workspaceDir: dir,
      config: {},
      provider: "openai",
      model: "gpt-test",
      timeoutMs: 30_000,
      blockReplyBreak: "text_end",
    },
  };
}

test.each(["admission", "embedded", "created"] as const)(
  "sessions.compaction.restore preserves accepted FIFO work until durable success: %s",
  async (scenario) => {
    const { dir, target } = await seedCheckpoint();
    const { ws } = await openClient();
    const beforeEntry = structuredClone(loadSessionEntry({ ...target, readConsistency: "latest" }));
    const beforeRows = await loadTranscriptEvents(target);
    const lane = resolveEmbeddedSessionLane(target.sessionKey);
    const commandRelease = createDeferred();
    const commandStarted = createDeferred();
    const commandOrder: string[] = [];
    const followupOrder: string[] = [];
    let interrupted = false;
    const handle: embeddedRuns.EmbeddedAgentQueueHandle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      isAborted: () => interrupted,
      abort: () => {
        interrupted = true;
      },
    };
    const admission =
      scenario === "admission"
        ? await beginSessionWorkAdmission({
            scope: target.storePath,
            identities: ["main", target.sessionKey, target.sessionId],
            assertAllowed: () => {},
            onInterrupt: () => {
              interrupted = true;
            },
          })
        : undefined;
    if (scenario === "embedded") {
      embeddedRuns.setActiveEmbeddedRun(target.sessionId, handle, target.sessionKey);
    }
    setCommandLaneConcurrency(lane, 1);
    const blocker = enqueueCommandInLane(lane, async () => {
      commandStarted.resolve();
      await commandRelease.promise;
    });
    await commandStarted.promise;
    const commandResults = ["command-first", "command-second"].map((name) =>
      enqueueCommandInLane(lane, async () => {
        commandOrder.push(name);
      }).then(
        () => "completed",
        (error: unknown) => error,
      ),
    );
    const followups = ["followup-first", "followup-second"].map((name) =>
      queuedFollowup(target, dir, name),
    );
    for (const run of followups) {
      expect(
        enqueueFollowupRun(
          target.sessionKey,
          run,
          { mode: "followup", debounceMs: 0 },
          "none",
          undefined,
          false,
        ),
      ).toBe(true);
    }
    expect(getCommandLaneSnapshot(lane).queuedCount).toBe(2);
    let successor: Promise<FollowupRun> | undefined;
    const stopObserving = onSessionIdentityMutation((mutation) => {
      if (
        scenario !== "created" ||
        mutation.kind !== "replace" ||
        mutation.previous.sessionId !== target.sessionId ||
        !mutation.current.sessionId
      ) {
        return;
      }
      const nextTarget = { ...target, sessionId: mutation.current.sessionId };
      successor = beginSessionWorkAdmission({
        scope: target.storePath,
        identities: [target.sessionKey, nextTarget.sessionId],
        assertAllowed: () => {
          expect(loadSessionEntry({ ...nextTarget, readConsistency: "latest" })?.sessionId).toBe(
            nextTarget.sessionId,
          );
        },
      }).then(async (lease) => {
        try {
          return await lease.run(async () => {
            const run = queuedFollowup(nextTarget, dir, "successor-followup");
            expect(
              enqueueFollowupRun(
                target.sessionKey,
                run,
                { mode: "followup", debounceMs: 0 },
                "none",
                undefined,
                false,
              ),
            ).toBe(true);
            return run;
          });
        } finally {
          lease.release();
        }
      });
    });
    try {
      const restored = await rpcReq<{ sessionId: string }>(
        ws,
        "sessions.compaction.restore",
        {
          key: "main",
          checkpointId: "restore-queue-checkpoint",
        },
        20_000,
      );
      if (scenario === "created") {
        expect(restored.ok).toBe(true);
        expect(restored.payload?.sessionId).not.toBe(target.sessionId);
        expect(loadSessionEntry({ ...target, readConsistency: "latest" })?.sessionId).toBe(
          restored.payload?.sessionId,
        );
        expect(successor).toBeDefined();
        const nextRun = await successor;
        expect(nextRun?.queueAbortSignal?.aborted).toBe(false);
        expect(
          getExistingFollowupQueue(target.sessionKey)?.items.map((run) => run.messageId),
        ).toEqual(["successor-followup"]);
        expect(followups.map((run) => run.queueAbortSignal?.aborted)).toEqual([true, true]);
        for (const result of await Promise.all(commandResults)) {
          expect(result).toBeInstanceOf(CommandLaneClearedError);
        }
        expect(commandOrder).toEqual([]);
        const restoredRows = await loadTranscriptEvents({
          ...target,
          sessionId: restored.payload!.sessionId,
        });
        expect(JSON.stringify(restoredRows)).toContain("checkpoint prefix");
        expect(JSON.stringify(restoredRows)).not.toContain("after checkpoint");
        scheduleFollowupDrain(target.sessionKey, async (run) => {
          followupOrder.push(run.prompt);
        });
        await vi.waitFor(() => expect(followupOrder).toEqual(["successor-followup"]));
      } else {
        expect(restored.ok).toBe(false);
        expect(restored.error?.code).toBe("UNAVAILABLE");
        expect(interrupted).toBe(true);
        expect(loadSessionEntry({ ...target, readConsistency: "latest" })).toEqual(beforeEntry);
        expect(await loadTranscriptEvents(target)).toEqual(beforeRows);
        expect(
          getExistingFollowupQueue(target.sessionKey)?.items.map((run) => run.messageId),
        ).toEqual(["followup-first", "followup-second"]);
        expect(followups.map((run) => run.queueAbortSignal?.aborted)).toEqual([false, false]);
        expect(getCommandLaneSnapshot(lane).queuedCount).toBe(2);
        admission?.release();
        embeddedRuns.clearActiveEmbeddedRun(target.sessionId, handle, target.sessionKey);
        commandRelease.resolve();
        expect(await Promise.all(commandResults)).toEqual(["completed", "completed"]);
        expect(commandOrder).toEqual(["command-first", "command-second"]);
        scheduleFollowupDrain(target.sessionKey, async (run) => {
          followupOrder.push(run.prompt);
        });
        await vi.waitFor(() =>
          expect(followupOrder).toEqual(["followup-first", "followup-second"]),
        );
      }
    } finally {
      stopObserving();
      await Promise.allSettled(successor ? [successor] : []);
      admission?.release();
      embeddedRuns.clearActiveEmbeddedRun(target.sessionId, handle, target.sessionKey);
      commandRelease.resolve();
      await Promise.all([blocker, ...commandResults]);
      cleanup.clearSessionQueues(["main", target.sessionKey, target.sessionId]);
      await closeGatewayTestWebSocket(ws);
    }
  },
  25_000,
);
