import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runWarmReloadCli } from "../../scripts/perf/warm-reload-lifecycle.ts";
import { killPidIfAlive } from "../../src/test-utils/process-tree.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive, waitForDead, waitForFixtureFile } from "../helpers/process-wait.js";
import { createDeferred, withinTest } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

const lifecycle = pathToFileURL(path.resolve("scripts/perf/warm-reload-lifecycle.ts")).href;
const cancelable = pathToFileURL(path.resolve("scripts/lib/cancelable-command.mts")).href;
const managed = pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href;

it("closes failed spawn handles and refuses admission after cancellation or closure", async ({
  signal,
}) => {
  const result = await runNodeScript(
    [
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWarmReloadGatewayOwner } from ${JSON.stringify(lifecycle)};
await assert.rejects(createWarmReloadGatewayOwner(AbortSignal.abort()), { name: "AbortError" });
const owner = await createWarmReloadGatewayOwner(new AbortController().signal);
const child = owner.start(() => spawn("missing-warm-reload-fixture-executable", [], {
  stdio: ["ignore", "pipe", "pipe"],
}));
let spawnError;
child.on("error", error => { spawnError = error; });
await Promise.all([owner.close(), owner.close()]);
assert.equal(spawnError.code, "ENOENT");
assert.equal(owner.joined(), true);
assert.throws(() => owner.start(() => { throw new Error("must not spawn"); }), /admission is closed/);
console.log("spawn handles closed");`,
    ],
    process.env,
    10_000,
    { signal, maxBuffer: 64 * 1024 },
  );
  expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
  expect(result.stdout).toBe("spawn handles closed\n");
});

describe.skipIf(process.platform === "win32")("detached warm reload processes", () => {
  it(
    "holds its parent through delayed Gateway cleanup and preserves the first interrupt",
    ({ signal }) =>
      fixture.run(async () => {
        const cwd = fixture.createTempDir("warm-reload-owner-");
        const ready = path.join(cwd, "gateway-pid");
        const stopped = path.join(cwd, "gateway-stopped");
        // This must cross the outer runner's real five-second kill boundary;
        // fake timers cannot prove ownership across OS processes.
        const gatewayScript = `const fs = require("node:fs");
process.once("SIGTERM", () => {
  console.log("stopping");
  setTimeout(() => {
    fs.writeFileSync(${JSON.stringify(stopped)}, "closed");
    process.exit(0);
  }, 6000);
});
setInterval(() => {}, 1000);
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`;
        const script = `import assert from "node:assert/strict";
import { createWarmReloadGatewayOwner } from ${JSON.stringify(lifecycle)};
import { runCancelableCommand } from ${JSON.stringify(cancelable)};
import { loadManagedChildSpawner } from ${JSON.stringify(managed)};
const status = await runCancelableCommand(async signal => {
  const owner = await createWarmReloadGatewayOwner(signal);
  try {
    const spawn = await loadManagedChildSpawner();
    const child = owner.start(() => spawn(process.execPath, ["-e", ${JSON.stringify(gatewayScript)}], {
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    }));
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
  } finally {
    await owner.close();
    assert.equal(owner.joined(), true);
    console.log("owner joined");
  }
  signal.throwIfAborted();
  return 0;
});
console.log("interrupt status=" + status);
process.exitCode = status;`;
        const cancel = new AbortController();
        let owner: ChildProcess | undefined;
        const stopping = createDeferred();
        let output = "";
        const completion = fixture.track(
          runNodeScript(["--input-type=module", "-e", script], process.env, 20_000, {
            signal: cancel.signal,
            requireProcessTreeExit: true,
            maxBuffer: 64 * 1024,
            onReady(child) {
              owner = child;
              child.stdout!.on("data", (chunk) => {
                output += String(chunk);
                if (output.includes("stopping\n")) {
                  stopping.resolve();
                }
              });
            },
          }),
        );
        try {
          await withinTest(waitForFixtureFile(ready, completion), signal);
          cancel.abort();
          await withinTest(stopping.promise, signal);
          owner!.kill("SIGHUP");
          const result = await withinTest(completion, signal);
          expect(result, result.stderr).toMatchObject({
            error: { code: "ABORT_ERR" },
            status: null,
          });
          expect(result.stdout).toContain("owner joined\ninterrupt status=143\n");
          expect(fs.readFileSync(stopped, "utf8")).toBe("closed");
          expect(isProcessAlive(Number(fs.readFileSync(ready, "utf8")))).toBe(false);
        } finally {
          cancel.abort();
          await fixture.verifyCleanup(async () => {
            // Only this test's recorded processes can outlive a failing assertion.
            if (owner?.pid) {
              killPidIfAlive(owner.pid);
              await waitForDead(owner.pid, AbortSignal.timeout(5_000));
            }
            if (fs.existsSync(ready)) {
              const pid = Number(fs.readFileSync(ready, "utf8"));
              killPidIfAlive(pid);
              await waitForDead(pid, AbortSignal.timeout(5_000));
            }
            await completion;
          });
        }
      }),
    25_000,
  );

  it("waits for CLI exit and output closure before reporting cancellation", ({ signal }) =>
    fixture.run(async () => {
      const cwd = fixture.createTempDir("warm-reload-cli-");
      const ready = path.join(cwd, "cli-pid");
      const stopping = path.join(cwd, "cli-stopping");
      const stopped = path.join(cwd, "cli-stopped");
      const script = `const fs = require("node:fs");
process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(stopping)}, "acknowledged"));
process.once("SIGUSR2", () => {
  fs.writeFileSync(${JSON.stringify(stopped)}, "closed");
  process.stdout.write("terminal output", () => process.exit(0));
});
setInterval(() => {}, 1000);
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`;
      const cancel = new AbortController();
      let settled = false;
      const completion = fixture.track(
        runWarmReloadCli(["-e", script], { cwd, env: process.env, signal: cancel.signal }).then(
          (stdout) => ({ stdout }),
          (error: unknown) => ({ error }),
        ),
      );
      void completion.then(() => {
        settled = true;
      });
      try {
        await withinTest(waitForFixtureFile(ready, completion), signal);
        cancel.abort();
        await withinTest(waitForFixtureFile(stopping, completion), signal);
        expect(settled).toBe(false);
        process.kill(Number(fs.readFileSync(ready, "utf8")), "SIGUSR2");
        expect(await withinTest(completion, signal)).toMatchObject({
          error: { code: "ABORT_ERR" },
        });
        expect(fs.readFileSync(stopped, "utf8")).toBe("closed");
        expect(isProcessAlive(Number(fs.readFileSync(ready, "utf8")))).toBe(false);
      } finally {
        cancel.abort();
        await fixture.verifyCleanup(async () => {
          if (fs.existsSync(ready)) {
            const pid = Number(fs.readFileSync(ready, "utf8"));
            killPidIfAlive(pid);
            await waitForDead(pid, AbortSignal.timeout(5_000));
          }
          await completion;
        });
      }
    }));
});

it("returns successful CLI output and preserves the failed command diagnostic", async ({
  signal,
}) => {
  const options = { cwd: process.cwd(), env: process.env, signal };
  await expect(runWarmReloadCli(["-e", 'console.log("result")'], options)).resolves.toBe(
    "result\n",
  );
  await expect(
    runWarmReloadCli(["-e", 'console.error("fixture failure"); process.exitCode = 7'], options),
  ).rejects.toThrow("Warm reload CLI failed (7): fixture failure");
});
