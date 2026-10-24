import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";

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

function assertNativeWorkerFields(actual: object, expected: object): void {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(Reflect.get(actual, key), value, key);
  }
}

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
  edge?: "idle-broker" | "late-attachment",
) {
  const [{ isRecord }, { createDeferredCore }, { resolveRuntimeWorkerUrl }] = await Promise.all([
    import("@openclaw/normalization-core/record-coerce"),
    import("../shared/deferred.js"),
    import("./runtime-worker-url.js"),
  ]);
  const {
    captureRetainedNativeWorkerSource,
    closeDefaultRetainedNativeWorkerSource,
    createRetainedNativeWorker,
  } = await import("./worker-native-lifecycle.js");
  const { assertNativeResourceCustody, createIdleBrokerRetirementProof } =
    await import("./worker-native-lifecycle.custody.test-support.js");
  const databasePath = path.join(directory, "native-child.sqlite");
  class ResourceControl {
    channel = new MessageChannel();
    facts = {
      constructions: 0,
      brokerPid: 0,
      childPid: 0,
      childEnvironmentObserved: false,
      attempts: 0,
      childClosed: false,
    };
    order: string[] = [];
    disposed = false;
    constructor() {
      this.channel.port1.on("message", this.receive);
    }
    receive = (value: unknown) => {
      assert.ok(isRecord(value));
      if (value.type === "constructed") {
        assert.ok(typeof value.brokerPid === "number");
        this.facts.constructions++;
        this.facts.brokerPid = value.brokerPid;
      } else if (value.type === "child") {
        assert.ok(typeof value.pid === "number");
        this.facts.childPid = value.pid;
      } else if (value.type === "child-environment") {
        assert.deepEqual(value.keys, [], "native bootstrap must not enter the child's environment");
        this.facts.childEnvironmentObserved = true;
      } else if (value.type === "close-attempt") {
        assert.ok(typeof value.attempt === "number");
        this.facts.attempts = value.attempt;
      } else if (value.type === "child-closed") {
        assert.equal(value.code, 0);
        this.facts.childClosed = true;
        this.order.push("child-close");
      } else {
        assert.fail("Unexpected native resource fixture fact");
      }
    };
    service = () => {
      let next: ReturnType<typeof receiveMessageOnPort>;
      while ((next = receiveMessageOnPort(this.channel.port1))) {
        this.receive(next.message);
      }
    };
    permit = () => {
      if (!this.disposed) {
        this.channel.port1.postMessage({ type: "permit-close" });
      }
    };
    connect = () => ({ port: this.channel.port2, service: this.service, dispose: this.dispose });
    dispose = () => {
      this.service();
      this.disposed = true;
      this.channel.port1.close();
    };
    close() {
      this.channel.port1.close();
      this.channel.port2.close();
    }
  }
  const control = new ResourceControl();
  const { facts, order, permit } = control;
  const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  const idleBrokerProof =
    edge === "idle-broker" ? createIdleBrokerRetirementProof(source) : undefined;
  const resourceWorkerSource = `const { parentPort, workerData } = require("node:worker_threads");
    const port = workerData.nativeResource;
    port.on("message", (value) => parentPort.postMessage(value, []));
    parentPort.on("message", (value) => port.postMessage(value, []));
    port.postMessage({ open: true }, []);`;
  const createResourceWorker = (owner: ResourceControl, input: unknown) =>
    createRetainedNativeWorker(
      resourceWorkerSource,
      { eval: true, execArgv: [], workerData: {} },
      source,
      source.captureResource(
        resolveRuntimeWorkerUrl(nativeWorkerResourceEntrypoint),
        "nativeResource",
        input,
        owner.connect,
      ),
    );
  const target = createResourceWorker(control, {
    databasePath,
    lateAttachment: edge === "late-attachment",
  });
  const service = (
    label: string,
    done: () => boolean,
    port: Pick<typeof target, "service"> = target,
  ) => serviceUntil(label, () => port.service(), done);
  const replies: unknown[] = [];
  const errors: Error[] = [];
  let exited = false;
  target.on("message", (reply) => replies.push(reply));
  target.on("error", (error) => errors.push(error));
  target.on("messageerror", (error) => errors.push(error));
  target.once("exit", () => {
    assert.equal(facts.childClosed, true, "ChildProcess close must precede native handle exit");
    order.push("target-exit");
    exited = true;
  });
  let database: DatabaseSync | undefined;
  try {
    service(
      "native SQLite child ready",
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
    const assertHeld = () => assertNativeResourceCustody(facts, exited, observer);
    assertHeld();
    await idleBrokerProof?.assertRefused(facts.brokerPid, assertHeld);
    if (edge === "late-attachment") {
      await delay(15_050);
      const siblingControl = new ResourceControl();
      const sibling = createResourceWorker(siblingControl, {
        databasePath: path.join(directory, "late-native-child.sqlite"),
      });
      const ready = createDeferredCore<unknown>();
      sibling.on("message", ready.resolve);
      sibling.on("error", ready.reject);
      try {
        await ready.promise;
        service(
          "late native resource owner ready",
          () => siblingControl.facts.childEnvironmentObserved,
          sibling,
        );
        assert.equal(siblingControl.facts.brokerPid, facts.brokerPid);
        await assert.rejects(sibling.terminate(), /synthetic first resource close failure/);
        const stopped = sibling.stop();
        siblingControl.permit();
        await stopped.result;
        assert.equal(siblingControl.facts.childClosed, true);
      } finally {
        siblingControl.permit();
        await sibling.terminate();
        siblingControl.close();
      }
      assertHeld();
    }
    const first = target.stop();
    service("failed native resource close", () => first.read().status !== "pending", first);
    const failure = first.read();
    assert.equal(failure.status, "rejected");
    if (failure.status === "rejected") {
      assert.match(String(failure.error), /synthetic first resource close failure/);
    }
    assertHeld();
    const retry = target.stop();
    service("same resource owner retry", () => facts.attempts === 2, retry);
    assert.equal(retry.read().status, "pending");
    assertHeld();
    permit();
    service("native resource close", () => retry.read().status !== "pending", retry);
    assert.deepEqual(retry.read(), { status: "fulfilled", value: undefined });
    assertNativeWorkerFields(facts, { constructions: 1, childClosed: true });
    assert.equal(exited, true);
    assert.equal(target.threadId, -1);
    await idleBrokerProof?.assertRetired(facts.brokerPid);
    await closeDefaultRetainedNativeWorkerSource();
    assert.throws(() => process.kill(facts.brokerPid, 0), { code: "ESRCH" });
    assert.deepEqual(order, ["child-close", "target-exit"]);
    assert.throws(() => process.kill(facts.childPid, 0), { code: "ESRCH" });
    observer.exec("BEGIN IMMEDIATE");
    assert.equal(observer.prepare("SELECT COUNT(*) AS count FROM proof").get()?.count, 1);
    observer.exec("ROLLBACK");
    console.log(
      JSON.stringify({
        ending: edge ? `resource-${edge}` : "native-resource",
        ...idleBrokerProof?.result,
        ...(edge === "late-attachment" ? { lateSameBrokerAttached: true } : {}),
        firstCloseRejected: true,
        sameOwnerRetried: true,
        childClosedBeforeStopped: true,
        sqliteReusable: true,
      }),
    );
  } finally {
    permit();
    database?.close();
    await target.terminate();
    await closeDefaultRetainedNativeWorkerSource();
    control.close();
  }
}
