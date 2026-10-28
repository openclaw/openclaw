import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { createDeferredCore } from "../shared/deferred.js";
import {
  captureRetainedNativeWorkerSource,
  createRetainedNativeWorker,
  type RetainedNativeWorkerSource,
} from "./worker-native-lifecycle.js";

export function assertNativeResourceCustody(
  facts: { constructions: number; childClosed: boolean; childPid: number },
  exited: boolean,
  observer: DatabaseSync,
): void {
  assert.equal(exited, false);
  assert.equal(facts.constructions, 1);
  assert.equal(facts.childClosed, false);
  process.kill(facts.childPid, 0);
  assert.throws(() => observer.exec("BEGIN IMMEDIATE"), /locked|busy/i);
}

export function createIdleBrokerRetirementProof(source: RetainedNativeWorkerSource) {
  let domainClosed = false;
  source.retain({}, async () => {
    domainClosed = true;
  });
  return {
    result: {
      independentCustodyPreserved: true,
      idleBrokerJoined: true,
      sourceReusable: true,
    },
    async assertRefused(brokerPid: number, assertHeld: () => void) {
      assert.equal(await source.retireIdleBroker(), false);
      assert.equal(domainClosed, false);
      process.kill(brokerPid, 0);
      assertHeld();
    },
    async assertRetired(brokerPid: number) {
      assert.equal(await source.retireIdleBroker(), true);
      assert.throws(() => process.kill(brokerPid, 0), { code: "ESRCH" });
      assert.equal(domainClosed, false);
      assert.equal(captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }), source);
      const next = createRetainedNativeWorker(
        'require("node:worker_threads").parentPort.postMessage(42)',
        { eval: true, execArgv: [] },
        source,
      );
      assert.equal(source.hasActiveWorkers, true);
      const nextReply = createDeferredCore<unknown>();
      next.on("message", nextReply.resolve);
      next.on("error", nextReply.reject);
      try {
        assert.equal(await nextReply.promise, 42);
      } finally {
        await next.terminate();
      }
      assert.equal(source.hasActiveWorkers, false);
    },
  };
}
