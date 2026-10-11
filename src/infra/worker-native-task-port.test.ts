import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it } from "vitest";
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
  const references: boolean[] = [];
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
    refreshReference() {
      references.push(worker.needsReference);
    },
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
  return {
    worker,
    port: port1,
    peer: port2,
    context,
    controls,
    sent,
    errors,
    handles,
    runtime,
    references,
  };
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

  it("reports task-port loss without stopping native work or inventing its exit receipt", async () => {
    const { worker, peer, controls, sent } = fixture();
    controls.push({ type: "created", id: 1, threadId: 103 });
    worker.service();
    const failed = once(worker, "error");
    peer.close();
    const [failure] = await failed;
    expect(failure).toMatchObject({ message: "Native worker task channel closed" });
    expect(() => worker.ref()).toThrow("Native worker task channel closed");
    expect(worker.executionStopped).toBe(false);
    expect(sent.some((message) => message.type === "stop")).toBe(false);
    const stopping = worker.stop();
    expect(stopping.read().status).toBe("pending");
    controls.push({ type: "execution-exit", id: 1, code: 0 }, { type: "stopped", id: 1, code: 0 });
    worker.service();
    expect(stopping.read()).toEqual({ status: "fulfilled", value: undefined });
  });

  it("sends reference transitions while retaining pending samples and checking repeated admission", async () => {
    const { worker, controls, sent, runtime, references } = fixture();
    controls.push({ type: "created", id: 1, threadId: 104 });
    worker.service();
    worker.ref();
    worker.ref();
    worker.unref();
    worker.unref();
    expect(references.at(-1)).toBe(false);

    const cpu = worker.cpuUsage();
    const sample = expectDefined(
      sent.find((message) => message.type === "cpu"),
      "native CPU request",
    );
    worker.unref();
    expect(references.at(-1)).toBe(true);
    controls.push({
      type: "cpu",
      id: 1,
      requestId: sample.requestId,
      value: { user: 3, system: 1 },
    });
    worker.service();
    await expect(cpu).resolves.toEqual({ user: 3, system: 1 });
    expect(references.at(-1)).toBe(false);

    worker.ref();
    worker.ref();
    expect(sent.filter((message) => message.type === "ref")).toEqual([
      { type: "ref", id: 1, referenced: false },
      { type: "ref", id: 1, referenced: true },
    ]);
    const unavailable = new Error("Native source no longer owns execution");
    runtime.failure = unavailable;
    expect(() => worker.ref()).toThrow(unavailable);
    expect(() => worker.unref()).toThrow(unavailable);
    expect(() => worker.unref()).toThrow(unavailable);
  });
});
