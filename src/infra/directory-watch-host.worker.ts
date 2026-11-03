import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";

// Watch errors can block this event loop in native FSEvents cleanup. The separate
// thread still ends the helper if its caller dies while the input pipes stay open.
const parentMonitor = resolveRuntimeProcessEntrypointUrl("directoryWatchParent");
new Worker(parentMonitor, {
  execArgv: resolveRuntimeWorkerThreadExecArgv(parentMonitor),
  workerData: { caller: Number(process.argv[2]) },
})
  .on("error", () => {})
  .unref();

type Request = { id: number; path?: string; recursive?: boolean };
const live = new Set<number>();
const send = (message: { id: number; event?: string; filename?: string | null }) =>
  process.stdout.write(`${JSON.stringify(message)}\n`);
let buffered = "";
process.stdin.setEncoding("utf8").on("data", (chunk: string) => {
  const lines = (buffered + chunk).split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    const request: Request = JSON.parse(line);
    const { id, path, recursive } = request;
    if (path === undefined) {
      live.delete(id);
      continue;
    }
    try {
      fs.watch(path, { persistent: false, recursive }, (event, filename) => {
        if (live.has(id)) {
          send({ id, event, filename });
        }
      }).on("error", () => live.delete(id) && send({ id }));
      live.add(id);
      // Invalidate once registration is live to cover its asynchronous startup.
      send({ id, event: "change" });
    } catch {
      send({ id });
    }
  }
});
// Skip FSEvents cleanup without entering V8's forced-exit worker join.
process.stdin.on("end", () => process.kill(process.pid, "SIGKILL"));
