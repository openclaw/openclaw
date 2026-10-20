import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { drainStoreWriterQueuesForTest } from "../../../test/helpers/promise.js";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import {
  getAgentRunContext as runContext,
  getAgentRunContextOwnership as runOwnership,
} from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission-state.js";
import { loadSqliteTrajectoryRuntimeEventRowsSync as readRows } from "../../trajectory/runtime-store.sqlite.js";
import { createTrajectoryRuntimeRecorder } from "../../trajectory/runtime.js";
import { dispatchWorkerRequest } from "../server/ws-connection/worker-connection-dispatch.js";
import { createWorkerLiveEventReceiver } from "./live-events.js";
import { holdWorkerTranscriptWriter } from "./live-events.test-support.js";
import * as support from "./service.test-support.js";

const fault = useSqliteWorkerFault([
  {
    name: "reject_live_trajectory_append",
    match: /^insert into trajectory_runtime_events\b/u,
    sql: `CREATE TEMP TRIGGER reject_live_trajectory_append BEFORE INSERT ON main.trajectory_runtime_events
      BEGIN SELECT RAISE(ABORT, 'synthetic trajectory persistence failure'); END;`,
  },
]);

support.setupWorkerEnvironmentServiceSuite();

it.each(["persisted", "failed", "revoked", "stopped"] as const)(
  "worker live event settlement joins writes before RPC acknowledgment (%s)",
  async (outcome) => {
    const sessionId = "live-settlement";
    const storePath = path.join(support.testState.root, "shared.sqlite");
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:live-settlement",
      storePath,
    };
    await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
    support.testState.config.session = { store: storePath };
    const receiver = createWorkerLiveEventReceiver();
    const { identity, placementStore, source, releaseSource, workerService } =
      await support.placementHarness(
        "live-settlement",
        sessionId,
        { liveEvents: receiver },
        target,
      );
    await workerService.ready();
    const sourceOwnerClaims = new Set(
      expectDefined(runOwnership(identity.runId!), "source run owner").claimIds,
    );
    identity.protocolFeatures = ["worker-live-event-v1"];
    const terminal = support.terminalEvent(identity, { seq: 2 });
    await expect(workerService.pushLiveEvent(identity, terminal)).resolves.toEqual({
      ok: true,
      result: { ackedSeq: 0 },
    });

    if (outcome === "failed") {
      const warmupId = "warmup";
      const warmupTarget = { ...target, sessionId: warmupId, sessionKey: "agent:main:warmup" };
      await upsertSessionEntryCore(warmupTarget, { sessionId: warmupId, updatedAt: 1 });
      const warmup = expectDefined(
        await createTrajectoryRuntimeRecorder({
          sessionId: warmupId,
          sessionTarget: warmupTarget,
        }),
        "worker warmup recorder",
      );
      warmup.recordEvent("worker.warmup");
      await warmup.flush();
      fault.enable();
      warmup.recordEvent("worker.trigger-probe");
      await expect(warmup.flush()).rejects.toThrow("synthetic trajectory persistence failure");
    }

    const writer = holdWorkerTranscriptWriter(storePath);
    const emitted = createDeferredCore();
    const phases: unknown[] = [];
    const unsubscribe = onAgentRuntimeEvent((event) => {
      if (event.runId === identity.runId) {
        phases.push(event.data.phase);
        if (event.data.phase === "end") {
          emitted.resolve();
        }
      }
    });
    const respond = vi.fn();
    const close = vi.fn();
    let request: Promise<void> | undefined;
    let replay: Promise<void> | undefined;
    let stopped: Promise<void> | undefined;
    try {
      await writer.entered;
      request = dispatchWorkerRequest({
        request: {
          type: "req",
          id: "live-settlement",
          method: "worker.live-event",
          params: {
            ...support.assistantEvent(identity, "start"),
            event: { kind: "lifecycle", payload: { phase: "start", startedAt: 1 } },
          },
        },
        identity,
        connectionId: "connection-live-settlement",
        service: workerService,
        send: vi.fn(),
        respond,
        close,
        warn: vi.fn(),
      });
      await emitted.promise;
      expect(phases).toEqual(["start", "end"]);
      // A duplicate ACK must join the same accepted prefix without replaying it.
      let replaySettled = false;
      replay = receiver
        .apply({ identity, request: terminal, source, readAckedSeq: () => 0 })
        .then(() => {
          replaySettled = true;
        });
      let shutdownSettled = false;
      if (outcome === "revoked") {
        placementStore.validateWorkerTurn.mockReturnValue(false);
      } else if (outcome === "stopped") {
        stopped = workerService.stop().then(() => {
          shutdownSettled = true;
        });
      }
      await setImmediate();
      expect(respond).not.toHaveBeenCalled();
      expect([replaySettled, shutdownSettled]).toEqual([false, false]);
      expect(placementStore.updateAckCursors).not.toHaveBeenCalled();
      expect(readRows(target)).toEqual([]);
      if (outcome === "stopped") {
        expect(runOwnership(identity.runId!)?.claimIds).toEqual(sourceOwnerClaims);
      }

      writer.release();
      await writer.done;
      await Promise.all([request, replay, stopped]);
      if (outcome === "stopped") {
        releaseSource();
        expect(runContext(identity.runId!)).toBeUndefined();
      }
      expect(phases).toEqual(["start", "end"]);
      expect(readRows(target).map((row) => row.event.type)).toEqual(
        outcome === "failed" || outcome === "revoked"
          ? []
          : ["session.started", "model.completed", "session.ended"],
      );
      if (outcome === "revoked" || outcome === "stopped") {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            details: {
              reason: outcome === "revoked" ? "placement-mismatch" : "environment-unavailable",
            },
          }),
        );
        expect(placementStore.updateAckCursors).not.toHaveBeenCalled();
      } else {
        expect(respond).toHaveBeenCalledWith(true, { ackedSeq: 2 });
        expect(placementStore.updateAckCursors).toHaveBeenCalledExactlyOnceWith({
          claim: identity.turnClaim,
          liveSeq: 2,
          assertCurrent: expect.any(Function),
        });
        expect(close).not.toHaveBeenCalled();
      }
    } finally {
      writer.release();
      await writer.done;
      await Promise.all([request, replay, stopped]);
      await workerService.stop();
      releaseSource();
      unsubscribe();
      fault.disable();
      await drainStoreWriterQueuesForTest(SQLITE_SESSION_WRITER_QUEUES, "live event test cleanup");
      closeOpenClawAgentDatabasesForTest();
    }
  },
);
