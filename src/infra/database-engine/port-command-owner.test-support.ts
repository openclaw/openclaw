import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { acquireGatewayLock } from "../gateway-lock.js";

assert(parentPort);
const owner = await acquireGatewayLock({
  env: workerData.env as NodeJS.ProcessEnv,
  role: "agent-embedded",
  allowInTests: true,
  timeoutMs: 0,
});
assert(owner);
try {
  const stopped = new Promise<void>((resolve) => {
    parentPort!.once("message", resolve);
  });
  parentPort.postMessage("ready", []);
  await stopped;
} finally {
  await owner.release();
}
