import { execFileSync } from "node:child_process";
import { subscribe } from "node:diagnostics_channel";
import fs from "node:fs";

export default function installPauseAfterAcknowledgementProbe(receiptPath) {
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const deadlines = new Map();
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 60000) {
      return schedule(callback, delay, ...args);
    }
    const invoke = () => callback(...args);
    const timer = schedule(() => {
      deadlines.delete(timer);
      invoke();
    }, delay);
    deadlines.set(timer, invoke);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    deadlines.delete(timer);
    return cancel(timer);
  };
  const isVitestFork = (arg) =>
    typeof arg === "string" && arg.replaceAll("\\", "/").endsWith("/vitest/dist/workers/forks.js");
  if (isVitestFork(process.argv[1]) && process.send) {
    const send = process.send.bind(process);
    process.send = function (message, ...args) {
      if (
        message?.["__vitest_worker_response__"] === true &&
        message.type === "stopped" &&
        message.willExit === true
      ) {
        const callbackIndex = args.length - 1;
        const callback = args[callbackIndex];
        args[callbackIndex] = function (...callbackArgs) {
          // The patched transport exits in this callback. Stop after its response
          // flushes, before that exit can race the parent's message observation.
          if (!callbackArgs[0]) {
            process.kill(process.pid, "SIGSTOP");
          }
          return callback.apply(this, callbackArgs);
        };
      }
      return send(message, ...args);
    };
  }
  subscribe("child_process", ({ process: child }) => {
    let selected = false;
    let acknowledged = false;
    let poll;
    const deadline = { delay: 60000, liveTimers: 0, stopped: false, advanced: 0, error: null };
    child.once("spawn", () => {
      selected = child.spawnargs.some(isVitestFork);
    });
    child.on("message", (message) => {
      if (
        !selected ||
        message?.["__vitest_worker_response__"] !== true ||
        message.type !== "stopped" ||
        message.willExit !== true
      ) {
        return;
      }
      acknowledged = true;
      // Let Vitest consume the acknowledgement before observing the child stopped in send's callback.
      setImmediate(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        poll = setInterval(() => {
          try {
            const state = execFileSync("ps", ["-o", "stat=", "-p", String(child.pid)], {
              encoding: "utf8",
              timeout: 1000,
              maxBuffer: 1024,
            }).trim();
            if (!state.startsWith("T")) {
              return;
            }
            clearInterval(poll);
            deadline.stopped = true;
            deadline.liveTimers = deadlines.size;
            if (deadlines.size !== 1) {
              deadline.error = "expected one live stop deadline";
              return;
            }
            const [timer, invoke] = deadlines.entries().next().value;
            cancel(timer);
            deadlines.delete(timer);
            deadline.advanced++;
            invoke();
          } catch (error) {
            clearInterval(poll);
            deadline.error = String(error);
          }
        }, 5);
        poll.unref();
      });
    });
    child.once("exit", (code, signal) => {
      clearInterval(poll);
      if (selected) {
        fs.writeFileSync(receiptPath, JSON.stringify({ acknowledged, code, signal, deadline }));
      }
    });
  });
}
