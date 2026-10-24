import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { createPostgresBridge } from "./postgres-sync/bridge-prestart.js";
import type { PostgresBridge } from "./postgres-sync/protocol.js";
import { serveWorkerMemorySamples } from "./worker-memory.js";

if (!parentPort) {
  throw new Error("Bridge census fixture requires a parent");
}
serveWorkerMemorySamples(parentPort);
const control: MessagePort = workerData.control;
const bridges: PostgresBridge[] = [];
async function receive(command: "create" | "close"): Promise<void> {
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
  control.postMessage(bridges.length, []);
}
control.on("message", (command: "create" | "close") => {
  void receive(command);
});
