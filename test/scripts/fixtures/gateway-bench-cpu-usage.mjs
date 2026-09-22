import { once } from "node:events";
import { Session } from "node:inspector/promises";
import { Worker } from "node:worker_threads";

Session.prototype.connect = () => {
  throw new Error("CPU accounting must not activate the inspector");
};
await import("../../../scripts/lib/gateway-bench-profile-preload.ts");
// Keep the fixture available for its final sample after its last Worker exits.
process.channel.ref();

function fixedCpuWork() {
  let checksum = 1;
  for (let index = 0; index < 25_000_000; index++) {
    checksum = Math.imul(checksum ^ index, 16_777_619);
  }
  return checksum;
}

for (let index = 0; index < 8; index++) {
  fixedCpuWork();
}
const worker = new Worker(
  `const { parentPort } = require("node:worker_threads");
   const fixedCpuWork = ${fixedCpuWork.toString()};
   parentPort.once("message", () => {
     const before = process.threadCpuUsage();
     const checksum = fixedCpuWork();
     const cpu = process.threadCpuUsage(before);
     parentPort.postMessage({ checksum, cpuMicros: cpu.user + cpu.system });
     parentPort.close();
   });
   parentPort.postMessage("ready");`,
  { eval: true, execArgv: [] },
);
await once(worker, "message");
process.on("message", async (message) => {
  if (message.run === "main") {
    process.send({ completed: 1, checksum: fixedCpuWork() });
    return;
  }
  if (message.run !== "worker") {
    return;
  }
  const completed = once(worker, "message");
  const exited = once(worker, "exit");
  worker.postMessage("run");
  const [result] = await completed;
  await exited;
  process.send({
    completed: 1,
    workerRetired: true,
    checksum: result.checksum,
    workerCpuMicros: result.cpuMicros,
  });
});
process.send({ ready: true });
