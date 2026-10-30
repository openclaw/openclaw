// Process-boundary proof that the hard-exit watchdog survives main-thread starvation.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const WATCHDOG_DELAY_MS = 100;
const CHILD_TIMEOUT_MS = 3_000;
const watchdogModuleUrl = pathToFileURL(
  path.resolve("src/cli/gateway-cli/shutdown-hard-exit.ts"),
).href;

function runWatchdogChild() {
  const delayedBootstrap = (delayMs: number) => `
    import { isMainThread } from "node:worker_threads";
    import { writeSync } from "node:fs";
    if (!isMainThread) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayMs});
      writeSync(1, "worker-bootstrap-finished:${delayMs}:" + Date.now() + "\\n");
    }
  `;
  const script = `
    import { writeSync } from "node:fs";
    import { armShutdownHardExitWatchdog } from ${JSON.stringify(watchdogModuleUrl)};

    const fail = (message) => {
      writeSync(2, \`error:\${message}\\n\`);
      process.exit(2);
    };
    process.env.NODE_OPTIONS = ${JSON.stringify(`--import=data:text/javascript,${encodeURIComponent(delayedBootstrap(500))}`)};
    const hold = setInterval(() => {}, 1_000);
    const firstWatchdog = armShutdownHardExitWatchdog({
      delayMs: ${WATCHDOG_DELAY_MS},
      onError: (error) => fail(String(error)),
    });
    await firstWatchdog.cancel();
    clearInterval(hold);
    await new Promise((resolve) => setTimeout(resolve, ${WATCHDOG_DELAY_MS * 2}));
    writeSync(1, "cancelled-watchdog-deadline-survived\\n");

    process.once("beforeExit", () => {
      // Reaching beforeExit proves the cancelled worker no longer retains process liveness.
      writeSync(1, "cancelled-watchdog-released-liveness\\n");
      process.env.NODE_OPTIONS = ${JSON.stringify(`--import=data:text/javascript,${encodeURIComponent(delayedBootstrap(1_000))}`)};
      armShutdownHardExitWatchdog({
        delayMs: 1_000,
        onError: (error) => fail(String(error)),
      });
      writeSync(1, "second-watchdog-armed\\n");
      while (true) {}
    });
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: { ...process.env, VITEST: undefined },
      killSignal: "SIGKILL",
      timeout: CHILD_TIMEOUT_MS,
    },
  );
  return { finishedAt: Date.now(), result };
}

it("cancels one watchdog and counts worker bootstrap toward the blocked-main deadline", () => {
  const { finishedAt, result } = runWatchdogChild();
  const diagnostics = JSON.stringify(result);
  expect(result.stdout, diagnostics).toMatch(
    /cancelled-watchdog-deadline-survived\ncancelled-watchdog-released-liveness\nsecond-watchdog-armed\nworker-bootstrap-finished:1000:/,
  );

  expect(result.error, diagnostics).toBeUndefined();
  expect(result.status, diagnostics).toBeNull();
  expect(result.signal, diagnostics).toBe("SIGKILL");
  const bootstrapFinished = Number(
    result.stdout.match(/worker-bootstrap-finished:1000:(\d+)/)?.[1],
  );
  expect(finishedAt - bootstrapFinished, diagnostics).toBeLessThan(500);
});
