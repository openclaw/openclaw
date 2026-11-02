import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerInferenceStore, type WorkerInferenceStore } from "./inference-store.js";
import { createWorkerInferenceManager } from "./inference.js";
import { createSink, DONE } from "./inference.test-support.js";
import {
  bindWorkerTurnOwner,
  getWorkerTurnExecutionIdentityCapability,
} from "./placement-turn-claim-events.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { claimAdmission, claimTarget, seedClaim } from "./worker-turn-rpc-fixtures.test-support.js";
import { createWorkerTurnRpc } from "./worker-turn-rpc.js";

support.setupWorkerEnvironmentServiceSuite();

it.each(["source replacement", "transport refresh"] as const)(
  "retains the original source across %s while BEGIN is pending",
  async (change) => {
    const environmentId = "inference-reconnect-worker";
    const sessionId = "inference-reconnect-session";
    const {
      claim,
      store: placements,
      environmentIdentity: environment,
    } = await seedClaim(environmentId, sessionId);
    const instance = createOperationalRunInstanceRef(claim.runId);
    const authority = claimAgentRunDelegatedAuthority(instance);
    const target = claimTarget(sessionId);
    const bind = () =>
      bindWorkerTurnOwner(placements, claim, undefined, instance, target, () => {
        if (!placements.validateTurnClaim(claim)) {
          throw new Error("Reconnect fixture lost its real placement claim");
        }
      });
    await bind();
    const original = getWorkerTurnExecutionIdentityCapability(placements, claim);
    assert(original, "Reconnect fixture did not capture its original source");
    const entered = createDeferred();
    const proceed = createDeferred();
    const nativeStore = createWorkerInferenceStore({
      path: support.testState.stateDb.path,
      now: () => support.testState.nowMs,
    });
    // Gate only timing; the original manager guard still reaches the actual native store.
    const begin = vi.fn<WorkerInferenceStore["begin"]>(async (...args) => {
      entered.resolve();
      await proceed.promise;
      return nativeStore.begin(...args);
    });
    const complete = vi.fn(nativeStore.complete);
    const execute = vi.fn(async () => DONE);
    const inference = createWorkerInferenceManager({
      execute,
      store: { ...nativeStore, begin, complete },
    });
    const locks = new KeyedAsyncQueue();
    const rpc = createWorkerTurnRpc({
      store: support.testState.store,
      placementStore: createWorkerSessionPlacementGate(placements),
      prepareInstallation: support.testState.prepareInstallation,
      inference,
      isStopping: () => false,
      now: () => support.testState.nowMs,
      withLock: (key, task) => locks.enqueue(key, task),
    });
    let first: ReturnType<typeof rpc.startInference> | undefined;
    let reconnected: ReturnType<typeof rpc.startInference> | undefined;
    const renewCredential = (credential: string) => {
      const credentialHash = hashWorkerCredential(credential, claim);
      return support.testState.store
        .renewCredential({
          environmentId,
          expectedOwnerEpoch: environment.ownerEpoch,
          credentialHash,
          sessionId,
          rpcSetVersion: environment.rpcSetVersion,
          expiresAtMs: environment.credentialExpiresAtMs,
        })
        .then(() => credentialHash);
    };
    try {
      const credential = "inference-reconnect-fixture";
      await renewCredential(credential);
      const admission = await rpc.admitWorker(claimAdmission(claim, credential));
      assert(admission.ok, "Reconnect fixture worker admission failed");
      const identity = admission.identity;
      const request = support.inferenceRequest(identity);
      const firstSink = createSink("original-connection");
      const nextSink = createSink("reconnected-connection");
      first = rpc.startInference(identity, request, firstSink.sink);
      await Promise.race([
        entered.promise,
        first.then(() => {
          throw new Error("Inference resolved before its BEGIN gate");
        }),
      ]);
      let nextIdentity = identity;
      if (change === "source replacement") {
        // Same claim, run, target, and registry authority; only the bound source owner changes.
        await bind();
        const successor = getWorkerTurnExecutionIdentityCapability(placements, claim);
        assert(successor, "Reconnect fixture did not capture its successor source");
        expect(successor).not.toBe(original);
        expect(() => successor.receiptAuthority()).not.toThrow();
        expect(() => original.receiptAuthority()).toThrow("worker turn authority changed");
      } else {
        const credentialHash = await renewCredential("reconnected-fixture");
        nextIdentity = { ...identity, credentialHash };
        expect(getWorkerTurnExecutionIdentityCapability(placements, claim)).toBe(original);
        expect(() => original.receiptAuthority()).not.toThrow();
      }
      reconnected = rpc.startInference(nextIdentity, request, nextSink.sink);
      expect(begin).toHaveBeenCalledOnce();
      proceed.resolve();
      const results = await Promise.all([first, reconnected]);
      if (change === "source replacement") {
        const refused = { ok: false, reason: "provider-error" };
        expect(results).toEqual([refused, refused]);
        expect(execute).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
        expect(nextSink.frames).toEqual([]);
      } else {
        for (const result of results) {
          assert(result.ok, "Current source could not reconnect its transport");
          expect(result.result.status).toBe("accepted");
          result.launch();
        }
        expect((await nextSink.terminal).payload.outcome).toEqual(DONE);
        expect(execute).toHaveBeenCalledOnce();
        expect(complete).toHaveBeenCalledOnce();
      }
      expect(firstSink.frames).toEqual([]);
      expect(begin).toHaveBeenCalledOnce();
    } finally {
      proceed.resolve();
      await Promise.allSettled([first, reconnected]);
      await Promise.allSettled([inference.stop()]);
      rpc.clear();
      await placements.releaseTurn(claim);
      releaseAgentRunDelegatedAuthority(authority);
    }
  },
);
