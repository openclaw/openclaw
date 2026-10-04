import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import path from "node:path";
import { mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SpawnBrokerHost as BrokerHost } from "../process/spawn-broker/host.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { RetainedNativeWorker } from "./worker-native-lifecycle.types.js";

export async function runNativeColdRecovery(
  directory: string,
  serviceUntil: (label: string, service: () => void, done: () => boolean) => void,
) {
  const { SpawnBrokerHost } = await import("../process/spawn-broker/host.js");
  const { drainGlobalSingletonLifecycleState } = await import("../shared/global-singleton.js");
  const { SpawnBrokerError } = await import("../process/spawn-broker/protocol.js");
  const { runtimeProcessEntrypoints } = await import("./runtime-process-entrypoints.js");
  const { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } =
    await import("./runtime-worker-url.js");
  const { nativeWorkerResourceEntrypoint } =
    await import("./worker-native-lifecycle.runtime.test-support.js");
  const { captureRetainedNativeWorkerSource, createRetainedNativeWorker } =
    await import("./worker-native-lifecycle.js");
  const brokerArgv = resolveRuntimeWorkerArgv(
    resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.spawnBroker),
  );
  const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  const resource = source.captureResource(
    resolveRuntimeWorkerUrl(nativeWorkerResourceEntrypoint),
    "nativeResource",
    { databasePath: path.join(directory, "never-admitted.sqlite") },
  );
  const brokerClosed = createDeferredCore();
  const joined = createDeferredCore();
  const sealStarted = createDeferredCore();
  const firstSeal = { status: "pending", unavailable: false };
  let broker: BrokerHost | undefined;
  const observed: { child?: ChildProcess } = {};
  let supervisor: Worker | undefined;
  let target: RetainedNativeWorker | undefined;
  let heldBootstrap: (() => void) | undefined;
  let restoreSend: (() => void) | undefined;
  let restoreSealing: (() => void) | undefined;
  let bootstrapSends = 0;
  let nativeBrokerClosed = false;
  let nativeJoined = false;
  let supervisorExited = false;
  let targetReady = false;
  let readinessObserved = false;
  let sealCalls = 0;
  const releaseBootstrap = () => {
    const send = heldBootstrap;
    heldBootstrap = undefined;
    send?.();
  };
  let observingActive = true;
  function observeOnce(this: ChildProcess, ...args: Parameters<ChildProcess["once"]>) {
    observing.mock.restore();
    observingActive = false;
    const once = this.once.bind(this);
    const result = once(...args);
    if (
      args[0] === "close" &&
      this.spawnfile === process.execPath &&
      this.spawnargs.length === brokerArgv.length + 1 &&
      this.spawnargs[0] === process.execPath &&
      brokerArgv.every((arg, index) => this.spawnargs[index + 1] === arg)
    ) {
      assert.ok(!observed.child, "capture only the original native resource broker");
      observed.child = this;
      once("close", () => {
        nativeBrokerClosed = true;
        brokerClosed.resolve();
      });
      // Host registers this listener before bootstrap; Bun installs send on the actual child.
      const originalSend = this.send.bind(this);
      const sending = mock.method(this, "send", (...sendArgs: Parameters<ChildProcess["send"]>) => {
        const message: unknown = sendArgs[0];
        if (isRecord(message) && message.type === "bootstrap") {
          assert.equal(++bootstrapSends, 1, "hold exactly the original bootstrap");
          // Keep the actual packet and callback opaque and only in this closure.
          heldBootstrap = () => {
            originalSend(...sendArgs);
          };
          return true;
        }
        return originalSend(...sendArgs);
      });
      restoreSend = () => sending.mock.restore();
    } else {
      observing = mock.method(ChildProcess.prototype, "once", observeOnce);
      observingActive = true;
    }
    return result;
  }
  const initialObservation = mock.method(ChildProcess.prototype, "once", observeOnce);
  let observing = initialObservation;
  const registrations = mock.method(Worker.prototype, "on");
  const captures = mock.method(SpawnBrokerHost.prototype, "captureNativeResource");
  try {
    const worker = createRetainedNativeWorker(
      `const { parentPort, workerData } = require("node:worker_threads");
       workerData.nativeResource.on("message", () => {});
       parentPort.postMessage("target-ready");`,
      { eval: true, execArgv: [], workerData: {} },
      source,
      resource,
    );
    target = worker;
    worker.on("error", () => {});
    worker.on("message", (value) => {
      targetReady ||= value === "target-ready";
    });
    worker.once("exit", () => {
      nativeJoined = true;
      joined.resolve();
    });
    const capturedHost: unknown = captures.mock.calls[0]?.this;
    assert.ok(capturedHost instanceof SpawnBrokerHost);
    broker = capturedHost;
    const originalSeal = capturedHost.sealNativeResources.bind(capturedHost);
    const sealing = mock.method(capturedHost, "sealNativeResources", () => {
      const result = originalSeal();
      if (++sealCalls === 1) {
        void result.then(
          () => {
            firstSeal.status = "fulfilled";
          },
          (error: unknown) => {
            firstSeal.status = "rejected";
            firstSeal.unavailable = error instanceof SpawnBrokerError;
          },
        );
        sealStarted.resolve();
      }
      return result;
    });
    restoreSealing = () => sealing.mock.restore();
    assert.equal(captures.mock.calls.length, 1);
    const capturedSupervisor = registrations.mock.calls
      .map((call) => call.this)
      .find((value) => value instanceof Worker);
    assert.ok(capturedSupervisor instanceof Worker);
    supervisor = capturedSupervisor;
    supervisor.once("exit", () => {
      supervisorExited = true;
    });
    assert.ok(observed.child);
    assert.ok(heldBootstrap);
    const originalBrokerPid = observed.child.pid;
    void broker.ready().then(
      () => {
        readinessObserved = true;
      },
      () => {},
    );
    serviceUntil(
      "cold target before broker bootstrap",
      () => worker.service(),
      () => targetReady,
    );
    const termination = supervisor.terminate();
    const stopped = worker.stop();
    serviceUntil(
      "cold supervisor loss",
      () => stopped.service(),
      () => stopped.read().status !== "pending",
    );
    assert.equal(stopped.read().status, "rejected");
    assert.equal(supervisorExited, false);
    assert.equal(nativeJoined, false);
    await termination;
    await nextTurn();
    await sealStarted.promise;
    // Recovery started on a real join; allow its Promise observer to finish, without releasing startup.
    await nextTurn();
    assert.equal(
      firstSeal.status,
      "rejected",
      "unobserved readiness must not leave recovery pending",
    );
    assert.equal(firstSeal.unavailable, true);
    assert.equal(readinessObserved, false);
    assert.equal(nativeJoined, false);
    assert.equal(nativeBrokerClosed, false);
    assert.ok(
      captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }) === source,
      "unsettled resource custody must retain the original source",
    );
    await assert.rejects(broker.close(), /Native resource claims must close/);
    releaseBootstrap();
    await broker.ready();
    assert.equal(broker.pid, originalBrokerPid);
    const retry = worker.stop();
    assert.equal(retry.read().status, "rejected", "recovery is not a premature native join");
    await joined.promise;
    assert.equal(worker.stop().read().status, "fulfilled");
    assert.equal(worker.threadId, -1);
    assert.ok(sealCalls >= 2, "retry must return to the same source seal operation");
    await broker.close();
    await brokerClosed.promise;
    assert.equal(nativeBrokerClosed, true);
    await drainGlobalSingletonLifecycleState();
    assert.ok(
      captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }) !== source,
      "actual resource and broker cleanup release source custody",
    );
    console.log(
      JSON.stringify({
        ending: "resource-cold-supervisor-loss",
        unavailableBeforeReady: true,
        sameSourceRetained: true,
        sameBrokerRetried: true,
        neverAdmittedResourceClosed: true,
        brokerClosed: true,
      }),
    );
  } finally {
    try {
      // Even the old pending-recovery RED releases startup and joins its original actors.
      releaseBootstrap();
      if (supervisor) {
        await supervisor.terminate();
        await nextTurn();
      }
      if (broker) {
        if (target && !nativeJoined) {
          await broker.ready();
          target.stop();
          await joined.promise;
        }
        await broker.close();
      } else {
        observed.child?.kill("SIGKILL");
      }
      if (observed.child) {
        await brokerClosed.promise;
      }
    } finally {
      restoreSealing?.();
      captures.mock.restore();
      registrations.mock.restore();
      restoreSend?.();
      if (observingActive) {
        observing.mock.restore();
      }
    }
  }
}
