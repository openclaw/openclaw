// Process-boundary proof that the hard-exit watchdog survives main-thread starvation.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const watchdogModuleUrl = pathToFileURL(
  path.resolve("src/cli/gateway-cli/shutdown-hard-exit.ts"),
).href;

function runWatchdogChild(blockMain: boolean) {
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
      delayMs: 100,
      onError: (error) => fail(String(error)),
    });
    await firstWatchdog.cancel();
    clearInterval(hold);
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeSync(1, "cancelled-watchdog-deadline-survived\\n");

    process.once("beforeExit", () => {
      // Reaching beforeExit proves the cancelled worker no longer retains process liveness.
      writeSync(1, "cancelled-watchdog-released-liveness\\n");
      process.env.NODE_OPTIONS = ${JSON.stringify(`--import=data:text/javascript,${encodeURIComponent(delayedBootstrap(blockMain ? 1_000 : 5_000))}`)};
      armShutdownHardExitWatchdog({
        delayMs: 1_000,
        describePending: () => "shutdown.sidecar.database-admission",
        onError: (error) => fail(String(error)),
      });
      writeSync(1, "second-watchdog-armed\\n");
      ${blockMain ? "while (true) {}" : "setInterval(() => {}, 1_000);"}
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
      timeout: 3_000,
    },
  );
  return { finishedAt: Date.now(), result };
}

it.each([true, false])("bounds retained cleanup with blocked main=%s", (blockMain) => {
  const { finishedAt, result } = runWatchdogChild(blockMain);
  const diagnostics = JSON.stringify(result);
  expect(result.stdout, diagnostics).toContain(
    "cancelled-watchdog-deadline-survived\ncancelled-watchdog-released-liveness\nsecond-watchdog-armed\n",
  );
  expect(result.stderr, diagnostics).toContain(
    "pending close steps: shutdown.sidecar.database-admission; forcing SIGKILL",
  );
  expect(result.error, diagnostics).toBeUndefined();
  expect(result.status, diagnostics).toBeNull();
  expect(result.signal, diagnostics).toBe("SIGKILL");
  if (blockMain) {
    const bootstrapFinished = Number(
      result.stdout.match(/worker-bootstrap-finished:1000:(\d+)/)?.[1],
    );
    expect(bootstrapFinished, diagnostics).toBeGreaterThan(0);
    expect(finishedAt - bootstrapFinished, diagnostics).toBeLessThan(500);
  } else {
    expect(result.stdout, diagnostics).not.toContain("worker-bootstrap-finished:5000:");
  }
});
