import { spawnSync } from "node:child_process";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { holdDoctorMaintenanceExit } from "../commands/doctor-maintenance-exit.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createNodeEvalArgs } from "../test-utils/node-process.js";
import {
  exitAfterSignalExitBarriers,
  registerSignalExitBarrier,
  registerSignalExitGate,
  registerSignalExitOwner,
  waitForCliSignalExit,
  waitForSignalExitBarriers,
} from "./signal-exit-barrier.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

function exitProbe() {
  const previousExitCode = process.exitCode;
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("Process exited");
  });
  onTestFinished(() => {
    exit.mockRestore();
    process.exitCode = previousExitCode;
  });
  return exit;
}

function ownExit(owner: Parameters<typeof registerSignalExitOwner>[0]) {
  const release = registerSignalExitOwner(owner);
  onTestFinished(release);
  return release;
}

it("retains an exclusive process exit owner until its exact release", async () => {
  const exit = exitProbe();
  const owner = vi.fn();
  const other = vi.fn();
  const release = ownExit(owner);
  expect(() => registerSignalExitOwner(other)).toThrow("already registered");
  exitAfterSignalExitBarriers(7, "unhandled rejection");
  expect(owner).toHaveBeenCalledExactlyOnceWith(7, "unhandled rejection");
  expect(other).not.toHaveBeenCalled();
  release();
  const releaseOther = ownExit(other);
  release();
  exitAfterSignalExitBarriers(9);
  expect(other).toHaveBeenCalledExactlyOnceWith(9, undefined);
  releaseOther();
  const releaseSame = ownExit(owner);
  release();
  exitAfterSignalExitBarriers(11);
  expect(owner).toHaveBeenLastCalledWith(11, undefined);
  releaseSame();
  exitAfterSignalExitBarriers(0);
  await expect(waitForCliSignalExit()).resolves.toBe(0);
  expect(process.exitCode).toBe(0);
  expect(exit).not.toHaveBeenCalled();
});

it("keeps the first stop cause while a later signal retains its exit status", async () => {
  exitProbe();
  const finished = createDeferredCore();
  const interrupt = vi.fn();
  const release = registerSignalExitGate(finished.promise, interrupt);
  const report = vi.fn();
  const doctor = holdDoctorMaintenanceExit(report);
  try {
    exitAfterSignalExitBarriers(0, "unhandled rejection");
    const draining = waitForSignalExitBarriers("SIGTERM");
    exitAfterSignalExitBarriers(7, "uncaught exception");
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(undefined, "unhandled rejection");
    expect(doctor.signal.reason.message).toBe(
      "Doctor interrupted by unhandled rejection; cancelling inspections and settling admitted repairs before exit.",
    );
    expect(report).toHaveBeenCalledExactlyOnceWith(doctor.signal.reason.message);
    doctor.release();
    finished.resolve();
    await draining;
    await expect(waitForCliSignalExit()).resolves.toBe(143);
  } finally {
    doctor.release();
    finished.resolve();
    release();
    await waitForCliSignalExit();
  }
});

it.each([
  { owner: "mutation", code: 0, failed: true, expected: 1 },
  { owner: "recovery", code: "0", failed: true, expected: 1 },
  { owner: "recovery", code: 7, failed: true, expected: 7 },
  { owner: "mutation", code: 7, failed: false, expected: 7 },
])(
  "preserves exit $expected while $owner drains (failed: $failed)",
  async ({ owner, code, failed, expected }) => {
    const drain = createDeferredCore();
    const exit = exitProbe();
    onTestFinished(
      owner === "mutation"
        ? registerSignalExitGate(drain.promise)
        : registerSignalExitBarrier(() => drain.promise),
    );
    process.exitCode = 0;
    exitAfterSignalExitBarriers(code);
    exitAfterSignalExitBarriers(0);
    const finished = expect(waitForCliSignalExit()).resolves.toBe(expected);
    if (failed) {
      drain.reject(new Error("Maintenance failed"));
    } else {
      drain.resolve();
    }
    await finished;
    expect(process.exitCode).toBe(expected);
    expect(exit).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform === "win32").each([
  { kind: "owner", signal: "SIGTERM" },
  { kind: "once-owner", signal: "SIGTERM" },
  { kind: "execa", signal: "SIGTERM" },
  { kind: "fallback", signal: "SIGINT" },
  { kind: "fallback", signal: "SIGTERM" },
])("preserves the $kind signal lifecycle ($signal)", ({ kind, signal }) => {
  const root = directories.make("cli-signal-owner-");
  const result = spawnSync(
    process.execPath,
    createNodeEvalArgs(
      `import { once } from 'node:events';
         import { installCliSignalExitHandlers, registerSignalExitBarrier } from ${JSON.stringify(new URL("./signal-exit-barrier.ts", import.meta.url).href)};
         const releaseSignals = installCliSignalExitHandlers();
         if (${JSON.stringify(kind)} === 'fallback') {
           installCliSignalExitHandlers();
           releaseSignals();
           releaseSignals();
         }
         const backstop = setTimeout(() => process.exit(99), 5000);
         registerSignalExitBarrier(async () => { clearTimeout(backstop); });
         process.once("beforeExit", () => {
           if (${JSON.stringify(kind)} === "fallback") process.stdout.write("|natural");
         });
         if (${JSON.stringify(kind)} === 'execa') {
           const { execa } = await import('execa');
           const child = execa(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
           await once(child.nodeChildProcess, 'spawn');
         } else if (${JSON.stringify(kind)} === 'fallback') {
           registerSignalExitBarrier(async () => {
             await Promise.resolve();
             process.stderr.write('fallback cleanup');
             process.stdout.write('fallback drained');
           });
         } else {
           process[${JSON.stringify(kind === "once-owner" ? "once" : "on")}]('SIGTERM', () => {
             setImmediate(() => { process.stdout.write('owner drained'); process.exit(23); });
           });
         }
         process.kill(process.pid, ${JSON.stringify(signal)});`,
      { imports: [import.meta.resolve("tsx")], evalFlag: "-e" },
    ),
    {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root, XDG_CACHE_HOME: root },
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  if (kind === "execa") {
    expect(result.signal, result.stderr).toBe("SIGTERM");
    expect(result.stderr).toBe("");
  } else if (kind === "fallback") {
    expect(result, result.stderr).toMatchObject({
      status: signal === "SIGINT" ? 130 : 143,
      stdout: "fallback drained|natural",
      stderr: `Command interrupted by ${signal}. Waiting for cleanup before exiting.\nfallback cleanup`,
    });
  } else {
    expect(result, result.stderr).toMatchObject({
      status: 23,
      stdout: "owner drained",
      stderr: "",
    });
  }
});
