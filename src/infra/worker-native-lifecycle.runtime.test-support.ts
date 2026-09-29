import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { MessageChannel, MessagePort, receiveMessageOnPort, Worker } from "node:worker_threads";

export const nativeWorkerLifecycleEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "worker-native-lifecycle.test-support",
  distWorkerPath: "infra/worker-native-lifecycle.test-support.js",
} as const;

export const nativeWorkerResourceEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "worker-native-lifecycle.resource.test-support",
  distWorkerPath: "infra/worker-native-lifecycle.resource.test-support.js",
} as const;

export function assertNativeWorkerDiagnosticMatches(
  actual: unknown,
  expected: unknown,
  seen = new Map<Error, Error>(),
): void {
  if (!(expected instanceof Error)) {
    assert.deepEqual(actual, expected);
    return;
  }
  assert.ok(actual instanceof Error);
  const prior = seen.get(expected);
  if (prior) {
    assert.equal(actual, prior, "shared native diagnostic references must survive");
    return;
  }
  seen.set(expected, actual);
  assert.equal(actual.constructor, expected.constructor);
  for (const key of ["name", "message", "stack", "code", "errcode", "errno"]) {
    assert.deepEqual(Reflect.get(actual, key), Reflect.get(expected, key), key);
  }
  assertNativeWorkerDiagnosticMatches(actual.cause, expected.cause, seen);
  const members: unknown = Reflect.get(expected, "errors");
  const actualMembers: unknown = Reflect.get(actual, "errors");
  if (Array.isArray(members)) {
    assert.ok(Array.isArray(actualMembers));
    assert.equal(actualMembers.length, members.length);
    members.forEach((member, index) =>
      assertNativeWorkerDiagnosticMatches(actualMembers[index], member, seen),
    );
  } else {
    assert.equal(actualMembers, members);
  }
}

export async function runNativeResourceLifecycle(
  directory: string,
  serviceUntil: (label: string, service: () => void, done: () => boolean) => void,
  supervisorLoss = false,
  closeBeforeLoss = false,
  edge?: "late-attachment" | "owner-reply-loss",
) {
  // The compiler imports the entrypoint descriptors without a runtime TypeScript loader.
  const [{ isRecord }, { createDeferredCore }, { resolveRuntimeWorkerUrl }] = await Promise.all([
    import("@openclaw/normalization-core/record-coerce"),
    import("../shared/deferred.js"),
    import("./runtime-worker-url.js"),
  ]);
  const { captureRetainedNativeWorkerSource, createRetainedNativeWorker } =
    await import("./worker-native-lifecycle.js");
  const { SpawnBrokerHost } = await import("../process/spawn-broker/host.js");
  const databasePath = path.join(directory, "native-child.sqlite");
  const createControl = () => {
    const channel = new MessageChannel();
    const replyOrder: string[] = [];
    const facts = {
      constructions: 0,
      brokerPid: 0,
      childPid: 0,
      childEnvironmentObserved: false,
      attempts: 0,
      closeBarriers: 0,
      replyBarriers: 0,
      replies: replyOrder,
      childClosed: false,
    };
    const order: string[] = [];
    const waiters = new Set<() => void>();
    let disposed = false;
    const receive = (value: unknown) => {
      assert.ok(isRecord(value));
      if (value.type === "constructed") {
        assert.ok(typeof value.brokerPid === "number");
        facts.constructions++;
        facts.brokerPid = value.brokerPid;
      } else if (value.type === "child") {
        assert.ok(typeof value.pid === "number");
        facts.childPid = value.pid;
      } else if (value.type === "child-environment") {
        assert.deepEqual(
          value.keys,
          [],
          "native bootstrap must not enter the SQLite child's environment",
        );
        facts.childEnvironmentObserved = true;
      } else if (value.type === "close-attempt") {
        assert.ok(typeof value.attempt === "number");
        facts.attempts = value.attempt;
      } else if (value.type === "child-closed") {
        assert.equal(value.code, 0);
        facts.childClosed = true;
        order.push("child-close");
      } else if (value.type === "close-barrier") {
        assert.equal(value.attempts, 1);
        assert.equal(value.pending, true);
        facts.closeBarriers++;
      } else if (value.type === "custody-ack" || value.type === "fixture-fence") {
        assert.equal(value.count, 1, "preserved owner replies must apply exactly once");
        facts.replies.push(value.type);
      } else if (value.type === "owner-reply-barrier") {
        assert.equal(value.acknowledgments, 0);
        assert.equal(value.fences, 0, "later owner reply must wait behind the held original");
        facts.replyBarriers++;
      } else {
        assert.fail("Unexpected native resource fixture fact");
      }
      for (const wake of waiters) {
        wake();
      }
    };
    const service = () => {
      for (;;) {
        const next = receiveMessageOnPort(channel.port1);
        if (!next) {
          return;
        }
        receive(next.message);
      }
    };
    const waitFor = (done: () => boolean) => {
      if (done()) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const wake = () => {
          if (done()) {
            waiters.delete(wake);
            resolve();
          }
        };
        waiters.add(wake);
      });
    };
    channel.port1.on("message", receive);
    const permit = () => {
      if (!disposed) {
        channel.port1.postMessage({ type: "permit-close" });
      }
    };
    return {
      channel,
      facts,
      order,
      service,
      waitFor,
      permit,
      get disposed() {
        return disposed;
      },
      connect: () => ({
        port: channel.port2,
        service,
        dispose() {
          service();
          disposed = true;
          channel.port1.close();
        },
      }),
    };
  };
  const control = createControl();
  const { channel, facts, order, waitFor, permit } = control;
  const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  const resource = source.captureResource(
    resolveRuntimeWorkerUrl(nativeWorkerResourceEntrypoint),
    "nativeResource",
    {
      databasePath,
      gateFirstFailure: supervisorLoss,
      requireCustodyAck: edge === "owner-reply-loss",
      lateAttachment: edge === "late-attachment",
    },
    control.connect,
  );
  const resourceWorkerSource = `const { parentPort, workerData } = require("node:worker_threads");
    const port = workerData.nativeResource;
    port.on("message", (value) => parentPort.postMessage(value, []));
    parentPort.on("message", (value) => port.postMessage(value, []));
    port.postMessage({ open: true }, []);`;
  const registrations = mock.method(Worker.prototype, "on");
  const captures =
    edge === "owner-reply-loss"
      ? mock.method(SpawnBrokerHost.prototype, "captureNativeResource")
      : undefined;
  const observed = (() => {
    try {
      const target = createRetainedNativeWorker(
        resourceWorkerSource,
        { eval: true, execArgv: [], workerData: {} },
        source,
        resource,
      );
      const supervisor = registrations.mock.calls
        .map((call) => call.this)
        .find((value) => value instanceof Worker);
      assert.ok(supervisor instanceof Worker);
      const lease = captures?.mock.calls[0]?.result;
      if (captures) {
        assert.ok(lease);
      }
      return { target, supervisor, lease };
    } finally {
      registrations.mock.restore();
      captures?.mock.restore();
    }
  })();
  const { target, supervisor } = observed;
  const ownerDeliveries = observed.lease ? mock.method(observed.lease, "ownerMessage") : undefined;
  const replies: unknown[] = [];
  const errors: Error[] = [];
  const joined = createDeferredCore();
  let exited = false;
  let supervisorExited = false;
  supervisor.once("exit", () => {
    supervisorExited = true;
  });
  target.on("message", (reply) => replies.push(reply));
  target.on("error", (error) => errors.push(error));
  target.on("messageerror", (error) => errors.push(error));
  target.once("exit", () => {
    assert.equal(
      facts.childClosed,
      true,
      "actual ChildProcess close must precede native handle exit",
    );
    order.push("target-exit");
    exited = true;
    joined.resolve();
  });
  let database: DatabaseSync | undefined;
  try {
    serviceUntil(
      "native SQLite child ready",
      () => target.service(),
      () =>
        (replies.length > 0 && facts.childPid > 0 && facts.childEnvironmentObserved) ||
        errors.length > 0,
    );
    assert.deepEqual(errors, []);
    assert.equal(facts.constructions, 1);
    assert.deepEqual(replies, [{ ready: true, pid: facts.childPid }]);
    const observer = new DatabaseSync(databasePath);
    database = observer;
    observer.exec("PRAGMA busy_timeout=0");
    const assertHeld = () => {
      assert.equal(exited, false);
      assert.equal(facts.constructions, 1);
      assert.equal(facts.childClosed, false);
      process.kill(facts.childPid, 0);
      assert.throws(() => observer.exec("BEGIN IMMEDIATE"), /locked|busy/i);
    };
    assertHeld();
    if (edge === "late-attachment") {
      // Cross the original cold broker's 15-second readiness deadline using real elapsed time.
      await delay(15_050);
      assert.equal(captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }), source);
      assertHeld();
      const siblingControl = createControl();
      const siblingPath = path.join(directory, "late-native-child.sqlite");
      const siblingResource = source.captureResource(
        resolveRuntimeWorkerUrl(nativeWorkerResourceEntrypoint),
        "nativeResource",
        { databasePath: siblingPath },
        siblingControl.connect,
      );
      const sibling = createRetainedNativeWorker(
        resourceWorkerSource,
        { eval: true, execArgv: [], workerData: {} },
        source,
        siblingResource,
      );
      const siblingReady = createDeferredCore<unknown>();
      sibling.on("message", siblingReady.resolve);
      sibling.on("error", siblingReady.reject);
      sibling.on("messageerror", siblingReady.reject);
      let siblingDatabase: DatabaseSync | undefined;
      try {
        const ready = await siblingReady.promise;
        await siblingControl.waitFor(
          () => siblingControl.facts.childPid > 0 && siblingControl.facts.childEnvironmentObserved,
        );
        assert.deepEqual(ready, { ready: true, pid: siblingControl.facts.childPid });
        assert.equal(siblingControl.facts.brokerPid, facts.brokerPid);
        const observerSibling = new DatabaseSync(siblingPath);
        siblingDatabase = observerSibling;
        observerSibling.exec("PRAGMA busy_timeout=0");
        assert.throws(() => observerSibling.exec("BEGIN IMMEDIATE"), /locked|busy/i);
        await assert.rejects(sibling.terminate(), /synthetic first resource close failure/);
        const closing = sibling.stop();
        await siblingControl.waitFor(() => siblingControl.facts.attempts === 2);
        assert.equal(closing.read().status, "pending");
        siblingControl.permit();
        await closing.result;
        assert.equal(siblingControl.facts.childClosed, true);
        assert.equal(siblingControl.facts.constructions, 1);
        assert.equal(sibling.threadId, -1);
        observerSibling.exec("BEGIN IMMEDIATE");
        assert.equal(
          observerSibling.prepare("SELECT COUNT(*) AS count FROM proof").get()?.count,
          1,
        );
        observerSibling.exec("ROLLBACK");
      } finally {
        siblingControl.permit();
        siblingDatabase?.close();
        await sibling.terminate().catch(() => undefined);
        siblingControl.channel.port1.close();
        siblingControl.channel.port2.close();
      }
      assertHeld();
    }
    if (edge === "owner-reply-loss") {
      const originalPost: unknown = Object.getOwnPropertyDescriptor(
        MessagePort.prototype,
        "postMessage",
      )?.value;
      assert.ok(typeof originalPost === "function");
      let held: unknown;
      let duplicates = 0;
      const forwarding = mock.method(
        MessagePort.prototype,
        "postMessage",
        function (this: MessagePort, ...args: Parameters<MessagePort["postMessage"]>) {
          const value: unknown = args[0];
          if (isRecord(value) && value.type === "resource-owner" && isRecord(value.value)) {
            if (value.value.type === "custody-ack") {
              assert.equal(held, undefined, "hold exactly one original primary owner reply");
              held = value;
              return;
            }
            if (value.value.type === "fixture-fence") {
              Reflect.apply(originalPost, this, args);
              duplicates++;
            }
          }
          Reflect.apply(originalPost, this, args);
        },
      );
      try {
        channel.port1.postMessage({ type: "custody-ack" });
        channel.port1.postMessage({ type: "fixture-fence" });
        target.service();
        assert.ok(held);
        assert.equal(duplicates, 1);
        target.postMessage({ type: "owner-reply-barrier" }, []);
        serviceUntil(
          "out-of-order owner reply barrier",
          () => target.service(),
          () => facts.replyBarriers === 1,
        );
        assert.deepEqual(facts.replies, []);
        assertHeld();
      } finally {
        forwarding.mock.restore();
      }
      // The held primary packet is deliberately never resent through the dead supervisor.
    }
    if (supervisorLoss) {
      const originalClose = closeBeforeLoss ? target.stop() : undefined;
      if (originalClose) {
        serviceUntil(
          "healthy-root native close pending",
          () => originalClose.service(),
          () => facts.attempts === 1 || originalClose.read().status !== "pending",
        );
        assert.equal(originalClose.read().status, "pending");
        assertHeld();
      }
      const termination = supervisor.terminate();
      const stopped = originalClose ?? target.stop();
      serviceUntil(
        "resource supervisor loss",
        () => stopped.service(),
        () => stopped.read().status !== "pending",
      );
      assert.equal(stopped.read().status, "rejected");
      const blockedRetry = target.stop();
      assert.equal(blockedRetry.read().status, "rejected");
      assert.equal(supervisorExited, false);
      assert.ok(target.threadId > 0);
      assertHeld();
      await termination;
      await nextTurn();
      assert.equal(supervisorExited, true);
      const retainedSource = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
      assert.equal(retainedSource, source, "native child custody must retain the source identity");
      const refusedRegistrations = mock.method(Worker.prototype, "on");
      try {
        assert.throws(
          () => retainedSource.create("", { eval: true, execArgv: [] }),
          /source is closing/,
        );
        assert.equal(refusedRegistrations.mock.callCount(), 0);
      } finally {
        refusedRegistrations.mock.restore();
      }
      assertHeld();
      await waitFor(() => facts.attempts === 1);
      assertHeld();
      if (edge === "owner-reply-loss") {
        assert.ok(ownerDeliveries);
        const deliveries = ownerDeliveries.mock.calls.map((call) => call.result);
        assert.equal(deliveries.length, 2);
        const [acknowledgment, fence] = deliveries;
        assert.ok(acknowledgment);
        assert.ok(fence);
        await acknowledgment.result;
        await assert.rejects(fence.result, (error: unknown) => {
          assert.ok(error instanceof RangeError);
          assert.equal(error.message, "synthetic owner fence failure");
          assert.equal(Reflect.get(error, "code"), "E_NATIVE_FENCE");
          assert.ok(error.cause instanceof TypeError);
          assert.equal(error.cause.message, "synthetic owner fence cause");
          assert.equal(Reflect.get(error.cause, "code"), "E_NATIVE_FENCE_CAUSE");
          return true;
        });
        assertHeld();
      }
      if (closeBeforeLoss) {
        channel.port1.postMessage({ type: "close-barrier" });
        await waitFor(() => facts.closeBarriers === 1);
        assertHeld();
      }
      // The first close is still inside its owner until this explicit retry has been requested.
      const recovery = target.stop();
      assert.equal(recovery.read().status, "rejected");
      channel.port1.postMessage({ type: "fail-first-close" });
      await waitFor(() => facts.attempts === 2);
      assert.equal(recovery.read().status, "rejected");
      assertHeld();
      if (edge === "owner-reply-loss") {
        await waitFor(() => facts.replies.length === 2);
        assert.deepEqual(facts.replies, ["custody-ack", "fixture-fence"]);
      }
      permit();
      await joined.promise;
      assert.equal(stopped.read().status, "rejected");
      assert.equal(blockedRetry.read().status, "rejected");
      assert.equal(recovery.read().status, "rejected");
    } else {
      const first = target.stop();
      serviceUntil(
        "failed native resource close",
        () => first.service(),
        () => first.read().status !== "pending",
      );
      const failure = first.read();
      assert.equal(failure.status, "rejected");
      if (failure.status === "rejected") {
        assert.match(String(failure.error), /synthetic first resource close failure/);
      }
      assert.equal(facts.attempts, 1);
      assertHeld();
      const retry = target.stop();
      serviceUntil(
        "same resource owner retry",
        () => retry.service(),
        () => facts.attempts === 2 || retry.read().status !== "pending",
      );
      assert.equal(retry.read().status, "pending");
      assertHeld();
      permit();
      serviceUntil(
        "native resource actual close",
        () => retry.service(),
        () => retry.read().status !== "pending",
      );
      assert.deepEqual(retry.read(), { status: "fulfilled", value: undefined });
    }
    assert.equal(facts.constructions, 1);
    assert.notEqual(facts.brokerPid, process.pid);
    assert.equal(facts.attempts, 2);
    assert.equal(facts.childClosed, true);
    assert.equal(exited, true);
    assert.equal(target.threadId, -1);
    if (supervisorLoss) {
      assert.notEqual(
        captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }),
        source,
        "the source can retire only after its native child has closed",
      );
    }
    assert.deepEqual(target.stop().read(), { status: "fulfilled", value: undefined });
    assert.deepEqual(order, ["child-close", "target-exit"]);
    assert.throws(() => process.kill(facts.childPid, 0), { code: "ESRCH" });
    observer.exec("BEGIN IMMEDIATE");
    assert.equal(observer.prepare("SELECT COUNT(*) AS count FROM proof").get()?.count, 1);
    observer.exec("ROLLBACK");
    console.log(
      JSON.stringify({
        ending:
          edge === "late-attachment"
            ? "resource-late-attachment"
            : edge === "owner-reply-loss"
              ? "resource-owner-reply-loss"
              : closeBeforeLoss
                ? "resource-close-supervisor-loss"
                : supervisorLoss
                  ? "resource-supervisor-loss"
                  : "native-resource",
        ...(closeBeforeLoss ? { originalCloseJoined: true } : {}),
        ...(edge === "late-attachment" ? { lateSameBrokerAttached: true } : {}),
        ...(edge === "owner-reply-loss"
          ? {
              retainedReplyDelivered: true,
              ownerRepliesOrderedOnce: true,
              ownerReplyRejectionPreserved: true,
            }
          : {}),
        ...(supervisorLoss
          ? {
              rejectedWhileBlocked: true,
              retryRejectedWhileBlocked: true,
              brokerOwnerSurvived: true,
            }
          : {}),
        firstCloseRejected: true,
        sameOwnerRetried: true,
        childClosedBeforeStopped: true,
        sqliteReusable: true,
      }),
    );
  } finally {
    ownerDeliveries?.mock.restore();
    if (!control.disposed) {
      channel.port1.postMessage({ type: "fail-first-close" });
    }
    permit();
    database?.close();
    try {
      await target.terminate();
    } catch {
      await target.terminate().catch(() => undefined);
    }
    await supervisor.terminate();
    await nextTurn();
    channel.port1.close();
    channel.port2.close();
  }
}
