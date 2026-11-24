import { once } from "node:events";
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

it("references overlapping requests until acknowledged and retains a lost reply", async () => {
  const { port1, port2 } = new MessageChannel();
  let referenced = true;
  const client = createPluginCaptureResourceClient(port1, undefined, {
    ref() {
      referenced = true;
      port1.ref();
    },
    unref() {
      referenced = false;
      port1.unref();
    },
  });
  try {
    expect(referenced).toBe(false);
    const firstDelivery = once(port2, "message");
    const first = client.request({ type: "loaded", filename: "synthetic-first" });
    const [firstMessage] = await firstDelivery;
    const secondDelivery = once(port2, "message");
    const second = client.request({ type: "loaded", filename: "synthetic-second" });
    const [secondMessage] = await secondDelivery;
    expect(referenced).toBe(true);
    port2.postMessage({ id: firstMessage.id, ok: true });
    await first;
    expect(referenced).toBe(true);
    port2.postMessage({ id: secondMessage.id, ok: true });
    await second;
    expect(referenced).toBe(false);

    const lostDelivery = once(port2, "message");
    const lost = client.request({ type: "loaded", filename: "synthetic-lost" });
    const rejected = expect(lost).rejects.toThrow(
      "Plugin capture custody transport is unavailable",
    );
    await lostDelivery;
    port2.close();
    await rejected;
    expect(referenced).toBe(true);
  } finally {
    port1.close();
    port2.close();
  }
});
