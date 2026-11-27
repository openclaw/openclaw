import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { getWorkerMessageMetrics } from "./worker-message-metrics.js";
import { NativeWorker } from "./worker-native-handle.js";
import type {
  NativeWorkerRequest,
  NativeWorkerRuntime,
  RetainedNativeWorker,
} from "./worker-native-lifecycle.types.js";

// These endpoints run on the Gateway main thread; Vitest itself runs in a worker.
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: true,
}));

const cleanups: Array<() => void> = [];
const workerUrl = new URL("file:///synthetic/direct-task.worker.mjs");
const messageMetrics = () =>
  getWorkerMessageMetrics().find(
    (entry) => entry.kind === "other" && entry.direction === "from_worker",
  );
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function fixture(directTaskPort = true) {
  const { port1: port, port2: peer } = new MessageChannel();
  const context = new AsyncLocalStorage<string>();
  const sent: NativeWorkerRequest[] = [];
  const references: boolean[] = [];
  const handles = new Set([1]);
  const runtime: NativeWorkerRuntime = {
    handles,
    service: () => worker.serviceTaskPort(),
    post: (message, transfers = []) => {
      sent.push(message);
      if (!directTaskPort) {
        port.postMessage(message, transfers);
      }
    },
    refreshReference: () => references.push(worker.needsReference),
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
        workerUrl,
        false,
        false,
        undefined,
        directTaskPort ? port : undefined,
      ),
  );
  worker.on("error", () => {});
  cleanups.push(() => {
    worker.ownerJoined(new Error("Fixture native owner joined"));
    port.close();
    peer.close();
  });
  return { worker, port, peer, context, sent, handles, runtime, references };
}

it.each([false, true])(
  "borrows the transfer list until native send completes (direct: %s)",
  async (direct) => {
    const { worker, port, peer, sent } = fixture(direct);
    worker.receive({ type: "created", id: 1, threadId: 105 });
    const post = vi.spyOn(port, "postMessage");
    const bytes = new Uint8Array([2, 4, 6]);
    const transfers = Object.freeze([bytes.buffer]);
    const sender: RetainedNativeWorker = worker;
    const received = once(peer, "message");

    sender.postMessage({ bytes }, transfers);

    expect(bytes.byteLength).toBe(0);
    const [message] = await received;
    expect(post.mock.calls[0]?.[1] === transfers).toBe(true);
    if (direct) {
      expect(message).toEqual({ bytes: new Uint8Array([2, 4, 6]) });
      return;
    }
    expect(message).toMatchObject({
      type: "post",
      id: 1,
      value: { bytes: new Uint8Array([2, 4, 6]) },
    });
    expect(message.transferList[0] === message.value.bytes.buffer).toBe(true);
    const envelope = sent.find((entry) => entry.type === "post");
    expect(envelope?.transferList === post.mock.calls[0]?.[1]).toBe(true);
  },
);

it("retains pre-start messages and permits synchronous delivery from the started callback", async () => {
  const { worker, port, peer, context } = fixture();
  const before = messageMetrics();
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
  context.run("servicing", () => worker.receive({ type: "created", id: 1, threadId: 101 }));
  expect(events).toEqual([
    ["started", "constructor"],
    ["buffered", "constructor"],
    ["queued", "constructor"],
  ]);
  expect(messageMetrics()).toEqual({
    kind: "other",
    direction: "from_worker",
    messages: (before?.messages ?? 0) + 2,
    payloadBytes: (before?.payloadBytes ?? 0) + 28,
    unmeasuredMessages: before?.unmeasuredMessages ?? 0,
  });
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
  expect(worker).toMatchObject({ started: false, executionStopped: false });
  expect(handles.size).toBe(1);
  worker.ownerJoined(new Error("native owner joined"));
  expect(events).toEqual(["native failure", "execution-exit", "exit"]);
  expect(worker.stop().read()).toEqual({ status: "fulfilled", value: undefined });
  expect(handles.size).toBe(0);
});

it("reports task-port loss without stopping native work or inventing its exit receipt", async () => {
  const { worker, peer, sent, handles } = fixture();
  worker.receive({ type: "created", id: 1, threadId: 103 });
  const failed = once(worker, "error");
  peer.close();
  const [failure] = await failed;
  expect(failure).toMatchObject({ message: "Native worker task channel closed" });
  expect(() => worker.ref()).toThrow("Native worker task channel closed");
  expect(worker.executionStopped).toBe(false);
  expect(sent.some((message) => message.type === "stop")).toBe(false);
  const stopping = worker.stop();
  expect(stopping.read().status).toBe("pending");
  const events: string[] = [];
  worker.on("execution-exit", () => {
    events.push("execution-exit");
    expect(worker.executionStopped).toBe(true);
    expect(worker.threadId).toBe(103);
    expect(handles.has(1)).toBe(true);
    expect(stopping.read().status).toBe("pending");
  });
  worker.on("exit", () => events.push("exit"));
  worker.receive({ type: "stopped", id: 1, code: 0 });
  expect(events).toEqual(["execution-exit", "exit"]);
  expect(stopping.read()).toEqual({ status: "fulfilled", value: undefined });
});

it("keeps reference transitions local while retaining pending samples and checking repeated admission", async () => {
  const { worker, sent, runtime, references } = fixture();
  worker.receive({ type: "created", id: 1, threadId: 104 });
  worker.ref();
  worker.ref();
  worker.unref();
  worker.unref();
  expect(references.at(-1)).toBe(false);

  const cpu = worker.cpuUsage();
  const { requestId } = expectDefined(
    sent.find((m) => m.type === "cpu"),
    "CPU request",
  );
  const value = { user: 3, system: 1 };
  worker.unref();
  expect(references.at(-1)).toBe(true);
  worker.receive({ type: "cpu", id: 1, requestId, value });
  await expect(cpu).resolves.toEqual(value);
  expect(references.at(-1)).toBe(false);

  worker.ref();
  worker.ref();
  expect(references.at(-1)).toBe(true);
  expect(sent).toEqual([{ type: "cpu", id: 1, requestId, previous: undefined }]);
  const unavailable = new Error("Native source no longer owns execution");
  runtime.failure = unavailable;
  expect(() => worker.ref()).toThrow(unavailable);
  expect(() => worker.unref()).toThrow(unavailable);
  expect(() => worker.unref()).toThrow(unavailable);
});
