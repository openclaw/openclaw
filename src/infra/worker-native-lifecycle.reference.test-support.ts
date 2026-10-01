import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { MessageChannel, MessagePort, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SpawnBrokerHost } from "../process/spawn-broker/host.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  captureRetainedNativeWorkerSource,
  createRetainedNativeWorker,
} from "./worker-native-lifecycle.js";
import { nativeWorkerResourceEntrypoint } from "./worker-native-lifecycle.runtime.test-support.js";

type NativeReferenceEnding =
  | "resource-passive-exit"
  | "resource-reference-retry"
  | "resource-idle-supervisor-loss"
  | "resource-diagnostic-references";

type DiagnosticGate = {
  kind: "cpu" | "heap";
  arrived: Deferred;
  held?: { packet: Record<string, unknown>; deliver(): void };
};

export async function runNativeReferenceLifecycle(
  directory: string,
  ending: NativeReferenceEnding,
) {
  await nextTurn();
  let complete = false;
  process.once("beforeExit", () => {
    assert.equal(complete, true, "native work lost its process reference before settlement");
  });
  const channel = new MessageChannel();
  const facts = { constructions: 0, attempts: 0, childClosed: false, environment: false };
  let originalChildClosedBeforeExit = false;
  let childCloseNotifiedBeforeExit = false;
  const waiters = new Set<() => void>();
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
  let disposed = false;
  channel.port1.on("message", (value: unknown) => {
    assert.ok(isRecord(value));
    if (value.type === "constructed") {
      facts.constructions++;
    } else if (value.type === "close-attempt") {
      assert.ok(typeof value.attempt === "number");
      facts.attempts = value.attempt;
    } else if (value.type === "child-closed") {
      assert.equal(value.code, 0);
      facts.childClosed = true;
    } else if (value.type === "child-environment") {
      assert.deepEqual(value.keys, []);
      facts.environment = true;
    } else {
      assert.equal(value.type, "child");
    }
    for (const wake of waiters) {
      wake();
    }
  });
  const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  const databasePath = path.join(directory, "reference-child.sqlite");
  const closeReceiptPath = path.join(directory, "original-child-close.json");
  assert.equal(existsSync(closeReceiptPath), false, "require a fresh original-close receipt");
  const assertOriginalChildClosed = () => {
    const receipt: unknown = JSON.parse(readFileSync(closeReceiptPath, "utf8"));
    assert.deepEqual(receipt, { kind: "child-close", code: 0, signal: null });
  };
  const resource = source.captureResource(
    resolveRuntimeWorkerUrl(nativeWorkerResourceEntrypoint),
    "nativeResource",
    {
      databasePath,
      gateFirstFailure: ending === "resource-idle-supervisor-loss",
      closeReceiptPath,
    },
    () => ({
      port: channel.port2,
      service() {},
      setReferenced(referenced) {
        if (referenced) {
          channel.port1.ref();
          channel.port2.ref();
        } else {
          channel.port1.unref();
          channel.port2.unref();
        }
      },
      dispose() {
        disposed = true;
        channel.port1.close();
      },
    }),
  );
  let diagnosticGate: DiagnosticGate | undefined;
  const originalOn: unknown = Reflect.get(MessagePort.prototype, "on");
  assert.ok(typeof originalOn === "function");
  const diagnosticListeners =
    ending === "resource-diagnostic-references"
      ? mock.method(
          MessagePort.prototype,
          "on",
          function (this: MessagePort, ...args: Parameters<MessagePort["on"]>) {
            const [event, listener] = args;
            if (event !== "message") {
              Reflect.apply(originalOn, this, args);
              return this;
            }
            const receive = (packet: unknown) => {
              const gate = diagnosticGate;
              if (
                gate &&
                isRecord(packet) &&
                (packet.type === gate.kind || packet.type === "request-error") &&
                typeof packet.id === "number" &&
                typeof packet.requestId === "number"
              ) {
                assert.ok(gate.held === undefined, "hold one genuine diagnostic response");
                let delivered = false;
                gate.held = {
                  packet,
                  deliver: () => {
                    assert.equal(delivered, false, "deliver the original packet exactly once");
                    delivered = true;
                    Reflect.apply(listener, this, [packet]);
                  },
                };
                gate.arrived.resolve();
                return;
              }
              Reflect.apply(listener, this, [packet]);
            };
            Reflect.apply(originalOn, this, [event, receive]);
            return this;
          },
        )
      : undefined;
  const registrations = mock.method(Worker.prototype, "on");
  const captures = mock.method(SpawnBrokerHost.prototype, "captureNativeResource");
  const observed = (() => {
    try {
      const sibling =
        ending === "resource-reference-retry"
          ? createRetainedNativeWorker(
              `const {parentPort}=require("node:worker_threads");
               parentPort.on("message", value=>parentPort.postMessage(value+1, []));`,
              { eval: true, execArgv: [] },
              source,
            )
          : undefined;
      const target = createRetainedNativeWorker(
        `const {parentPort,workerData}=require("node:worker_threads");
         const port=workerData.nativeResource;
         port.on("message", value=>parentPort.postMessage(value, []));
         parentPort.on("message", value=>port.postMessage(value, []));
         port.postMessage({open:true}, []);`,
        { eval: true, execArgv: [], workerData: {} },
        source,
        resource,
      );
      const supervisor = registrations.mock.calls
        .map((call) => call.this)
        .find((value) => value instanceof Worker);
      const host = captures.mock.calls[0]?.this;
      assert.ok(supervisor instanceof Worker);
      assert.ok(host instanceof SpawnBrokerHost);
      return { target, supervisor, host, sibling };
    } finally {
      registrations.mock.restore();
      captures.mock.restore();
      diagnosticListeners?.mock.restore();
    }
  })();
  const { target, supervisor, host, sibling } = observed;
  const ready = createDeferredCore();
  const joined = createDeferredCore();
  const replies: unknown[] = [];
  const failures: Error[] = [];
  const diagnostics: { kind: "cpu" | "heap"; outcome: "fulfilled" | "rejected" }[] = [];
  target.on("message", (value: unknown) => {
    assert.ok(isRecord(value));
    if (value.ready === true) {
      ready.resolve();
    } else {
      replies.push(value);
    }
    for (const wake of waiters) {
      wake();
    }
  });
  target.on("error", (error) => {
    failures.push(error);
    ready.reject(error);
  });
  target.on("messageerror", ready.reject);
  target.once("exit", () => {
    // The original broker writes this only inside ChildProcess.close, before resolving cleanup.
    // Its forwarded MessagePort notification is a separate asynchronous observation.
    assertOriginalChildClosed();
    originalChildClosedBeforeExit = true;
    childCloseNotifiedBeforeExit = facts.childClosed;
    joined.resolve();
  });
  let observer: DatabaseSync | undefined;
  let leavingPassive = false;
  const sendOwner = (type: string) => {
    if (!disposed) {
      channel.port1.postMessage({ type });
    }
  };
  try {
    await ready.promise;
    await waitFor(() => facts.environment);
    assert.equal(facts.constructions, 1);
    const database = new DatabaseSync(databasePath);
    observer = database;
    database.exec("PRAGMA busy_timeout=0");
    const assertHeld = () => {
      assert.equal(facts.constructions, 1);
      assert.equal(facts.childClosed, false);
      assert.equal(existsSync(closeReceiptPath), false);
      assert.ok(target.threadId > 0);
      assert.throws(() => database.exec("BEGIN IMMEDIATE"), /locked|busy/i);
    };
    assertHeld();
    if (ending === "resource-passive-exit") {
      database.close();
      observer = undefined;
      complete = true;
      leavingPassive = true;
      console.log(JSON.stringify({ ending, passiveReady: true }));
      target.unref();
      return;
    }
    if (ending === "resource-diagnostic-references") {
      target.unref();
      let previousRequestId = 0;
      let diagnosticHandleId: number | undefined;
      for (const kind of ["cpu", "heap"] as const) {
        assert.equal(channel.port1.hasRef(), false);
        assert.equal(channel.port2.hasRef(), false);
        const gate: DiagnosticGate = { kind, arrived: createDeferredCore() };
        diagnosticGate = gate;
        let settled = false;
        type Outcome =
          | { status: "fulfilled"; value: unknown }
          | { status: "rejected"; error: unknown };
        const pending = kind === "cpu" ? target.cpuUsage() : target.getHeapStatistics();
        const observedOutcome = pending.then<Outcome, Outcome>(
          (value) => {
            settled = true;
            return { status: "fulfilled", value };
          },
          (error: unknown) => {
            settled = true;
            return { status: "rejected", error };
          },
        );
        assert.equal(channel.port1.hasRef(), true);
        assert.equal(channel.port2.hasRef(), true);
        await gate.arrived.promise;
        const held = gate.held;
        assert.ok(held, "the native owner must produce the diagnostic response");
        assert.equal(settled, false);
        assert.equal(channel.port1.hasRef(), true);
        assert.equal(channel.port2.hasRef(), true);
        assertHeld();
        assert.ok(typeof held.packet.id === "number");
        assert.ok(typeof held.packet.requestId === "number");
        diagnosticHandleId ??= held.packet.id;
        assert.equal(held.packet.id, diagnosticHandleId);
        assert.ok(held.packet.requestId > previousRequestId);
        previousRequestId = held.packet.requestId;
        held.deliver();
        const outcome = await observedOutcome;
        if (held.packet.type === "request-error") {
          assert.equal(outcome.status, "rejected");
          if (outcome.status === "rejected") {
            assert.ok(outcome.error instanceof Error);
          }
        } else {
          assert.equal(held.packet.type, kind);
          assert.equal(outcome.status, "fulfilled");
          if (outcome.status === "fulfilled") {
            assert.ok(outcome.value === held.packet.value, "preserve diagnostic value");
          }
        }
        diagnostics.push({ kind, outcome: outcome.status });
        diagnosticGate = undefined;
        assert.equal(channel.port1.hasRef(), false);
        assert.equal(channel.port2.hasRef(), false);
      }
    }
    if (ending === "resource-reference-retry" || ending === "resource-diagnostic-references") {
      if (ending === "resource-reference-retry") {
        assert.ok(sibling);
      }
      if (sibling) {
        const response = createDeferredCore<unknown>();
        sibling.on("message", response.resolve);
        sibling.on("error", response.reject);
        sibling.on("messageerror", response.reject);
        target.unref();
        // The earlier referenced sibling must not short-circuit this later handle's ports.
        assert.equal(channel.port1.hasRef(), false);
        assert.equal(channel.port2.hasRef(), false);
        sibling.postMessage(41, []);
        assert.equal(await response.promise, 42);
        await sibling.stop().result;
        sibling.unref();
        assert.equal(sibling.threadId, -1);
      }
      assertHeld();
      // Domain work refs its original live target, as the pool resource owner does.
      target.ref();
      assert.equal(channel.port1.hasRef(), true);
      assert.equal(channel.port2.hasRef(), true);
      target.postMessage({ type: "domain-close" }, []);
      await waitFor(() => replies.length === 1);
      assert.deepEqual(replies[0], {
        domainClosed: false,
        error: "synthetic first resource close failure",
      });
      target.unref();
      assert.equal(channel.port1.hasRef(), false);
      assert.equal(channel.port2.hasRef(), false);
      assertHeld();
      await assert.rejects(host.close(), /claims must close before broker shutdown/);
      target.ref();
      assert.equal(channel.port1.hasRef(), true);
      assert.equal(channel.port2.hasRef(), true);
      target.postMessage({ type: "domain-close" }, []);
      await waitFor(() => facts.attempts === 2);
      assertHeld();
      sendOwner("permit-close");
      await waitFor(() => replies.length === 2);
      assert.deepEqual(replies[1], { domainClosed: true });
      assertOriginalChildClosed();
      target.unref();
      // Pending native stop owns a reference even after the caller has unrefed it.
      await target.stop().result;
    } else {
      target.unref();
      await supervisor.terminate();
      await nextTurn();
      assertHeld();
      await waitFor(() => facts.attempts === 1);
      await assert.rejects(host.close(), /claims must close before broker shutdown/);
      const retry = target.stop();
      assert.equal(retry.read().status, "rejected");
      sendOwner("fail-first-close");
      await waitFor(() => facts.attempts === 2);
      assertHeld();
      sendOwner("permit-close");
      await joined.promise;
      assert.equal(retry.read().status, "rejected");
      assert.deepEqual(target.stop().read(), { status: "fulfilled", value: undefined });
    }
    if (ending !== "resource-idle-supervisor-loss") {
      assert.equal(failures.length, 0);
    }
    assert.equal(originalChildClosedBeforeExit, true);
    assert.equal(target.threadId, -1);
    target.unref();
    database.exec("BEGIN IMMEDIATE");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM proof").get()?.count, 1);
    database.exec("ROLLBACK");
    complete = true;
    console.log(
      JSON.stringify({
        ending,
        originalChildClosed: true,
        childCloseNotifiedBeforeExit,
        sqliteReusable: true,
        ...(ending === "resource-diagnostic-references" ? { diagnostics } : {}),
      }),
    );
  } finally {
    if (!leavingPassive) {
      sendOwner("fail-first-close");
      sendOwner("permit-close");
      observer?.close();
      await sibling?.terminate().catch(() => undefined);
      await target.terminate().catch(() => undefined);
      await supervisor.terminate();
      await nextTurn();
      channel.port1.close();
      channel.port2.close();
    }
  }
}
