import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
import { createWorkerTurnRpc } from "./worker-turn-rpc.js";
import { claimWorkerPlacement } from "./worker-turn-rpc.test-support.js";

describe("worker inference reconnect source ownership", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["source replacement", "transport refresh"] as const)(
    "retains the original source across %s while BEGIN is pending",
    async (change) => {
      const environmentId = "inference-reconnect-worker";
      const sessionId = "inference-reconnect-session";
      const environment = await support.seedAttachedIdentity(environmentId, sessionId);
      const { claim, store: placements } = claimWorkerPlacement({
        environmentId,
        ownerEpoch: environment.ownerEpoch,
        sessionId,
      });
      const instance = createOperationalRunInstanceRef(claim.runId);
      const authority = claimAgentRunDelegatedAuthority(instance);
      const target = {
        agentId: "main",
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
        storePath: path.join(support.testState.root, "sessions.json"),
      };
      const bind = () =>
        bindWorkerTurnOwner(placements, claim, undefined, instance, target, () => {
          if (!placements.validateTurnClaim(claim)) {
            throw new Error("Reconnect fixture lost its real placement claim");
          }
        });
      await bind();
      const original = getWorkerTurnExecutionIdentityCapability(placements, claim);
      if (!original) {
        throw new Error("Reconnect fixture did not capture its original source");
      }
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
      try {
        const credential = "inference-reconnect-fixture";
        await support.testState.store.renewCredential({
          environmentId,
          expectedOwnerEpoch: environment.ownerEpoch,
          credentialHash: hashWorkerCredential(credential, claim),
          sessionId,
          rpcSetVersion: environment.rpcSetVersion,
          expiresAtMs: environment.credentialExpiresAtMs,
        });
        const admission = await rpc.admitWorker({
          environmentId,
          credential,
          sessionId,
          runId: claim.runId,
          ownerEpoch: environment.ownerEpoch,
          rpcSetVersion: environment.rpcSetVersion,
          handshake: support.BOOTSTRAP_RECEIPT,
        });
        if (!admission.ok) {
          throw new Error("Reconnect fixture worker admission failed");
        }
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
          if (!successor) {
            throw new Error("Reconnect fixture did not capture its successor source");
          }
          expect(successor).not.toBe(original);
          expect(() => successor.receiptAuthority()).not.toThrow();
          expect(() => original.receiptAuthority()).toThrow("worker turn authority changed");
        } else {
          const credentialHash = hashWorkerCredential("reconnected-fixture", claim);
          await support.testState.store.renewCredential({
            environmentId,
            expectedOwnerEpoch: identity.ownerEpoch,
            credentialHash,
            sessionId,
            rpcSetVersion: identity.rpcSetVersion,
            expiresAtMs: identity.credentialExpiresAtMs,
          });
          nextIdentity = { ...identity, credentialHash };
          expect(getWorkerTurnExecutionIdentityCapability(placements, claim)).toBe(original);
          expect(() => original.receiptAuthority()).not.toThrow();
        }
        reconnected = rpc.startInference(nextIdentity, request, nextSink.sink);
        expect(begin).toHaveBeenCalledOnce();
        proceed.resolve();
        const results = await Promise.all([first, reconnected]);
        if (change === "source replacement") {
          expect(results).toEqual([
            { ok: false, reason: "provider-error" },
            { ok: false, reason: "provider-error" },
          ]);
          expect(execute).not.toHaveBeenCalled();
          expect(complete).not.toHaveBeenCalled();
          expect(nextSink.frames).toEqual([]);
        } else {
          for (const result of results) {
            if (!result.ok) {
              throw new Error("Current source could not reconnect its transport");
            }
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
        placements.releaseTurn(claim);
        releaseAgentRunDelegatedAuthority(authority);
      }
    },
  );
});
