import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  exitAfterSignalExitBarriers,
  registerSignalExitBarrier,
  registerSignalExitGate,
  waitForCliSignalExit,
} from "./signal-exit-barrier.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { owner: "mutation", code: 0, failed: true, expected: 1 },
  { owner: "recovery", code: "0", failed: true, expected: 1 },
  { owner: "recovery", code: 7, failed: true, expected: 7 },
  { owner: "mutation", code: 7, failed: false, expected: 7 },
])(
  "preserves exit $expected while $owner drains (failed: $failed)",
  async ({ owner, code, failed, expected }) => {
    const drain = createDeferredCore();
    const unregister =
      owner === "mutation"
        ? registerSignalExitGate(drain.promise)
        : registerSignalExitBarrier(() => drain.promise);
    const exited = new Error("Process exited");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw exited;
    });
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      exitAfterSignalExitBarriers(code);
      exitAfterSignalExitBarriers(0);
      expect(exit).not.toHaveBeenCalled();
      const finished = expect(waitForCliSignalExit()).rejects.toBe(exited);
      if (failed) {
        drain.reject(new Error("Maintenance failed"));
      } else {
        drain.resolve();
      }
      await finished;
      expect(exit).toHaveBeenCalledExactlyOnceWith(expected);
    } finally {
      unregister();
      exit.mockRestore();
      process.exitCode = previousExitCode;
    }
  },
);

it.skipIf(process.platform === "win32").each(["owner", "once-owner", "execa"])(
  "preserves the existing %s signal lifecycle",
  (kind) => {
    const root = directories.make("cli-signal-owner-");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        `import { once } from 'node:events';
         import { installCliSignalExitHandlers } from ${JSON.stringify(new URL("./signal-exit-barrier.ts", import.meta.url).href)};
         installCliSignalExitHandlers();
         if (${JSON.stringify(kind)} === 'execa') {
           const { execa } = await import('execa');
           const child = execa(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
           await once(child.nodeChildProcess, 'spawn');
         } else {
           process[${JSON.stringify(kind === "once-owner" ? "once" : "on")}]('SIGTERM', () => {
             setImmediate(() => { process.stdout.write('owner drained'); process.exit(23); });
           });
         }
         process.kill(process.pid, 'SIGTERM');
         setTimeout(() => process.exit(99), 5000);`,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root, XDG_CACHE_HOME: root },
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    if (kind === "execa") {
      expect(result.signal, result.stderr).toBe("SIGTERM");
    } else {
      expect(result.status, result.stderr).toBe(23);
      expect(result.stdout).toBe("owner drained");
    }
  },
);
