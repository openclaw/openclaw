import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { GatewayBenchWorkerProfiler } from "../../../scripts/lib/gateway-bench-worker-profile.ts";

const debug = new Session();
debug.connect();
const requests = new Map();
const scripts = new Map();
let sequence = 1;
let resolvePaused;
const paused = new Promise((resolve) => {
  resolvePaused = resolve;
});
function post(sessionId, method, params = {}) {
  const id = sequence++;
  const pending = new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject });
  });
  void debug
    .post("NodeWorker.sendMessageToWorker", {
      sessionId,
      message: JSON.stringify({ id, method, params }),
    })
    .catch((error) => requests.get(id)?.reject(error));
  return pending;
}
debug.on("NodeWorker.receivedMessageFromWorker", ({ params }) => {
  const message = JSON.parse(params.message);
  const request = requests.get(message.id);
  if (request) {
    requests.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message));
    } else {
      request.resolve(message.result);
    }
  }
  if (message.method === "Debugger.scriptParsed") {
    scripts.set(message.params.scriptId, message.params.url);
  }
  if (message.method === "Debugger.paused") {
    const frame = message.params.callFrames[0];
    if (scripts.get(frame.location.scriptId) === "node:worker_threads") {
      resolvePaused(params.sessionId);
    } else {
      void post(params.sessionId, "Debugger.resume");
    }
  }
});

let worker;
let inspector;
try {
  const retired = new Worker("", { eval: true, execArgv: [] });
  await once(retired, "exit");
  await debug.post("NodeWorker.enable", { waitForDebuggerOnStart: true });
  const attached = once(debug, "NodeWorker.attachedToWorker");
  worker = new Worker(
    `const { parentPort } = require('node:worker_threads');
     function allocateAtStartup() {
       const until = Date.now() + 500;
       let total = 0;
       while (Date.now() < until) {
         const rows = Array.from({ length: 10000 }, (_, i) => ({ i, values: [i, i + 1] }));
         total += rows[rows.length - 1].values[1];
       }
       return total;
     }
     parentPort.on('message', () => {});
     parentPort.postMessage(allocateAtStartup());`,
    { eval: true, execArgv: [], name: "[worker 999] fixture" },
  );
  const complete = once(worker, "message");
  const [{ params: target }] = await attached;
  await post(target.sessionId, "Debugger.enable");
  // The first executable statement runs before this builtin publishes its exports.
  const breakpoint = await post(target.sessionId, "Debugger.setBreakpointByUrl", {
    url: "node:worker_threads",
    lineNumber: 0,
  });
  await post(target.sessionId, "Runtime.runIfWaitingForDebugger");
  await paused;

  inspector = new Session();
  const send = inspector.post.bind(inspector);
  const unknownIdentity = process.argv[3] === "true";
  if (unknownIdentity) {
    inspector.on("NodeWorker.attachedToWorker", ({ params }) => {
      params.workerInfo.title = "unsupported worker title";
    });
  }
  const profilingTarget = once(inspector, "NodeWorker.attachedToWorker");
  const profiler = new GatewayBenchWorkerProfiler(inspector);
  inspector.connect();
  const profilePath = path.join(process.argv[2], "startup.heap");
  await profiler.start("heap", profilePath);
  await post(target.sessionId, "Debugger.removeBreakpoint", {
    breakpointId: breakpoint.breakpointId,
  });
  await post(target.sessionId, "Debugger.resume");
  await complete;
  await profiler.stop("heap");
  const manifest = JSON.parse(await readFile(`${profilePath}.workers.json`, "utf8"));
  let samplerStopProbe;
  if (unknownIdentity) {
    const [{ params: profiled }] = await profilingTarget;
    const response = new Promise((resolve) => {
      const received = ({ params }) => {
        const message = JSON.parse(params.message);
        if (message.id === 1000000) {
          inspector.off("NodeWorker.receivedMessageFromWorker", received);
          resolve(message);
        }
      };
      inspector.on("NodeWorker.receivedMessageFromWorker", received);
    });
    await send("NodeWorker.sendMessageToWorker", {
      sessionId: profiled.sessionId,
      message: JSON.stringify({ id: 1000000, method: "HeapProfiler.stopSampling" }),
    });
    samplerStopProbe = await response;
  }
  await writeFile(
    path.join(process.argv[2], "result.json"),
    JSON.stringify({ threadId: worker.threadId, manifest, samplerStopProbe }),
  );
} finally {
  await worker?.terminate();
  inspector?.disconnect();
  debug.disconnect();
}
