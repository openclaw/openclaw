import { once } from "node:events";
import {
  MessageChannel,
  parentPort,
  workerData,
  type MessagePort,
  type Worker,
} from "node:worker_threads";
import { createPostgresBridge } from "./postgres-sync/bridge-prestart.js";
import type { PostgresBridge } from "./postgres-sync/protocol.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import { createCpuTrackedWorker, receiveWorkerMemoryPort } from "./worker-cpu.js";
import { serveWorkerMemorySamples } from "./worker-memory.js";

if (!parentPort) {
  throw new Error("Bridge census fixture requires a parent");
}
const control: MessagePort = workerData.control;
type Command = "create" | "close" | "nest" | "unnest";
let child: Worker | undefined;
let childControl: MessagePort | undefined;
async function createChild(depth: number): Promise<void> {
  const { port1, port2 } = new MessageChannel();
  const workerUrl = new URL(import.meta.url);
  const worker = createCpuTrackedWorker(workerUrl, {
    workerData: { control: port2, depth },
    transferList: [port2],
    execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
  });
  child = worker;
  childControl = port1;
  await new Promise<void>((resolve, reject) => {
    worker.on("message", (message: unknown) => {
      if (receiveWorkerMemoryPort(worker, message)) {
        resolve();
      }
    });
    worker.once("error", reject);
  });
}
if (workerData.depth > 0) {
  await createChild(workerData.depth - 1);
}
serveWorkerMemorySamples(parentPort);
const bridges: PostgresBridge[] = [];
async function receive(command: Command): Promise<unknown> {
  if (command === "nest") {
    await createChild(0);
    return 0;
  }
  if (command === "unnest") {
    await child?.terminate();
    childControl?.close();
    child = undefined;
    childControl = undefined;
    return 0;
  }
  if (childControl) {
    const reply = once(childControl, "message");
    childControl.postMessage(command, []);
    return (await reply)[0];
  }
  if (command === "create") {
    bridges.push(
      createPostgresBridge({
        url: "postgres://localhost/bridge_census_fixture",
        schema: "fixture",
        storeId: "fixture",
      }),
    );
  } else {
    const bridge = bridges.pop();
    if (bridge) {
      bridge.port.close();
      await bridge.worker.terminate();
    }
  }
  return bridges.length;
}
control.on("message", (command: Command) => {
  void receive(command).then((reply) => control.postMessage(reply, []));
});
