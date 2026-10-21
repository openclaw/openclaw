import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { killPidIfAlive } from "../../src/test-utils/process-tree.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive, waitForDead, waitForFixtureFile } from "../helpers/process-wait.js";
import { withinTest } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

it.skipIf(process.platform === "win32")(
  "joins an implementation-owned shim and synchronous preparation on outer SIGINT",
  ({ signal }) =>
    fixture.run(async () => {
      const cwd = fixture.createTempDir("managed-preparation-cancellation-");
      const file = (role: string, extension = "mjs") => path.join(cwd, `${role}.${extension}`);
      const reportPath = file("result", "json");
      const pidPaths = ["shim", "implementation", "preparation"].map((role) => file(role, "pid"));
      const programs = {
        preparation: "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n",
        implementation: `import { spawnSync } from "node:child_process";
spawnSync(process.execPath, [${JSON.stringify(file("preparation"))}], { stdio: "inherit" });
`,
        shim: `import { runNodeCliShim } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/tsx-cli-shim.mjs")).href)};
await runNodeCliShim(import.meta.url, {
  implementation: "./implementation.mjs",
  terminationOwner: "implementation",
});
`,
        supervisor: `import { runManagedCommand } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href)};
let report;
try {
  report = { status: await runManagedCommand({
    bin: process.execPath,
    args: [${JSON.stringify(file("shim"))}],
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
      };
      for (const [role, body] of Object.entries(programs)) {
        const handlers = ["implementation", "preparation"].includes(role)
          ? 'for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});\n'
          : "";
        const pidRecord =
          role === "supervisor"
            ? ""
            : `fs.writeFileSync(${JSON.stringify(file(role, "pid"))}, String(process.pid));\n`;
        fs.writeFileSync(file(role), `import fs from "node:fs";\n${handlers}${pidRecord}${body}`);
      }

      let supervisor: ChildProcess | undefined;
      const completion = fixture.track(
        runNodeScript(file("supervisor"), process.env, undefined, {
          cwd,
          maxBuffer: 64 * 1024,
          onReady(child) {
            supervisor = child;
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
        await withinTest(waitForFixtureFile(file("preparation", "pid"), completion), signal);
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
            // Test cancellation must not prevent independent fallback cleanup.
            for (const work of [() => killPidIfAlive(pid), () => waitForDead(pid, cleanupSignal)]) {
              await Promise.resolve()
                .then(work)
                .catch((error: unknown) => {
                  failures.push(error);
                });
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
    }),
);
