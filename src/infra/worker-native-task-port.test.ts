import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { encodeNativeWorkerFailure } from "./worker-native-error.js";
import { NativeWorker } from "./worker-native-handle.js";
import type {
  NativeWorkerReply,
  NativeWorkerRequest,
  NativeWorkerRuntime,
} from "./worker-native-lifecycle.types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function fixture() {
  const { port1, port2 } = new MessageChannel();
  const context = new AsyncLocalStorage<string>();
  const controls: NativeWorkerReply[] = [];
  const sent: NativeWorkerRequest[] = [];
  const errors: Error[] = [];
  const handles = new Set([1]);
  const runtime: NativeWorkerRuntime = {
    handles,
    service() {
      for (;;) {
        const reply = controls.shift();
        if (!reply) {
          break;
        }
        worker.receive(reply);
      }
      worker.serviceTaskPort();
    },
    post(message) {
      sent.push(message);
    },
    refreshReference() {},
    resourceBroker() {
      throw new Error("This fixture owns only a task port");
    },
  };
  const worker = context.run(
    "constructor",
    () =>
      new NativeWorker(
        runtime,
        1,
        new URL("file:///synthetic/direct-task.worker.mjs"),
        false,
        false,
        undefined,
        port1,
      ),
  );
  worker.on("error", (error) => errors.push(error));
  cleanups.push(() => {
    worker.ownerJoined(new Error("Fixture native owner joined"));
    port1.close();
    port2.close();
  });
  return { worker, port: port1, peer: port2, context, controls, sent, errors, handles };
}

describe("retained worker direct task transport", () => {
  it("retains pre-start messages and permits synchronous delivery from the started callback", async () => {
    const { worker, port, peer, context, controls } = fixture();
    const events: unknown[] = [];
    worker.on("message", (message) => events.push([message, context.getStore()]));
    worker.on("started", () => {
      events.push(["started", context.getStore()]);
      worker.service();
      expect(events).toHaveLength(3);
    });
    const buffered = once(port, "message");
    peer.postMessage("buffered", []);
    await buffered;
    expect(events).toEqual([]);
    peer.postMessage("queued", []);
    controls.push({ type: "created", id: 1, threadId: 101 });
    context.run("servicing", () => worker.service());
    expect(events).toEqual([
      ["started", "constructor"],
      ["buffered", "constructor"],
      ["queued", "constructor"],
    ]);
  });

  it("discards buffered data when its native owner fails before startup without inventing exit", async () => {
    const { worker, port, peer, handles } = fixture();
    const events: unknown[] = [];
    worker.on("message", (value) => events.push(value));
    worker.on("started", () => events.push("started"));
    worker.on("error", (error) => events.push(error.message));
    worker.on("execution-exit", () => events.push("execution-exit"));
    worker.on("exit", () => events.push("exit"));
    const buffered = once(port, "message");
    peer.postMessage("final reply", []);
    await buffered;
    expect(events).toEqual([]);
    worker.ownerFailed(new Error("native failure"));
    expect(events).toEqual(["native failure"]);
    expect(worker.started).toBe(false);
    expect(worker.executionStopped).toBe(false);
    expect(handles.size).toBe(1);
    worker.ownerJoined(new Error("native owner joined"));
    expect(events).toEqual(["native failure", "execution-exit", "exit"]);
    expect(worker.stop().read()).toEqual({ status: "fulfilled", value: undefined });
    expect(handles.size).toBe(0);
  });

  it("keeps pending native control order when a data callback reenters synchronous servicing", () => {
    const { worker, peer, context, controls } = fixture();
    const events: unknown[] = [];
    controls.push({ type: "created", id: 1, threadId: 102 });
    worker.service();
    worker.on("message", (value) => {
      events.push([value, context.getStore()]);
      worker.service();
      expect(worker.stop().read().status).toBe("fulfilled");
    });
    worker.on("error", (error) => events.push([error.message, context.getStore()]));
    worker.on("execution-exit", () => events.push(["execution-exit", context.getStore()]));
    worker.on("exit", () => events.push(["exit", context.getStore()]));
    peer.postMessage("first", []);
    peer.postMessage("second", []);
    controls.push(
      { type: "error", id: 1, error: encodeNativeWorkerFailure(new Error("native failure")) },
      { type: "execution-exit", id: 1, code: 1 },
      { type: "stopped", id: 1, code: 1 },
    );
    context.run("servicing", () => worker.service());
    expect(events).toEqual([
      ["first", "constructor"],
      ["second", "constructor"],
      ["native failure", "constructor"],
      ["execution-exit", "constructor"],
      ["exit", "constructor"],
    ]);
  });

  it("reports task-port loss without stopping native work or inventing its exit receipt", async () => {
    const { worker, peer, controls, sent } = fixture();
    controls.push({ type: "created", id: 1, threadId: 103 });
    worker.service();
    const failed = once(worker, "error");
    peer.close();
    const [failure] = await failed;
    expect(failure).toMatchObject({ message: "Native worker task channel closed" });
    expect(worker.executionStopped).toBe(false);
    expect(sent.some((message) => message.type === "stop")).toBe(false);
    const stopping = worker.stop();
    expect(stopping.read().status).toBe("pending");
    controls.push({ type: "execution-exit", id: 1, code: 0 }, { type: "stopped", id: 1, code: 0 });
    worker.service();
    expect(stopping.read()).toEqual({ status: "fulfilled", value: undefined });
  });
});
