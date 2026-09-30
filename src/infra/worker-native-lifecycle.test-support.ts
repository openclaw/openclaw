import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isMainThread, Worker } from "node:worker_threads";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  captureRuntimeWorkerSource,
  withRuntimeWorkerGeneration,
} from "./runtime-worker-generation.js";
import { getTrackedWorkerLifecycleSnapshot } from "./worker-cpu.js";
import { runNativeColdRecovery } from "./worker-native-lifecycle.cold-recovery.test-support.js";
import {
  captureRetainedNativeWorkerSource,
  createRetainedNativeWorker,
} from "./worker-native-lifecycle.js";
import {
  assertNativeWorkerDiagnosticMatches,
  runNativeResourceLifecycle,
} from "./worker-native-lifecycle.runtime.test-support.js";

const sqliteChild = `
  const { DatabaseSync } = require("node:sqlite");
  const { parentPort, workerData } = require("node:worker_threads");
  const db = new DatabaseSync(workerData.databasePath);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE proof(value); INSERT INTO proof VALUES(1)");
  db.exec("BEGIN IMMEDIATE; INSERT INTO proof VALUES(2)");
  const statement = db.prepare("SELECT value FROM proof");
  const iterator = statement.iterate();
  iterator.next();
  globalThis.retainedSqlite = { db, statement, iterator };
  parentPort.on("message", (input) => {
    const result = db.prepare("SELECT ? * 2 AS value").get(input);
    parentPort.postMessage({ value: result.value });
  });
`;

const workerSource = `
  const { parentPort, workerData, Worker } = require("node:worker_threads");
  const child = new Worker(workerData.childSource, {
    eval: true,
    execArgv: [],
    workerData: { databasePath: workerData.databasePath },
  });
  child.on("message", (value) => parentPort.postMessage(value));
  child.on("error", (error) => { throw error; });
  parentPort.on("message", (message) => {
    if (message === "finish") process.exit(17);
    child.postMessage(message);
  });
`;

const echoWorkerSource = `
  const { parentPort } = require("node:worker_threads");
  parentPort.on("message", (value) => parentPort.postMessage(value + 1));
`;

function serviceNativeUntil(label: string, service: () => void, done: () => boolean) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = performance.now() + 10_000;
  process.stderr.write(`native lifecycle fixture pid=${process.pid}: ${label}\n`);
  for (;;) {
    service();
    if (done()) {
      return;
    }
    assert.ok(performance.now() < deadline, `Deadline waiting for ${label}`);
    Atomics.wait(pause, 0, 0, 1);
  }
}

async function runCallbackContext() {
  const context = new AsyncLocalStorage<string>();
  const source = `
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", (value) => {
      if (value === "fail") {
        const shared = new Error("shared member");
        shared.stack = "Error: shared member\\n    at native callback fixture";
        const leaf = Object.assign(new RangeError("deep cause"), { code: "E_LEAF" });
        leaf.stack = "RangeError: deep cause\\n    at native callback fixture";
        const middle = Object.assign(new TypeError("middle cause", { cause: leaf }), { code: "E_MIDDLE" });
        middle.stack = "TypeError: middle cause\\n    at native callback fixture";
        const failure = Object.assign(
          new AggregateError([shared, shared], "synthetic callback context error", { cause: middle }),
          { code: "E_ROOT", errcode: 73, errno: -5 },
        );
        failure.stack = "AggregateError: synthetic callback context error\\n    at native callback fixture";
        throw failure;
      }
      parentPort.postMessage(value + 1, []);
    });
  `;
  const expected = ["message", "error", "exit"].map((event) => ({
    event,
    context: "constructor-A",
  }));
  const directSeen: { event: string; context: string | undefined }[] = [];
  const directErrors: Error[] = [];
  const directMessage = createDeferredCore<unknown>();
  const directExit = createDeferredCore<number>();
  const direct = context.run(
    "constructor-A",
    () => new Worker(source, { eval: true, execArgv: [] }),
  );
  context.run("service-B", () => {
    direct.on("message", (value) => {
      directSeen.push({ event: "message", context: context.getStore() });
      directMessage.resolve(value);
    });
    direct.on("error", (error) => {
      directSeen.push({ event: "error", context: context.getStore() });
      assert.ok(error instanceof Error);
      directErrors.push(error);
      directMessage.reject(error);
    });
    direct.once("exit", (code) => {
      directSeen.push({ event: "exit", context: context.getStore() });
      directExit.resolve(code);
    });
  });
  try {
    direct.postMessage(41, []);
    assert.equal(await directMessage.promise, 42);
    direct.postMessage("fail", []);
    assert.equal(await directExit.promise, 1);
    assert.deepEqual(directSeen, expected);
  } finally {
    await direct.terminate();
  }
  assert.equal(direct.threadId, -1);
  assert.equal(directErrors.length, 1);
  const directError = directErrors[0];
  assert.ok(directError);
  assert.equal(directError.message, "synthetic callback context error");
  assert.equal(Reflect.get(directError, "code"), "E_ROOT");
  // Bun already omits these fields at its first native hop; both paths must preserve what arrives.
  if (!process.versions.bun) {
    assert.equal(Reflect.get(directError, "errcode"), 73);
    assert.equal(Reflect.get(directError, "errno"), -5);
    const middle = directError.cause;
    assert.ok(middle instanceof Error);
    assert.equal(Reflect.get(middle, "code"), "E_MIDDLE");
    const leaf = middle.cause;
    assert.ok(leaf instanceof Error);
    assert.equal(leaf.message, "deep cause");
    assert.equal(Reflect.get(leaf, "code"), "E_LEAF");
    const members: unknown = Reflect.get(directError, "errors");
    assert.ok(Array.isArray(members));
    assert.equal(members.length, 2);
    assert.equal(members[0], members[1]);
  }

  const retainedSeen: { event: string; context: string | undefined }[] = [];
  const replies: unknown[] = [];
  const errors: Error[] = [];
  let exited = false;
  let exitCode: number | undefined;
  const retained = context.run("constructor-A", () =>
    createRetainedNativeWorker(source, { eval: true, execArgv: [] }),
  );
  context.run("service-B", () => {
    retained.on("message", (value) => {
      retainedSeen.push({ event: "message", context: context.getStore() });
      replies.push(value);
    });
    retained.on("error", (error) => {
      retainedSeen.push({ event: "error", context: context.getStore() });
      errors.push(error);
    });
    retained.once("exit", (code) => {
      retainedSeen.push({ event: "exit", context: context.getStore() });
      exitCode = code;
      exited = true;
    });
  });
  try {
    context.run("service-B", () => {
      retained.postMessage(41, []);
      serviceNativeUntil(
        "retained callback context message",
        () => retained.service(),
        () => replies.length > 0 || errors.length > 0,
      );
      assert.deepEqual(replies, [42]);
      assert.deepEqual(errors, []);
      retained.postMessage("fail", []);
      serviceNativeUntil(
        "retained callback context native exit",
        () => retained.service(),
        () => exited,
      );
    });
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /synthetic callback context error/);
    assertNativeWorkerDiagnosticMatches(errors[0], directError);
    assert.equal(exitCode, 1);
    assert.equal(retained.threadId, -1);
    assert.deepEqual(retained.stop().read(), { status: "fulfilled", value: undefined });
    assert.deepEqual(retainedSeen, expected);
    console.log(
      JSON.stringify({
        ending: "callback-context",
        directSeen,
        retainedSeen,
        diagnosticsPreserved: true,
        joined: true,
      }),
    );
  } finally {
    await retained.terminate();
  }
}

async function runSupervisorLoss() {
  let processWorkerEvents = 0;
  const observeProcessWorker = () => processWorkerEvents++;
  process.on("worker", observeProcessWorker);
  // The call-through observes the real constructor's listener registrations on both runtimes.
  const registrations = mock.method(Worker.prototype, "on");
  const observed = (() => {
    try {
      const target = createRetainedNativeWorker(echoWorkerSource, { eval: true, execArgv: [] });
      const supervisor = registrations.mock.calls
        .map((call) => call.this)
        .find((value) => value instanceof Worker);
      assert.ok(supervisor instanceof Worker);
      return { target, supervisor };
    } finally {
      registrations.mock.restore();
    }
  })();
  const { target, supervisor } = observed;
  let online = false;
  let supervisorExit = false;
  let targetExit = false;
  const messages: unknown[] = [];
  const errors: Error[] = [];
  supervisor.once("online", () => {
    online = true;
  });
  supervisor.once("exit", () => {
    supervisorExit = true;
  });
  target.once("exit", () => {
    targetExit = true;
  });
  target.on("message", (value) => messages.push(value));
  target.on("error", (error) => errors.push(error));
  target.on("messageerror", (error) => errors.push(error));
  try {
    target.postMessage(41, []);
    serviceNativeUntil(
      "cold target result",
      () => target.service(),
      () => messages.length > 0 || errors.length > 0,
    );
    assert.deepEqual(messages, [42]);
    assert.deepEqual(errors, []);
    assert.equal(online, false);
    assert.equal(processWorkerEvents, 0);
    const nativeTermination = supervisor.terminate();
    const stopped = target.stop();
    let promiseReaction = false;
    void stopped.result.catch(() => {
      promiseReaction = true;
    });
    serviceNativeUntil(
      "unexpected supervisor loss",
      () => stopped.service(),
      () => stopped.read().status !== "pending",
    );
    assert.equal(stopped.read().status, "rejected");
    const retry = target.stop();
    assert.equal(retry.read().status, "rejected");
    assert.equal(errors.length, 1);
    assert.equal(supervisorExit, false);
    assert.equal(targetExit, false);
    assert.ok(target.threadId > 0);
    assert.equal(online, false);
    assert.equal(processWorkerEvents, 0);
    assert.equal(promiseReaction, false);
    await nativeTermination;
    await nextTurn();
    assert.equal(supervisorExit, true);
    assert.equal(targetExit, true);
    assert.equal(target.threadId, -1);
    assert.equal(stopped.read().status, "rejected");
    assert.equal(retry.read().status, "rejected");
    assert.deepEqual(target.stop().read(), { status: "fulfilled", value: undefined });
    console.log(
      JSON.stringify({
        ending: "supervisor-loss",
        rejectedWhileBlocked: true,
        retryRejectedWhileBlocked: true,
        joinedOnlyAfterYield: true,
      }),
    );
  } finally {
    process.off("worker", observeProcessWorker);
    await supervisor.terminate();
    await nextTurn();
  }
}

async function runBlockedLifecycle(ending: "terminate" | "natural-exit", databasePath: string) {
  const worker = createRetainedNativeWorker(workerSource, {
    eval: true,
    execArgv: [],
    workerData: { childSource: sqliteChild, databasePath },
  });
  const messages: unknown[] = [];
  const exits: (number | undefined)[] = [];
  const errors: Error[] = [];
  worker.on("message", (message) => messages.push(message));
  worker.on("error", (error) => errors.push(error));
  worker.on("messageerror", (error) => errors.push(error));
  worker.once("exit", (code) => exits.push(code));
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = performance.now() + 10_000;

  function serviceUntil(label: string, service: () => void, done: () => boolean): void {
    process.stderr.write(`native lifecycle fixture pid=${process.pid}: ${label}\n`);
    for (;;) {
      service();
      const error = errors[0];
      if (error) {
        throw error;
      }
      if (done()) {
        return;
      }
      assert.ok(performance.now() < deadline, `Deadline waiting for ${label}`);
      // Only the named producer's port is serviced; main never pumps its event loop.
      Atomics.wait(pause, 0, 0, 1);
    }
  }

  let observer: DatabaseSync | undefined;
  try {
    let microtaskRan = false;
    queueMicrotask(() => {
      microtaskRan = true;
    });
    worker.postMessage(21, []);
    serviceUntil(
      "nested SQLite result",
      () => worker.service(),
      () => messages.length > 0,
    );
    assert.deepEqual(messages, [{ value: 42 }]);
    assert.equal(worker.started, true);
    assert.ok(worker.threadId > 0);
    assert.equal(exits.length, 0);

    const database = new DatabaseSync(databasePath);
    observer = database;
    database.exec("PRAGMA busy_timeout=0");
    assert.throws(() => database.exec("BEGIN IMMEDIATE"), /locked|busy/i);

    if (ending === "natural-exit") {
      worker.postMessage("finish", []);
      serviceUntil(
        "natural native exit",
        () => worker.service(),
        () => exits.length > 0,
      );
      assert.deepEqual(exits, [17]);
    }
    const stopped = worker.stop();
    let promiseCallbackRanWhileBlocked = false;
    void stopped.result.then(() => {
      promiseCallbackRanWhileBlocked = true;
    });
    if (ending === "terminate") {
      assert.equal(stopped.read().status, "pending");
    }
    serviceUntil(
      "retained native join",
      () => stopped.service(),
      () => stopped.read().status !== "pending",
    );
    assert.deepEqual(stopped.read(), { status: "fulfilled", value: undefined });
    assert.equal(worker.threadId, -1);
    assert.equal(exits.length, 1);
    assert.equal(microtaskRan, false);
    assert.equal(promiseCallbackRanWhileBlocked, false);

    // Native teardown must release the descendant's lock and roll back its write.
    database.exec("BEGIN IMMEDIATE");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM proof").get()?.count, 1);
    database.exec("ROLLBACK");
    console.log(
      JSON.stringify({
        ending,
        value: 42,
        nativeJoined: true,
        nestedSqliteReleased: true,
        promiseCallbackRanWhileBlocked,
      }),
    );
  } finally {
    observer?.close();
    await worker.terminate();
  }
}

async function runGenerationLifecycle(directory: string, databasePath: string) {
  // Source-loader startup can register its worker after the entry module begins.
  await nextTurn();
  const initialWorkers = getTrackedWorkerLifecycleSnapshot().workerCount;
  const order: string[] = [];
  const marker = new URL("./native-generation-marker.js", import.meta.url);
  const retainedMarker = new URL("./retained-native-generation-marker.js", import.meta.url);
  let nativeJoined = false;
  let siblingJoined = false;
  let terminalSamplesRejected = false;
  let directoryReleased = false;
  process.stderr.write(`native lifecycle fixture pid=${process.pid}: generation close ordering\n`);
  await withRuntimeWorkerGeneration(
    async (bind) => {
      bind((url) => (url.href === marker.href ? retainedMarker : url));
      const binding = captureRuntimeWorkerSource(marker);
      assert.equal(binding.moduleUrl.href, retainedMarker.href);
      const generation = binding.runtimeGeneration;
      assert.ok(generation);
      const source = captureRetainedNativeWorkerSource({ runtimeGeneration: generation });
      assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, initialWorkers);
      const queuedOwner = { source };
      const siblingOwner = { source };
      const firstOwnerFinished = createDeferredCore();
      // Domain owners share the captured source through the existing generation contract.
      source.retain(queuedOwner, async () => {
        try {
          order.push("owner-close-start");
          await nextTurn();
          assert.throws(() => generation.resolve(marker), /closing/);
          assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, initialWorkers);
          const worker = createRetainedNativeWorker(
            workerSource,
            {
              eval: true,
              execArgv: [],
              workerData: { childSource: sqliteChild, databasePath },
            },
            queuedOwner.source,
          );
          let reply = createDeferredCore<unknown>();
          worker.on("message", (value) => reply.resolve(value));
          worker.on("error", (error) => reply.reject(error));
          worker.on("messageerror", (error) => reply.reject(error));
          worker.postMessage(21, []);
          assert.deepEqual(await reply.promise, { value: 42 });
          assert.ok(worker.threadId > 0);
          assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, initialWorkers + 2);
          order.push("queued-worker-started");
          reply = createDeferredCore<unknown>();
          worker.postMessage(9, []);
          assert.deepEqual(await reply.promise, { value: 18 });
          order.push("worker-usable-during-close");
          const stopped = worker.stop();
          await stopped.result;
          assert.deepEqual(stopped.read(), { status: "fulfilled", value: undefined });
          assert.equal(worker.threadId, -1);
          assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, initialWorkers + 1);
          nativeJoined = true;
          order.push("native-joined");
          await assert.rejects(worker.cpuUsage());
          await assert.rejects(worker.getHeapStatistics());
          terminalSamplesRejected = true;
          const database = new DatabaseSync(databasePath);
          try {
            database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
            assert.equal(database.prepare("SELECT COUNT(*) AS count FROM proof").get()?.count, 1);
            database.exec("ROLLBACK");
          } finally {
            database.close();
          }
        } finally {
          firstOwnerFinished.resolve();
        }
      });
      source.retain(siblingOwner, async () => {
        await firstOwnerFinished.promise;
        await nextTurn();
        assert.equal(nativeJoined, true);
        assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, initialWorkers + 1);
        order.push("sibling-owner-close");
        const sibling = createRetainedNativeWorker(
          echoWorkerSource,
          { eval: true, execArgv: [] },
          siblingOwner.source,
        );
        const reply = createDeferredCore<unknown>();
        sibling.on("message", reply.resolve);
        sibling.on("error", reply.reject);
        sibling.on("messageerror", reply.reject);
        sibling.postMessage(41, []);
        assert.equal(await reply.promise, 42);
        assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, initialWorkers + 2);
        const stopped = sibling.stop();
        await stopped.result;
        assert.deepEqual(stopped.read(), { status: "fulfilled", value: undefined });
        assert.equal(sibling.threadId, -1);
        assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, initialWorkers + 1);
        siblingJoined = true;
        order.push("sibling-native-joined");
      });
      order.push("operation");
    },
    async () => {
      assert.equal(nativeJoined, true);
      assert.equal(siblingJoined, true);
      assert.equal(terminalSamplesRejected, true);
      assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, initialWorkers);
      assert.equal(existsSync(databasePath), true);
      order.push("release");
      rmSync(directory, { recursive: true, force: true });
      directoryReleased = true;
    },
  );
  assert.equal(existsSync(directory), false);
  console.log(
    JSON.stringify({
      ending: "generation",
      order,
      nativeJoined,
      siblingJoined,
      supervisorJoined: true,
      directoryReleased,
      terminalSamplesRejected,
    }),
  );
}

async function runExplicitUnboundLifecycle() {
  await nextTurn();
  const initialWorkers = getTrackedWorkerLifecycleSnapshot().workerCount;
  let ambientReleased = false;
  const source = await withRuntimeWorkerGeneration(
    async (bind) => {
      bind((url) => {
        const mapped = new URL(url);
        mapped.searchParams.set("native-lifecycle-test-generation", "ambient");
        return mapped;
      });
      const marker = new URL("./native-generation-marker.js", import.meta.url);
      assert.notEqual(captureRuntimeWorkerSource(marker).moduleUrl.href, marker.href);
      const unbound = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
      assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, initialWorkers);
      return unbound;
    },
    async () => {
      ambientReleased = true;
      assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, initialWorkers);
    },
  );
  assert.equal(ambientReleased, true);
  process.stderr.write(`native lifecycle fixture pid=${process.pid}: explicit unbound source\n`);
  const worker = createRetainedNativeWorker(echoWorkerSource, { eval: true, execArgv: [] }, source);
  const reply = createDeferredCore<unknown>();
  worker.on("message", reply.resolve);
  worker.on("error", reply.reject);
  worker.on("messageerror", reply.reject);
  try {
    worker.postMessage(41, []);
    assert.equal(await reply.promise, 42);
    assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, initialWorkers + 2);
  } finally {
    await worker.terminate();
  }
  assert.equal(worker.threadId, -1);
  assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, initialWorkers + 1);
  const idleSource = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  assert.equal(idleSource, source);
  let ownerClosed = false;
  source.retain({}, async () => {
    // Already admitted owners may finish queued work while shutdown drains them.
    const queued = createRetainedNativeWorker(
      echoWorkerSource,
      { eval: true, execArgv: [] },
      idleSource,
    );
    const queuedReply = createDeferredCore<unknown>();
    queued.on("message", queuedReply.resolve);
    queued.on("error", queuedReply.reject);
    queued.postMessage(41, []);
    assert.equal(await queuedReply.promise, 42);
    await queued.terminate();
    assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, initialWorkers + 1);
    ownerClosed = true;
  });
  await drainGlobalSingletonLifecycleState();
  assert.equal(ownerClosed, true);
  assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, initialWorkers);
  assert.throws(() => source.create(echoWorkerSource, { eval: true }), /closing/);
  const renewed = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  assert.notEqual(renewed, source);
  await drainGlobalSingletonLifecycleState();
  console.log(
    JSON.stringify({
      ending: "explicit-unbound",
      ambientReleased,
      value: 42,
      nativeJoined: true,
      idleReused: true,
      shutdownJoined: true,
    }),
  );
}

assert.equal(isMainThread, true, "the fixture must block the process main thread");
const ending = process.argv[2];
assert.ok(
  ending === "terminate" ||
    ending === "natural-exit" ||
    ending === "generation" ||
    ending === "explicit-unbound" ||
    ending === "supervisor-loss" ||
    ending === "native-resource" ||
    ending === "resource-supervisor-loss" ||
    ending === "resource-cold-supervisor-loss" ||
    ending === "resource-close-supervisor-loss" ||
    ending === "resource-late-attachment" ||
    ending === "resource-owner-reply-loss" ||
    ending === "callback-context",
);
const directory = process.argv[3];
assert.ok(directory);
const databasePath = path.join(directory, "nested.sqlite");
if (ending === "generation") {
  await runGenerationLifecycle(directory, databasePath);
} else if (ending === "explicit-unbound") {
  await runExplicitUnboundLifecycle();
} else if (ending === "supervisor-loss") {
  await runSupervisorLoss();
} else if (ending === "native-resource") {
  await runNativeResourceLifecycle(directory, serviceNativeUntil);
} else if (ending === "resource-cold-supervisor-loss") {
  await runNativeColdRecovery(directory, serviceNativeUntil);
} else if (ending === "resource-supervisor-loss") {
  await runNativeResourceLifecycle(directory, serviceNativeUntil, true);
} else if (ending === "resource-close-supervisor-loss") {
  await runNativeResourceLifecycle(directory, serviceNativeUntil, true, true);
} else if (ending === "resource-late-attachment") {
  await runNativeResourceLifecycle(directory, serviceNativeUntil, false, false, "late-attachment");
} else if (ending === "resource-owner-reply-loss") {
  await runNativeResourceLifecycle(directory, serviceNativeUntil, true, false, "owner-reply-loss");
} else if (ending === "callback-context") {
  await runCallbackContext();
} else {
  await runBlockedLifecycle(ending, databasePath);
}
