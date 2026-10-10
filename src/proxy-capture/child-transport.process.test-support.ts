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
await finalizeDebugProxyCaptureAsync();
