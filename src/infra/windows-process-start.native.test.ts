import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { getWindowsPowerShellExePath } from "./windows-install-roots.js";

it("keeps the PID identity source closure loadable by native Node without a workspace resolver", () => {
  const source = new URL("../shared/pid-alive.ts", import.meta.url).href;
  const stdout = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const module = await import(${JSON.stringify(source)}); console.log(typeof module.getFileLockProcessStartTime);`,
    ],
    { env: {}, encoding: "utf8", timeout: 5000 },
  );
  expect(stdout.trim()).toBe("function");
});

it.skipIf(process.platform !== "win32")(
  "reads the same kernel creation timestamp without a shell after native source import",
  () => {
    const source = new URL("./windows-process-start.ts", import.meta.url).href;
    const stdout = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import childProcess from "node:child_process";
          import { Worker } from "node:worker_threads";
          import { once } from "node:events";
          import { syncBuiltinESMExports } from "node:module";
          const powershell = ${JSON.stringify(getWindowsPowerShellExePath())};
          const expected = Date.parse(childProcess.execFileSync(powershell, [
            "-NoProfile", "-NonInteractive", "-Command",
            "$p = [System.Diagnostics.Process]::GetProcessById(" + process.pid + "); try { [Console]::Out.Write($p.StartTime.ToUniversalTime().ToString('o')) } finally { $p.Dispose() }"
          ], { encoding: "utf8", timeout: 5000, windowsHide: true }));
          childProcess.spawnSync = () => { throw new Error("unexpected shell fallback"); };
          syncBuiltinESMExports();
          const { readWindowsProcessStartTimeSync } = await import(${JSON.stringify(source)});
          const actual = readWindowsProcessStartTimeSync(process.pid);
          if (!Number.isFinite(expected) || actual !== expected) {
            throw new Error("native creation timestamp differs from the kernel shell query");
          }
          const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(
            'import { parentPort, workerData } from "node:worker_threads"; ' +
            'import childProcess from "node:child_process"; import { syncBuiltinESMExports } from "node:module"; ' +
            'childProcess.spawnSync = () => { throw new Error("unexpected Worker shell fallback"); }; syncBuiltinESMExports(); ' +
            'import { readWindowsProcessStartTimeSync } from ' + ${JSON.stringify(JSON.stringify(source))} + '; ' +
            'parentPort.postMessage(readWindowsProcessStartTimeSync(workerData));'
          )), { workerData: process.pid });
          try {
            const [workerTime] = await once(worker, "message");
            if (workerTime !== expected) throw new Error("Worker timestamp differs from kernel query");
          } finally { await worker.terminate(); }
          console.log("native identity matches");
        `,
      ],
      { env: {}, encoding: "utf8", timeout: 10000 },
    );
    expect(stdout.trim()).toBe("native identity matches");
  },
);
