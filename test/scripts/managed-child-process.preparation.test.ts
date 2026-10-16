import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { hasErrnoCode } from "../../src/infra/errno.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

it.skipIf(process.platform === "win32")(
  "joins an implementation-owned shim and synchronous preparation on outer SIGINT",
  async ({ signal }) => {
    await fixture.run(async () => {
      const cwd = fixture.createTempDir("managed-preparation-cancellation-");
      const supervisorPath = path.join(cwd, "supervisor.mjs");
      const shimPath = path.join(cwd, "shim.mjs");
      const implementationPath = path.join(cwd, "implementation.mjs");
      const preparationPath = path.join(cwd, "preparation.mjs");
      const reportPath = path.join(cwd, "result.json");
      const pidPaths = ["shim", "implementation", "preparation"].map((role) =>
        path.join(cwd, `${role}.pid`),
      );
      const ready = createDeferred();

      fs.writeFileSync(
        preparationPath,
        `import fs from "node:fs";
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});
fs.writeFileSync(${JSON.stringify(pidPaths[2])}, String(process.pid));
fs.writeSync(1, "preparation-ready\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`,
      );
      fs.writeFileSync(
        implementationPath,
        `import { spawnSync } from "node:child_process";
import fs from "node:fs";
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});
fs.writeFileSync(${JSON.stringify(pidPaths[1])}, String(process.pid));
spawnSync(process.execPath, [${JSON.stringify(preparationPath)}], { stdio: "inherit" });
`,
      );
      fs.writeFileSync(
        shimPath,
        `import fs from "node:fs";
import { runNodeCliShim } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/tsx-cli-shim.mjs")).href)};
fs.writeFileSync(${JSON.stringify(pidPaths[0])}, String(process.pid));
await runNodeCliShim(import.meta.url, {
  implementation: "./implementation.mjs",
  terminationOwner: "implementation",
});
`,
      );
      fs.writeFileSync(
        supervisorPath,
        `import fs from "node:fs";
import { runManagedCommand } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href)};
let report;
try {
  report = { status: await runManagedCommand({
    bin: process.execPath,
    args: [${JSON.stringify(shimPath)}],
    stdio: "inherit",
    // The enclosing fixture independently joins exact PIDs even on baseline failure.
    env: { ...process.env, TMPDIR: ${JSON.stringify(process.cwd())}, TMP: ${JSON.stringify(process.cwd())}, TEMP: ${JSON.stringify(process.cwd())} },
  }) };
} catch (error) {
  report = { error: { code: error.code, message: error.message, processTreeState: error.processTreeState } };
}
fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(report));
process.exitCode = report.status ?? 1;
`,
      );

      let supervisor: ChildProcess | undefined;
      const completion = fixture.track(
        runNodeScript(supervisorPath, process.env, undefined, {
          cwd,
          maxBuffer: 64 * 1024,
          onReady(child, readOutput) {
            supervisor = child;
            child.stdout!.on("data", () => {
              if (readOutput().stdout.includes("preparation-ready\n")) {
                ready.resolve();
              }
            });
          },
        }),
      );
      const readOwnedPid = (pidPath: string) => {
        if (!fs.existsSync(pidPath)) {
          return [];
        }
        const pid = Number(fs.readFileSync(pidPath, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 1) {
          throw new Error(`Invalid fixture PID in ${pidPath}`);
        }
        return [pid];
      };
      const readOwnedPids = () => pidPaths.flatMap(readOwnedPid);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            ready.promise,
            completion,
            "synchronous preparation did not become ready",
          ),
          signal,
        );
        expect(readOwnedPids()).toHaveLength(3);
        expect(supervisor?.kill("SIGINT")).toBe(true);
        const result = await withinTest(completion, signal);
        const report = fs.readFileSync(reportPath, "utf8");
        expect(result.error, `${result.stderr}\n${report}`).toBeUndefined();
        expect.soft(JSON.parse(report)).toEqual({ status: 130 });
        expect.soft(result.status, result.stderr).toBe(130);
        // Observe extinction before fallback teardown can conceal an orphaned owner.
        expect.soft(readOwnedPids().filter(isProcessAlive)).toEqual([]);
      } finally {
        await fixture.verifyCleanup(async () => {
          // Stop each recorded producer before reading the next producer's PID record.
          // The baseline can lose its shim while its detached implementation survives.
          const cleanupSignal = AbortSignal.timeout(5_000);
          const failures: unknown[] = [];
          const stop = async (pid: number) => {
            try {
              if (isProcessAlive(pid)) {
                process.kill(pid, "SIGKILL");
              }
            } catch (error) {
              if (!hasErrnoCode(error, "ESRCH")) {
                failures.push(error);
              }
            }
            try {
              // Test cancellation must not prevent independent fallback cleanup.
              await waitForDead(pid, cleanupSignal);
            } catch (error) {
              failures.push(error);
            }
          };
          if (supervisor?.pid) {
            await stop(supervisor.pid);
          }
          for (const pidPath of pidPaths) {
            for (const pid of readOwnedPid(pidPath)) {
              await stop(pid);
            }
          }
          await completion;
          if (failures.length) {
            throw new AggregateError(failures, "Preparation fixture cleanup failed");
          }
        });
      }
    });
  },
);
