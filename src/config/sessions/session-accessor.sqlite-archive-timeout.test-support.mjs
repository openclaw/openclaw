import fs from "node:fs";
import { workerData } from "node:worker_threads";

// Pause a real archive before its file flush. Native syscall custody is covered
// separately by the isolated Gateway proof; Atomics.wait is interruptible JS.
const gate = new Int32Array(workerData.archiveTimeoutGate);
const fsync = fs.fsyncSync;
fs.fsyncSync = (fd) => {
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
  Atomics.wait(gate, 1, 0);
  return fsync(fd);
};
await import(workerData.archiveTimeoutEntry);
