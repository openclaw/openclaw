import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { drainStoreWriterQueuesForTest } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import { getAgentRunContext, getAgentRunContextOwnership } from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  runOpenClawAgentWorkerWrite,
  SQLITE_SESSION_WRITER_QUEUES,
} from "../../state/openclaw-agent-write-admission.js";
import * as trajectoryStore from "../../trajectory/runtime-store.sqlite.js";
import { createTrajectoryRuntimeRecorder } from "../../trajectory/runtime.js";
import { dispatchWorkerRequest } from "../server/ws-connection/worker-connection-dispatch.js";
import { createWorkerLiveEventReceiver } from "./live-events.js";
import * as support from "./service.test-support.js";

describe("worker live event write settlement", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["persisted", "failed", "revoked", "stopped"] as const)(
    "joins accepted trajectory writes before RPC acknowledgment (%s)",
    async (outcome) => {
      const sessionId = "session-live-settlement";
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
          "worker-live-settlement",
          sessionId,
          { liveEvents: receiver },
          target,
        );
      const sourceOwnerClaims = new Set(
        expectDefined(getAgentRunContextOwnership(identity.runId!), "source run owner").claimIds,
      );
      identity.protocolFeatures = ["worker-live-event-v1"];
      const terminal = support.terminalEvent(identity, { seq: 2 });
      await expect(workerService.pushLiveEvent(identity, terminal)).resolves.toEqual({
        ok: true,
        result: { ackedSeq: 0 },
      });

      const failureDatabase =
        outcome === "failed"
          ? openOpenClawAgentDatabase({ agentId: "main", path: storePath })
          : undefined;
      if (failureDatabase) {
        const warmupTarget = {
          ...target,
          sessionId: "session-live-settlement-warmup",
          sessionKey: "agent:main:live-settlement-warmup",
        };
        await upsertSessionEntryCore(warmupTarget, {
          sessionId: warmupTarget.sessionId,
          updatedAt: 1,
        });
        const warmup = expectDefined(
          createTrajectoryRuntimeRecorder({
            sessionId: warmupTarget.sessionId,
            sessionTarget: warmupTarget,
          }),
          "worker warmup recorder",
        );
        warmup.recordEvent("worker.warmup");
        await warmup.flush();
        // Admit the real worker before adding a fault that must fail INSERT, not schema validation.
        failureDatabase.db.exec(`CREATE TRIGGER reject_live_trajectory_append
          BEFORE INSERT ON trajectory_runtime_events
          BEGIN SELECT RAISE(ABORT, 'synthetic trajectory persistence failure'); END`);
        warmup.recordEvent("worker.trigger-probe");
        await expect(warmup.flush()).rejects.toThrow("synthetic trajectory persistence failure");
      }

      const entered = createDeferredCore();
      const release = createDeferredCore();
      const reservation = runOpenClawAgentWorkerWrite(
        { agentId: "main", path: storePath },
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
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
      let replay: Promise<Awaited<ReturnType<typeof receiver.apply>>> | undefined;
      let stopped: Promise<void> | undefined;
      try {
        await entered.promise;
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
          .then((result) => {
            replaySettled = true;
            return result;
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
        expect(replaySettled).toBe(false);
        expect(shutdownSettled).toBe(false);
        expect(placementStore.updateAckCursors).not.toHaveBeenCalled();
        expect(trajectoryStore.loadSqliteTrajectoryRuntimeEventRowsSync(target)).toEqual([]);
        if (outcome === "stopped") {
          expect(getAgentRunContextOwnership(identity.runId!)?.claimIds).toEqual(sourceOwnerClaims);
        }

        release.resolve();
        await reservation;
        await request;
        await replay;
        await stopped;
        if (outcome === "stopped") {
          releaseSource();
          expect(getAgentRunContext(identity.runId!)).toBeUndefined();
        }
        expect(phases).toEqual(["start", "end"]);
        const rows = trajectoryStore.loadSqliteTrajectoryRuntimeEventRowsSync(target);
        if (outcome === "failed" || outcome === "revoked") {
          expect(rows).toEqual([]);
        } else {
          expect(rows.map((row) => row.event.type)).toEqual([
            "session.started",
            "model.completed",
            "session.ended",
          ]);
        }
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
          });
          expect(close).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        await reservation;
        await request;
        await replay;
        await stopped;
        await workerService.stop();
        releaseSource();
        unsubscribe();
        failureDatabase?.db.exec("DROP TRIGGER reject_live_trajectory_append");
        await drainStoreWriterQueuesForTest(
          SQLITE_SESSION_WRITER_QUEUES,
          "live event test cleanup",
        );
        closeOpenClawAgentDatabasesForTest();
      }
    },
  );
});
