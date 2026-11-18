import { MessageChannel, Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { createPluginCaptureResourceClient } from "./plugin-capture-native-resource.client.js";

it("refuses a synchronous resource request when its owner port closes without a reply", async () => {
  const { port1, port2 } = new MessageChannel();
  const owner = new Worker(
    'const { workerData } = require("node:worker_threads"); workerData.on("message", () => workerData.close());',
    { eval: true, workerData: port2, transferList: [port2] },
  );
  const client = createPluginCaptureResourceClient(port1);
  try {
    expect(() => client.requestSync({ type: "loaded", filename: "synthetic-native-file" })).toThrow(
      "Plugin capture custody transport is unavailable",
    );
  } finally {
    port1.close();
    await owner.terminate();
  }
});
