// Loaded only by the CLI process test harness, before application startup.
const { createHook } = require("node:async_hooks");
const { _getActiveHandles: getActiveHandles, _getActiveRequests: getActiveRequests } = process;

const pendingPromises = new Set();
const promiseLimit = 4_096;
let promisesTruncated = false;
const startedAt = Date.now();

// An exit-time native wait cannot service the later SIGUSR2 diagnostic request.
if (process.execArgv.includes("--trace-exit") && require("node:worker_threads").isMainThread) {
  const { writeSync } = require("node:fs");
  // Keep the original method unbound: borrowed calls must retain their own receiver.
  const emit = process.emit;
  const writeExitBoundary = (phase, exitCode) => {
    try {
      const listeners = phase === "exit-listeners-enter" ? process.listeners("exit") : undefined;
      writeSync(
        2,
        `[cli-process-diagnostics] ${JSON.stringify({
          pid: process.pid,
          phase,
          exitCode,
          elapsedMs: Date.now() - startedAt,
          ...(listeners
            ? {
                listenerCount: listeners.length,
                listenerNames: listeners.slice(0, 16).map((listener) => listener.name.slice(0, 64)),
                listenersTruncated: listeners.length > 16,
              }
            : {}),
        })}\n`,
      );
    } catch {
      // Diagnostics must preserve the original exit dispatch and error.
    }
  };
  process.emit = function (event, ...args) {
    if (this !== process || event !== "exit") {
      return Reflect.apply(emit, this, [event, ...args]);
    }
    writeExitBoundary("exit-listeners-enter", args[0]);
    try {
      const result = Reflect.apply(emit, this, [event, ...args]);
      writeExitBoundary("exit-listeners-return", args[0]);
      return result;
    } catch (error) {
      writeExitBoundary("exit-listeners-throw", args[0]);
      throw error;
    }
  };
}

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
