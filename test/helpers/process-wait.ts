import fs, { existsSync, readFileSync } from "node:fs";
import { isPidAlive } from "../../src/shared/pid-alive.js";

export { isPidAlive as isProcessAlive };

type AbortEventPolicy = "recheck" | "reject";

function waitForObservation<T>(
  observe: () => T | undefined,
  signal: AbortSignal,
  diagnostic: string,
  delay?: (ms: number) => Promise<unknown>,
  abortEventPolicy: AbortEventPolicy = "recheck",
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(diagnostic, { cause: error }));
    };
    const abort = () => fail(new Error(diagnostic, { cause: signal.reason }));
    function check() {
      if (settled) {
        return;
      }
      try {
        // A producer can finish before an aborted worker wakes. Observe once more first.
        const value = observe();
        if (value !== undefined) {
          cleanup();
          resolve(value);
        } else if (signal.aborted) {
          abort();
        } else if (delay) {
          // The injected delay owns its timer; its late completion cannot restart polling.
          void delay(5).then(check, fail);
        } else {
          timer = setTimeout(check, 5);
        }
      } catch (error) {
        fail(error);
      }
    }
    const onAbort = abortEventPolicy === "reject" ? abort : check;
    signal.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

export async function waitForFile(filePath: string, signal: AbortSignal): Promise<void> {
  await waitForObservation(
    () => (existsSync(filePath) ? true : undefined),
    signal,
    `aborted waiting for ${filePath}`,
  );
}

// writeFileSync can expose an open-truncate window, so wait for valid contents, not existence.
// Inject a real delay when the caller controls execution deadlines with fake timers.
export function waitForPidFile(
  filePath: string,
  signal: AbortSignal,
  delay?: (ms: number) => Promise<unknown>,
): Promise<number> {
  return waitForObservation(
    () => {
      if (existsSync(filePath)) {
        const pid = Number.parseInt(readFileSync(filePath, "utf8"), 10);
        if (Number.isInteger(pid) && pid > 0) {
          return pid;
        }
      }
      return undefined;
    },
    signal,
    `aborted waiting for pid in ${filePath}`,
    delay,
  );
}

// An already-aborted signal still gets the initial observation. "reject" skips
// only an abort event's final observation for foreign-process cleanup.
export async function waitForDead(
  pid: number,
  signal: AbortSignal,
  abortEventPolicy: AbortEventPolicy = "recheck",
): Promise<void> {
  await waitForObservation(
    () => (!isPidAlive(pid) ? true : undefined),
    signal,
    `process still alive: ${pid}`,
    undefined,
    abortEventPolicy,
  );
}

export function waitForFixtureFile(
  filename: string,
  completion: Promise<unknown>,
  expected?: string,
) {
  return new Promise<void>((resolve, reject) => {
    const matches = () =>
      fs.existsSync(filename) &&
      fs.statSync(filename).size > 0 &&
      (expected === undefined || fs.readFileSync(filename, "utf8") === expected);
    const check = () => {
      if (matches()) {
        clearInterval(poll);
        resolve();
      }
    };
    // watchFile can adopt a newly created receipt in its first stat without an event.
    // Poll the persistent state itself so readiness never depends on that race.
    const poll = setInterval(check, 50);
    void completion.then(
      () => {
        clearInterval(poll);
        if (matches()) {
          resolve();
        } else {
          reject(new Error(`Child exited before writing ${filename}`));
        }
      },
      (error: unknown) => {
        clearInterval(poll);
        reject(new Error(`Child failed before writing ${filename}`, { cause: error }));
      },
    );
    check();
  });
}
