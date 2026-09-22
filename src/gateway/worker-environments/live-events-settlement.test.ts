import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { drainStoreWriterQueuesForTest } from "../../shared/store-writer-queue.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  runOpenClawAgentWorkerWrite,
  SQLITE_SESSION_WRITER_QUEUES,
} from "../../state/openclaw-agent-write-admission.js";
import * as trajectoryStore from "../../trajectory/runtime-store.sqlite.js";
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
      const target = { agentId: "main", sessionId, storePath };
      await upsertSessionEntryCore(
        { ...target, sessionKey: "agent:main:live-settlement" },
        { sessionId, updatedAt: 1 },
      );
      support.testState.config.session = { store: storePath };
      const receiver = createWorkerLiveEventReceiver({
        getConfig: () => support.testState.config,
        startupBindings: [],
        startupOwners: new Map(),
      });
      const { identity, placementStore, workerService } = support.placementHarness(
        "worker-live-settlement",
        sessionId,
        { liveEvents: receiver },
      );
      identity.protocolFeatures = ["worker-live-event-v1"];
      expect(
        receiver.bindSession({
          environmentId: identity.environmentId,
          runEpoch: identity.ownerEpoch,
          sessionId,
        }),
      ).toBe(true);
      receiver.start();
      const terminal = support.terminalEvent(identity, { seq: 2 });
      await expect(workerService.pushLiveEvent(identity, terminal)).resolves.toEqual({
        ok: true,
        result: { ackedSeq: 0 },
      });

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
      const append =
        outcome === "failed"
          ? vi
              .spyOn(trajectoryStore, "appendSqliteTrajectoryRuntimeEvents")
              .mockImplementation(() => {
                throw new Error("synthetic trajectory persistence failure");
              })
          : undefined;
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
        replay = receiver.apply({ identity, request: terminal }).then((result) => {
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
          expect(getAgentRunContext(identity.runId!)).toBeUndefined();
        }

        release.resolve();
        await reservation;
        await request;
        await replay;
        await stopped;
        expect(phases).toEqual(["start", "end"]);
        const rows = trajectoryStore.loadSqliteTrajectoryRuntimeEventRowsSync(target);
        if (outcome === "failed") {
          expect(append).toHaveBeenCalled();
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
        unsubscribe();
        append?.mockRestore();
        await drainStoreWriterQueuesForTest(
          SQLITE_SESSION_WRITER_QUEUES,
          "live event test cleanup",
        );
        closeOpenClawAgentDatabasesForTest();
      }
    },
  );
});
