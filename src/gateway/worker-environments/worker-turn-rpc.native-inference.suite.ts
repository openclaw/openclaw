import { expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { hashWorkerCredential } from "./credential.js";
import { publishWorkerEnvironmentFixture } from "./placement-test-fixtures.js";
import * as support from "./service.test-support.js";
type WorkerEnvironmentServiceOptions = support.WorkerEnvironmentServiceOptions;

export function registerWorkerNativeInferenceRpcTests(): void {
  it.each(["worker", "runtime-local"])(
    "denies Gateway inference for stored %s placement after exact binding",
    async (inference) => {
      const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>();
      const { identity, placementStore, workerService } = await support.placementHarness(
        "worker-runtime-local-proxy-denial",
        "session-runtime-local-proxy-denial",
        { executeInference },
      );
      // Seed immutable profile facts through the same transaction/publication owner
      // as the other placement fixtures; do not mutate live config or mock the gate.
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<StateDatabase>(db)
              .updateTable("worker_environments")
              .set({
                provider_id: "device",
                node_device_id: "paired-inference-node",
                shared_host: 1,
                ssh_host: null,
                ssh_port: null,
                ssh_user: null,
                ssh_host_key: null,
                ssh_key_ref_json: null,
                profile_snapshot_json: JSON.stringify({ settings: { inference } }),
              })
              .where("environment_id", "=", identity.environmentId),
          );
          publishWorkerEnvironmentFixture(db, identity.environmentId);
        },
        { database: support.testState.stateDb },
      );
      expect(support.testState.store.get(identity.environmentId)).toMatchObject({
        providerId: "device",
        profileSnapshot: { settings: { inference } },
      });
      expect(workerService.validateWorkerConnection(identity)).toBeNull();
      const request = support.inferenceRequest(identity);
      const send = vi.fn();
      const sink = { connectionId: "runtime-local-proxy-attempt", send };

      expect(
        await workerService.startInference(
          identity,
          { ...request, sessionId: "session-other" },
          sink,
        ),
      ).toEqual({ ok: false, reason: "session-not-attached" });
      expect(
        await workerService.startInference(identity, { ...request, runId: "run-other" }, sink),
      ).toEqual({ ok: false, reason: "session-not-attached" });
      expect(
        await workerService.startInference(
          identity,
          { ...request, runEpoch: request.runEpoch + 1 },
          sink,
        ),
      ).toEqual({ ok: false, reason: "epoch-mismatch" });
      placementStore.validateWorkerTurn.mockReturnValue(false);
      expect(await workerService.startInference(identity, request, sink)).toEqual({
        ok: false,
        closeReason: "placement-mismatch",
      });
      placementStore.validateWorkerTurn.mockReturnValue(true);
      expect(await workerService.startInference(identity, request, sink)).toEqual({
        ok: false,
        reason: "model-not-approved",
      });
      expect(executeInference).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("fences inference by epoch and the durable session credential", async () => {
    const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>(
      async () => ({
        type: "error",
        reason: "provider-error",
        message: "Provider request failed",
      }),
    );
    const { identity, workerService } = await support.placementHarness(
      "worker-inference-fence",
      "session-inference-fence",
      { executeInference },
    );
    const request = support.inferenceRequest(identity);
    expect(
      await workerService.startInference(
        identity,
        { ...request, sessionId: "session-other" },
        { connectionId: "connection-a", send: vi.fn() },
      ),
    ).toEqual({ ok: false, reason: "session-not-attached" });
    expect(
      await workerService.startInference(
        identity,
        { ...request, runEpoch: request.runEpoch + 1 },
        { connectionId: "connection-b", send: vi.fn() },
      ),
    ).toEqual({ ok: false, reason: "epoch-mismatch" });

    const send = vi.fn();
    const started = await workerService.startInference(identity, request, {
      connectionId: "connection-c",
      send,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error("inference fixture failed to start");
    }
    await support.testState.store.renewCredential({
      environmentId: identity.environmentId,
      expectedOwnerEpoch: identity.ownerEpoch,
      sessionId: identity.sessionId,
      rpcSetVersion: identity.rpcSetVersion,
      expiresAtMs: identity.credentialExpiresAtMs,
      credentialHash: hashWorkerCredential(["replacement", identity.environmentId].join("-")),
    });
    started.launch();
    await support.waitForFast(() => expect(send).toHaveBeenCalledOnce());
    expect(executeInference).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      event: "worker.inference.terminal",
      payload: { outcome: { reason: "session-not-attached" } },
    });
  });
}
