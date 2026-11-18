import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import {
  getFileLockProcessStartTime,
  getProcessInstanceStartTime,
  isPidAlive,
  isPidDefinitelyDead,
} from "./pid-alive.js";

// The shell timestamp is independent of the native package and is the released lock format.
it.skipIf(process.platform !== "darwin")(
  "keeps Darwin lock seconds and custody microseconds on the main thread and a real Worker",
  async () => {
    const expectedSeconds = Math.floor(
      Date.parse(
        `${execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
        }).trim()} UTC`,
      ) / 1000,
    );
    const source = new URL("./pid-alive.ts", import.meta.url).href;
    const worker = new Worker(
      new URL(
        `data:text/javascript,${encodeURIComponent(`
      import { parentPort } from 'node:worker_threads';
      import { getFileLockProcessStartTime, getProcessInstanceStartTime,
        isPidAlive, isPidDefinitelyDead } from ${JSON.stringify(source)};
      parentPort.postMessage({
        lock: getFileLockProcessStartTime(process.pid),
        custody: getProcessInstanceStartTime(process.pid),
        alive: isPidAlive(process.pid), dead: isPidDefinitelyDead(process.pid),
      });
    `)}`,
      ),
    );
    try {
      const [actual] = await once(worker, "message");
      expect(actual).toEqual({
        lock: expectedSeconds,
        custody: getProcessInstanceStartTime(process.pid),
        alive: true,
        dead: false,
      });
      expect(getFileLockProcessStartTime(process.pid)).toBe(expectedSeconds);
      expect(Math.floor(actual.custody / 1_000_000)).toBe(expectedSeconds);
      expect(Number.isSafeInteger(actual.custody)).toBe(true);
      expect(isPidAlive(process.pid)).toBe(true);
      expect(isPidDefinitelyDead(process.pid)).toBe(false);
    } finally {
      await worker.terminate();
    }
  },
);
