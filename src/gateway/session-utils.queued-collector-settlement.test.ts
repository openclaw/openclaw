import "../agents/subagents/spawn/subagent-spawn-model.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useQueuedCollectorFixture } from "./session-utils.queued-collector.test-support.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../agents/subagents/registry/subagent-lifecycle-events.js";
import {
  getCurrentSubagentRunOwner,
  subagentRuns,
} from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  activateSwarmRun,
  closeSwarmScheduler,
  holdQueuedSwarmRun,
} from "../agents/subagents/swarm/swarm-scheduler.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { sessionAbortHandlers } from "./server-methods/sessions-abort.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils.js";

const { createQueuedReservation, requestContext, requestOptions, expectChanged } =
  useQueuedCollectorFixture();

it.for(["settled", "rejected", "session replaced"] as const)(
  "qualifies queued cancellation only after owned cleanup: %s",
  async (transition, { signal }) => {
    const { entry } = await createQueuedReservation("settled-publication");
    const producer = expectDefined(holdQueuedSwarmRun(entry.runId), "preparation hold");
    const context = requestContext();
    const cleanupEntered = createDeferred();
    const releaseCleanup = createDeferred();
    const failure = new Error("owned queued cleanup failed");
    const readSession = () => loadGatewaySessionEntryReadOnlyAsync(entry.childSessionKey);
    const expectUnpublished = () => {
      const changes = vi
        .mocked(context.broadcastToConnIds)
        .mock.calls.filter(([event]) => event === "sessions.changed")
        .map(([, payload]) => payload);
      expect(changes).not.toContainEqual(expect.objectContaining({ lastRunId: entry.runId }));
    };
    const replacement = {
      sessionId: "replacement-session",
      lifecycleRevision: "replacement-lifecycle",
      lastRunId: "replacement-terminal",
      status: "done" as const,
      abortedLastRun: false,
    };
    const start = vi.fn(async () => {});
    const cleanup = async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      if (transition === "rejected") {
        throw failure;
      }
    };
    const respond = vi.fn();
    let stopping: Promise<void> | undefined;
    let replacementBeforeSettlement: Awaited<ReturnType<typeof readSession>>["entry"];
    try {
      activateSwarmRun({
        groupId: expectDefined(entry.groupId, "queued collector group"),
        runId: entry.runId,
        start,
        onStartFailure: () => true,
        onRemoved: cleanup,
      });
      stopping = Promise.resolve(
        sessionAbortHandlers["sessions.abort"]!({
          ...requestOptions(context, "sessions.abort", {
            key: entry.childSessionKey,
            runId: entry.runId,
            agentId: "main",
          }),
          respond,
        }),
      );
      await withinTest(
        awaitGateBeforeSettlement(
          cleanupEntered.promise,
          stopping,
          "Stop returned before owned cleanup",
        ),
        signal,
      );
      // Current-row notices may arrive later; terminal qualification must await cleanup.
      expectUnpublished();
      expect((await readSession()).entry?.lastRunId).toBeUndefined();
      expect(respond).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();

      if (transition === "session replaced") {
        const selected = await readSession();
        await replaceSessionEntry(
          { storePath: selected.storePath, sessionKey: entry.childSessionKey },
          {
            ...expectDefined(selected.entry, "selected session"),
            ...replacement,
          },
        );
        replacementBeforeSettlement = structuredClone(
          expectDefined((await readSession()).entry, "replacement session"),
        );
      }
      releaseCleanup.resolve();
      await withinTest(stopping, signal);
      await flushPendingSessionsChangedEvents(context);

      const stored = expectDefined((await readSession()).entry, "terminal session");
      const stopped = expectDefined(
        getCurrentSubagentRunOwner(subagentRuns, entry),
        "cancelled collector owner",
      );
      expect(stopped.execution.startedAt).toBeUndefined();
      expect(start).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledOnce();
      // An admitted Stop finishes after replacement; cleanup rejection still fails.
      expect(respond.mock.calls[0]?.[0]).toBe(transition !== "rejected");
      if (transition === "settled") {
        expect(stored).toMatchObject({
          status: "killed",
          lastRunId: entry.runId,
          abortedLastRun: true,
        });
        expectChanged(context, {
          sessionKey: entry.childSessionKey,
          reason: "abort",
          status: "killed",
          hasActiveRun: false,
          lastRunId: entry.runId,
        });
      } else {
        expectUnpublished();
        if (transition === "rejected") {
          expect(stored.lastRunId).toBeUndefined();
          expect(respond.mock.calls[0]?.[2]).toMatchObject({
            message: expect.stringContaining(failure.message),
          });
          await expect(closeSwarmScheduler()).rejects.toMatchObject({ errors: [failure] });
        } else {
          expect(stored).toEqual(
            expectDefined(replacementBeforeSettlement, "replacement before Stop settlement"),
          );
          expect(stopped).toMatchObject({
            endedReason: SUBAGENT_ENDED_REASON_KILLED,
            execution: { status: "terminal" },
          });
        }
      }
      expect([stored.startedAt, stored.runtimeMs]).toEqual([undefined, undefined]);
    } finally {
      releaseCleanup.resolve();
      await Promise.allSettled([stopping]);
      await producer.release();
      await closeSwarmScheduler().catch(() => {});
      await flushPendingSessionsChangedEvents(context);
    }
  },
);
