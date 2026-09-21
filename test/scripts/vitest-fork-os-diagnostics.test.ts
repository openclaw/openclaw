import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { collectVitestForkOsDiagnostics } from "../../scripts/lib/vitest-fork-os-diagnostics.mts";
import {
  createVitestProcessCompletion,
  forceKillVitestProcessGroup,
} from "../../scripts/vitest-process-group.mts";
import { withTestTimeout } from "../helpers/promise.js";

describe.skipIf(process.platform !== "linux")("fork OS diagnostics", () => {
  it("observes a blocked event loop, native threads, and child ancestry without private fields", async () => {
    const fixture = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import { spawn } from 'node:child_process';
          import { once } from 'node:events';
          import { Worker } from 'node:worker_threads';
          process.title = 'PRIVATE_PROCESS_NAME';
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'PRIVATE_ARG'], { stdio: 'ignore' });
          await once(child, 'spawn');
          const worker = new Worker('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)', { eval: true, name: 'PRIVATE_THREAD_NAME' });
          await once(worker, 'online');
          process.stdout.write(String(child.pid) + '\\n', () => {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          });
        `,
      ],
      {
        detached: true,
        env: { PRIVATE_ENV: "PRIVATE_ENV_VALUE" },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const completion = createVitestProcessCompletion({ child: fixture, detached: true });
    try {
      const [ready] = await withTestTimeout(
        Promise.race([
          once(fixture.stdout, "data"),
          completion.then(() => {
            throw new Error("diagnostic fixture exited before readiness");
          }),
        ]),
        5_000,
        "diagnostic fixture did not become ready",
      );
      const descendant = Number(String(ready).trim());
      expect(descendant).toBeGreaterThan(0);
      const result = await collectVitestForkOsDiagnostics(fixture.pid!);
      expect(result).toContain(`ancestry pid=${fixture.pid} ppid=${process.pid}`);
      expect(result).toContain(`process pid=${descendant} ppid=${fixture.pid}`);
      expect(result).toMatch(
        new RegExp(`thread pid=${fixture.pid} tid=${fixture.pid} state=S wchan=\\w*futex\\w*`),
      );
      expect(result).toMatch(/SigPnd=[0-9a-f]+ .*SigBlk=[0-9a-f]+/u);
      expect(result).toContain("stack=");
      expect(result).not.toMatch(/PRIVATE_|\/proc\/|\/Users\/|\/home\//u);
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(16 * 1024);
    } finally {
      forceKillVitestProcessGroup(fixture);
      await completion;
    }
  });
});
