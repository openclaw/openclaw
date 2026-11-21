import "./store-publication.test-support.js";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import {
  WORKER_INFERENCE_PROTOCOL_FEATURE,
  validateWorkerInferenceTerminalFrame,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createSink, DONE } from "./inference.test-support.js";
import * as support from "./service.test-support.js";
import {
  bindClaimOwner,
  claimAdmission,
  claimService,
} from "./worker-turn-rpc-fixtures.test-support.js";
import { claimWorkerPlacement } from "./worker-turn-rpc.test-support.js";

const { delivery } = await import("./store-publication.test-support.js");

const delta = { type: "text_delta", contentIndex: 0, delta: "preserved provider output" } as const;
const inferenceFrame = (event: string, payload: unknown) => ({
  type: "event",
  event: `worker.inference.${event}`,
  payload,
});

support.setupWorkerEnvironmentServiceSuite();

it.each(["diagnostic", "credential revocation"] as const)(
  "revalidates provider output while %s commit publication is delayed",
  async (mutationKind) => {
    const { store } = support.testState;
    const environmentId = "worker-inference-publication";
    const sessionId = "session-inference-publication";
    const receipt = {
      ...support.BOOTSTRAP_RECEIPT,
      protocolFeatures: [WORKER_INFERENCE_PROTOCOL_FEATURE],
    };
    support.testState.prepareInstallation = vi.fn(async () => ({
      ...support.BUNDLE_ARTIFACT,
      protocolFeatures: receipt.protocolFeatures,
    }));
    const bootstrapping = await support.seedBootstrapping(environmentId);
    await store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: support.readyPatch(environmentId, receipt),
    });
    const attached = await store.transition({
      environmentId,
      from: "ready",
      to: "attached",
      patch: support.attachedPatch(environmentId, sessionId),
    });
    const { claim, store: placements } = await claimWorkerPlacement({
      environmentId,
      ownerEpoch: attached.ownerEpoch,
      sessionId,
    });
    const entered = createDeferredCore<AbortSignal>();
    const continueProvider = createDeferredCore();
    const committed = createDeferredCore();
    const publish = createDeferredCore();
    const { frames, sink, terminal: terminalDelivered } = createSink("inference-publication");
    const executeInference: support.WorkerEnvironmentServiceOptions["executeInference"] = async ({
      signal,
      emit,
    }) => {
      entered.resolve(signal);
      await continueProvider.promise;
      emit(delta);
      return DONE;
    };
    const workerService = claimService(placements, { executeInference });
    let mutation: Promise<unknown> | undefined;
    let owner: Awaited<ReturnType<typeof bindClaimOwner>> | undefined;
    try {
      owner = await bindClaimOwner(placements, claim, {
        assertCurrent: () => {
          if (!placements.validateTurnClaim(claim)) {
            throw new Error("Worker publication fixture claim is no longer current");
          }
        },
      });
      const grant = await workerService.acquireTurnCredential(claim);
      expect(await workerService.acknowledgeCredentialDelivery(grant)).toBe(true);
      const admission = await workerService.admitWorker(
        claimAdmission(claim, grant.credential, receipt),
      );
      assert(admission.ok, "Worker inference admission failed");
      const identity = admission.identity;
      const request = support.inferenceRequest(identity);
      const started = await workerService.startInference(identity, request, sink);
      assert(started.ok, "Worker inference start failed");
      expect(started.result).toEqual({ status: "accepted" });
      started.launch();
      const providerSignal = await awaitGateBeforeSettlement(
        entered.promise,
        terminalDelivered,
        "Inference terminated before provider execution",
      );
      delivery.command =
        mutationKind === "diagnostic"
          ? "workerEnvironments.recordError"
          : "workerEnvironments.revokeEnvironmentCredential";
      delivery.afterCommit = async () => {
        committed.resolve();
        await publish.promise;
      };
      mutation =
        mutationKind === "diagnostic"
          ? store.recordError({
              environmentId,
              state: "attached",
              error: "unrelated provider diagnostic",
            })
          : store.revokeEnvironmentCredential(environmentId);
      await awaitGateBeforeSettlement(
        committed.promise,
        mutation,
        "Inventory mutation finished before its publication gate",
      );
      continueProvider.resolve();
      const terminal = await terminalDelivered;
      expect(validateWorkerInferenceTerminalFrame(terminal)).toBe(true);
      expect(providerSignal.aborted).toBe(mutationKind !== "diagnostic");
      if (mutationKind === "diagnostic") {
        const { runEpoch, runId, turnId } = request;
        const binding = { runEpoch, sessionId: request.sessionId, runId, turnId };
        expect(frames).toEqual([
          inferenceFrame("event", { ...binding, seq: 1, event: delta }),
          inferenceFrame("terminal", { ...binding, seq: 2, outcome: DONE }),
        ]);
      } else {
        expect(frames).toEqual([terminal]);
        expect(terminal.payload.outcome).toMatchObject({ type: "error" });
      }
      publish.resolve();
      await mutation;
    } finally {
      continueProvider.resolve();
      publish.resolve();
      await Promise.allSettled([mutation]);
      delivery.command = undefined;
      delivery.afterCommit = undefined;
      await workerService.stop();
      if (placements.validateTurnClaim(claim)) {
        await placements.releaseTurn(claim);
      }
      owner?.release();
    }
  },
);
