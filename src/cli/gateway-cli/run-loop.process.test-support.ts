import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";

export function createProcessFixture() {
  const stops: Array<() => Promise<unknown>> = [];
  const dirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      await Promise.all(stops.splice(0).map((stop) => stop()));
      cleanup();
    }),
  );
  return {
    make: (prefix: string) => dirs.make(prefix),
    start(
      fixture: Parameters<typeof resolveRuntimeWorkerUrl>[0],
      root: string,
      mode: string,
      signal: AbortSignal,
      env: NodeJS.ProcessEnv = {},
      ipc = false,
    ) {
      const home = path.join(root, "home");
      fs.mkdirSync(home);
      const child = spawn(
        process.execPath,
        [...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(fixture)), root, mode],
        {
          env: {
            PATH: process.env.PATH,
            HOME: home,
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
            NODE_DISABLE_COMPILE_CACHE: "1",
            ...env,
          },
          stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
        },
      );
      const observed = observeChild(child, signal);
      const stop = async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await observed.closed;
      };
      stops.push(stop);
      return { child, observed, stop };
    },
  };
}

function observeChild(child: ChildProcess, signal: AbortSignal) {
  const closed = once(child, "close");
  void closed.catch(() => {});
  let output = "";
  const changes = new EventEmitter();
  const record = (chunk: Buffer) => {
    output += chunk.toString();
    changes.emit("output");
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  return {
    closed,
    get output() {
      return output;
    },
    waitForOutput: async (text: string) => {
      const waiting = new AbortController();
      try {
        while (!output.includes(text)) {
          await awaitGateBeforeSettlement(
            once(changes, "output", { signal: AbortSignal.any([signal, waiting.signal]) }),
            closed,
            `Missing ${text}`,
          );
        }
      } catch (cause) {
        throw new Error(`Missing ${text}: ${output}`, { cause });
      } finally {
        waiting.abort();
      }
    },
  };
}
