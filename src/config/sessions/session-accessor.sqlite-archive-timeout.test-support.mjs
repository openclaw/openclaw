import fs from "node:fs";
import { workerData } from "node:worker_threads";

// Pause a real archive before its staging file closes. Native syscall custody is covered
// separately by the isolated Gateway proof; Atomics.wait is interruptible JS.
const gate = new Int32Array(workerData.archiveTimeoutGate);
const stages = new Set();
const open = fs.openSync;
fs.openSync = (file, ...args) => {
  const fd = open(file, ...args);
  if (String(file).endsWith(".jsonl-stage")) {
    stages.add(fd);
  }
  return fd;
};
const close = fs.closeSync;
fs.closeSync = (fd) => {
  if (stages.delete(fd)) {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    Atomics.wait(gate, 1, 0);
  }
  return close(fd);
};
await import(workerData.archiveTimeoutEntry);
