import { gzipSync } from "node:zlib";
import { exclusiveBytes } from "./backup-gzip-bytes.js";
import { serveWorkerTasks } from "./worker-task-server.js";

// Synchronous zlib keeps compression on this thread, off the parent's libuv pool.
serveWorkerTasks<Uint8Array<ArrayBuffer>, Uint8Array>((block) => exclusiveBytes(gzipSync(block)), {
  transferList: (member) => [member.buffer],
});
