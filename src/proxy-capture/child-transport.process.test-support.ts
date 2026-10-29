import { get } from "node:http";
import { createAmbientNodeProxyAgent } from "@openclaw/proxyline";
import {
  captureWsEventAsync,
  finalizeDebugProxyCaptureAsync,
  initializeDebugProxyCaptureAsync,
} from "./runtime.js";

await initializeDebugProxyCaptureAsync("cli-child");
await captureWsEventAsync({
  url: "wss://fixture.invalid/socket",
  direction: "outbound",
  kind: "ws-frame",
  flowId: "child-flow",
  payload: Buffer.from("child payload"),
});
const target = process.argv[2];
if (target) {
  const agent = createAmbientNodeProxyAgent({ protocol: "http" });
  try {
    await new Promise<void>((resolve, reject) => {
      get(target, { agent }, (res) => {
        res.resume();
        res.once("end", resolve);
        res.once("error", reject);
      }).once("error", reject);
    });
  } finally {
    agent?.destroy();
  }
}
await finalizeDebugProxyCaptureAsync();
