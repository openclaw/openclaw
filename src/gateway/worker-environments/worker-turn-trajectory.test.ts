import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { loadSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import { createWorkerLiveTrajectoryRecorder } from "./live-event-projection.js";
import { getWorkerTurnExecutionIdentityCapability } from "./placement-turn-claim-events.js";
import { WorkerRunnerCapacityError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  measureLaunchTurn,
  placements,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";

describe("worker turn trajectory authority", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it.each(["current", "revoked-at-commit"] as const)(
    "retains the cold transcript handle through guarded worker persistence (%s)",
    async (authority) => {
      expect(isMainThread).toBe(true);
      seedActivePlacement();
      const input = turn(`trajectory-${authority}`);
      const abort = new AbortController();
      const revoked = new Error("turn revoked before trajectory commit");
      const stop = new WorkerRunnerCapacityError();
      const stages: string[] = [];
      let flushFailure: unknown;
      let hostDatabase: DatabaseSync | undefined;
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(
        async ({ turnClaim }) => {
          const source = getWorkerTurnExecutionIdentityCapability(placements, turnClaim);
          assert(source, "expected the launcher to bind its real receipt authority");
          const recorder = createWorkerLiveTrajectoryRecorder({ runId: input.runId, source });
          assert(recorder, "expected a durable live trajectory recorder");
          recorder.recordEvent("session.started", { backend: "cloud-worker" });
          const options = toDatabaseOptions(resolveSqliteReadScope(source.sessionTarget));
          const pathname = resolveOpenClawAgentSqlitePath(options);
          await closeOpenClawAgentDatabaseByPathAsync(pathname);
          expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();

          let pendingTransaction = false;
          const open = nodeSqlite.openNodeSqliteDatabase;
          const opening = vi
            .spyOn(nodeSqlite, "openNodeSqliteDatabase")
            .mockImplementation((...args) => {
              if (args[0] === pathname && pendingTransaction) {
                throw new Error(
                  "Receipt guard reopened the host database during a worker transaction",
                );
              }
              return open(...args);
            });
          const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
          const admission = vi
            .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
            .mockImplementation((callback, attachment) =>
              createAdmission((request, grant) => {
                if (request.stage === "transaction" || request.stage === "commit") {
                  pendingTransaction = true;
                  stages.push(request.stage);
                  const current = getOpenClawAgentDatabaseIfOpen(options)?.db;
                  assert(current?.isOpen, "receipt checks require the retained host database");
                  if (request.stage === "transaction") {
                    hostDatabase = current;
                  } else {
                    expect(current).toBe(hostDatabase);
                    if (authority === "revoked-at-commit") {
                      abort.abort(revoked);
                    }
                  }
                }
                callback(request, grant);
              }, attachment),
            );
          try {
            await recorder.flush().catch((error: unknown) => {
              flushFailure = error;
            });
          } finally {
            pendingTransaction = false;
            admission.mockRestore();
            opening.mockRestore();
          }
          throw stop;
        },
      );
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        launchTurn,
        measureLaunchTurn,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      };
      const provider = createWorkerSessionTurnPlacementProvider({
        placements,
        environments: {
          ...unusedEnvironments(),
          get: attachedEnvironment,
          acquireTurnCredential: async () => credential(),
          startTunnel: async () => tunnel,
        },
      });
      const runLocal = vi.fn();
      try {
        await expect(
          provider.executeTurn(
            { ...sessionTarget, runId: input.runId },
            { ...input, abortSignal: abort.signal },
            runLocal,
          ),
        ).rejects.toBe(stop);
        expect(launchTurn).toHaveBeenCalledOnce();
        expect(runLocal).not.toHaveBeenCalled();
        expect.soft(stages).toEqual(["transaction", "commit"]);
        const events = await loadSqliteTrajectoryRuntimeEvents(sessionTarget);
        if (authority === "current") {
          expect(flushFailure).toBeUndefined();
          expect(events.map((event) => event.type)).toEqual(["session.started"]);
        } else {
          expect(
            collectNestedErrorCandidates(flushFailure).map((error) =>
              error instanceof Error ? error.message : error,
            ),
          ).toContain(revoked.message);
          expect(events).toEqual([]);
        }
      } finally {
        input.preparedRunAdmission.close();
      }
    },
  );
});
