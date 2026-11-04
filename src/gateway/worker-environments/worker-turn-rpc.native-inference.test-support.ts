import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { publishWorkerEnvironmentFixture } from "./placement-test-fixtures.js";
import * as support from "./service.test-support.js";
type WorkerEnvironmentServiceOptions = support.WorkerEnvironmentServiceOptions;

export function registerWorkerNativeInferenceRpcTests(): void {
  it.each([
    { providerId: "device", inference: "worker" },
    ...[false, null, { mode: "remote" }, "worker"].map((inference) => ({
      providerId: "custom-provider",
      inference,
    })),
  ])(
    "honors provider-owned inference grammar after exact RPC binding %j",
    async ({ providerId, inference }) => {
      const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>(
        async () => ({ type: "error", reason: "provider-error", message: "fixture completed" }),
      );
      const { identity, placementStore, workerService } = await support.placementHarness(
        "worker-local-proxy-denial",
        "session-local-proxy-denial",
        { executeInference },
      );
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<StateDatabase>(db)
              .updateTable("worker_environments")
              .set({
                provider_id: providerId,
                profile_snapshot_json: JSON.stringify({ settings: { inference } }),
              })
              .where("environment_id", "=", identity.environmentId),
          );
          publishWorkerEnvironmentFixture(db, identity.environmentId);
        },
        { database: support.testState.stateDb },
      );
      expect(support.testState.store.get(identity.environmentId)).toMatchObject({
        providerId,
        profileSnapshot: { settings: { inference } },
      });
      expect(workerService.validateWorkerConnection(identity)).toBeNull();
      const request = support.inferenceRequest(identity);
      const send = vi.fn();
      const sink = { connectionId: "worker-local-proxy-attempt", send };
      const start = (overrides: Partial<typeof request> = {}) =>
        workerService.startInference(identity, { ...request, ...overrides }, sink);

      for (const [overrides, reason] of [
        [{ sessionId: "session-other" }, "session-not-attached"],
        [{ runId: "run-other" }, "session-not-attached"],
        [{ runEpoch: request.runEpoch + 1 }, "epoch-mismatch"],
      ] as const) {
        expect(await start(overrides)).toEqual({ ok: false, reason });
      }
      placementStore.validateWorkerTurn.mockReturnValue(false);
      expect(await start()).toEqual({
        ok: false,
        closeReason: "placement-mismatch",
      });
      placementStore.validateWorkerTurn.mockReturnValue(true);
      const started = await start();
      expect(executeInference).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      if (providerId === "device") {
        expect(started).toEqual({ ok: false, reason: "model-not-approved" });
      } else {
        assert(started.ok, "opaque provider inference was refused");
        started.launch();
        await support.waitForFast(() => expect(send).toHaveBeenCalledOnce());
        expect(executeInference).toHaveBeenCalledOnce();
      }
    },
  );
}
