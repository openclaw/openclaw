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
import * as sessionEvents from "./server-methods/session-change-event.js";
import { sessionAbortHandlers } from "./server-methods/sessions-abort.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

const { createQueuedReservation, requestContext, operatorClient } = useQueuedCollectorFixture();

it.for(["settled", "rejected", "session replaced"] as const)(
  "qualifies queued cancellation only after owned cleanup: %s",
  async (transition, { signal }) => {
    const { entry } = await createQueuedReservation("settled-publication");
    const producer = expectDefined(holdQueuedSwarmRun(entry.runId), "preparation hold");
    const context = requestContext();
    const cleanupEntered = createDeferred();
    const releaseCleanup = createDeferred();
    const initialPublication = createDeferred();
    const failure = new Error("owned queued cleanup failed");
    const publications: Array<string | undefined> = [];
    let cleanupSettled = false;
    const start = vi.fn(async () => {});
    const cleanup = vi.fn(async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      if (transition === "rejected") {
        throw failure;
      }
      cleanupSettled = true;
    });
    const emit = sessionEvents.emitSessionsChanged;
    const publicationSpy = vi
      .spyOn(sessionEvents, "emitSessionsChanged")
      .mockImplementation((owner, payload, options) => {
        const selected =
          owner === context &&
          payload.sessionKey === entry.childSessionKey &&
          payload.reason === "abort";
        if (selected) {
          const view = expectDefined(options?.sessionRows, "prepared cancellation rows");
          const row = expectDefined(
            view.describe({ agentId: "main", key: entry.childSessionKey }),
            "cancelled collector row",
          );
          publications.push(view.present(row).lastRunId);
        }
        emit(owner, payload, options);
        if (selected && publications.length === 1) {
          initialPublication.resolve();
        }
      });
    const respond = vi.fn();
    let stopping: Promise<void> | undefined;
    try {
      activateSwarmRun({
        groupId: expectDefined(entry.groupId, "queued collector group"),
        runId: entry.runId,
        start,
        onStartFailure: () => true,
        onRemoved: cleanup,
      });
      stopping = Promise.resolve(
        expectDefined(
          sessionAbortHandlers["sessions.abort"],
          "Stop handler",
        )({
          req: { type: "req", id: "settled-queued-stop", method: "sessions.abort" },
          params: { key: entry.childSessionKey, runId: entry.runId, agentId: "main" },
          client: operatorClient(),
          isWebchatConnect: () => false,
          context,
          respond,
        }),
      );
      await withinTest(
        awaitGateBeforeSettlement(
          Promise.all([cleanupEntered.promise, initialPublication.promise]),
          stopping,
          "Stop returned before its initial notice and owned cleanup",
        ),
        signal,
      );
      expect(publications).toEqual([undefined]);
      expect(cleanupSettled).toBe(false);
      expect(
        loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry?.lastRunId,
      ).toBeUndefined();
      expect(respond).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();

      if (transition === "session replaced") {
        const selected = loadGatewaySessionEntryReadOnly(entry.childSessionKey);
        await replaceSessionEntry(
          { storePath: selected.storePath, sessionKey: entry.childSessionKey },
          {
            ...expectDefined(selected.entry, "selected session"),
            sessionId: "replacement-session",
            lifecycleRevision: "replacement-lifecycle",
            lastRunId: "replacement-terminal",
            status: "done",
            abortedLastRun: false,
          },
        );
      }
      releaseCleanup.resolve();
      await withinTest(stopping, signal);

      const stored = expectDefined(
        loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry,
        "terminal session",
      );
      const stopped = expectDefined(
        getCurrentSubagentRunOwner(subagentRuns, entry),
        "cancelled collector owner",
      );
      expect(stopped.execution.startedAt).toBeUndefined();
      expect(start).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledOnce();
      if (transition === "settled") {
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        expect(stored).toMatchObject({
          status: "killed",
          lastRunId: entry.runId,
          abortedLastRun: true,
        });
        expect(publications).toEqual([undefined, entry.runId]);
        expect(context.broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({
            sessionKey: entry.childSessionKey,
            reason: "abort",
            status: "killed",
            hasActiveRun: false,
            lastRunId: entry.runId,
          }),
          new Set(["observer"]),
          expect.any(Object),
        );
      } else {
        expect(respond.mock.calls[0]?.[0]).toBe(false);
        expect(publications).toEqual([undefined]);
        expect(stored.lastRunId).toBe(
          transition === "session replaced" ? "replacement-terminal" : undefined,
        );
        if (transition === "rejected") {
          expect(respond.mock.calls[0]?.[2]).toMatchObject({
            message: expect.stringContaining(failure.message),
          });
          await expect(closeSwarmScheduler()).rejects.toMatchObject({ errors: [failure] });
        } else {
          expect(stored).toMatchObject({
            sessionId: "replacement-session",
            lifecycleRevision: "replacement-lifecycle",
            status: "done",
          });
        }
      }
      expect(stored.startedAt).toBeUndefined();
      expect(stored.runtimeMs).toBeUndefined();
    } finally {
      releaseCleanup.resolve();
      await Promise.allSettled([stopping]);
      await producer.release();
      await closeSwarmScheduler().catch(() => {});
      publicationSpy.mockRestore();
    }
  },
);
