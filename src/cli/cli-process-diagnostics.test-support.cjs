// Loaded only by the CLI process test harness, before application startup.
const { createHook } = require("node:async_hooks");
const { _getActiveHandles: getActiveHandles, _getActiveRequests: getActiveRequests } = process;

const pendingPromises = new Set();
const promiseLimit = 4_096;
let promisesTruncated = false;
const startedAt = Date.now();

createHook({
  init(id, type) {
    if (type !== "PROMISE") {
      return;
    }
    if (pendingPromises.size < promiseLimit) {
      pendingPromises.add(id);
    } else {
      promisesTruncated = true;
    }
  },
  promiseResolve(id) {
    pendingPromises.delete(id);
  },
  destroy(id) {
    pendingPromises.delete(id);
  },
}).enable();

function countNames(names) {
  const counts = new Map();
  for (const name of names) {
    if (counts.has(name) || counts.size < 64) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return Object.fromEntries(counts);
}

process.on("SIGUSR2", () => {
  const diagnostic = {
    pid: process.pid,
    elapsedMs: Date.now() - startedAt,
    activeResources: countNames(process.getActiveResourcesInfo()),
    activeHandles: countNames(getActiveHandles().map((handle) => handle.constructor.name)),
    activeRequests: countNames(getActiveRequests().map((request) => request.constructor.name)),
    pendingPromises: {
      tracked: pendingPromises.size,
      truncated: promisesTruncated,
      hint: "Unresolved promises alone do not keep the event loop alive.",
    },
  };
  process.stderr.write(`[cli-process-diagnostics] ${JSON.stringify(diagnostic)}\n`);
});
process.stderr.write(`[cli-process-diagnostics] ready pid=${process.pid}\n`);
