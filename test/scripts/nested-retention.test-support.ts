import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect } from "vitest";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { withinTest } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

// Escaped descendants have no surviving ChildProcess owner. Keep only the
// foreign-PID extinction check, bounded by the owning test's cancellation.
async function waitForReaped(pid: number, signal: AbortSignal): Promise<void> {
  while (isProcessAlive(pid)) {
    if (signal.aborted) {
      throw new Error(`process still alive: ${pid}`, { cause: signal.reason });
    }
    await delay(5, undefined, { signal }).catch((error: unknown) => {
      throw new Error(`process still alive: ${pid}`, { cause: error });
    });
  }
}

/** Real escaped writer, inner fixture lifetime, and two non-isolated worker files. */
export async function proveNestedRetention(
  root: string,
  pool: "threads" | "forks",
  signal: AbortSignal,
  mode: "failure" | "swallowed" | "crash" = "failure",
) {
  const file = (name: string) => path.join(root, name);
  const source = (name: string) => JSON.stringify(path.join(repoRoot, name));
  const read = (name: string) => JSON.parse(fs.readFileSync(file(name), "utf8"));
  const write = (name: string, text: string) => fs.writeFileSync(file(name), text);
  write(
    "process.mjs",
    `import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
${fixtureReceiptClientSource(receipts.endpoint)}
import { sendReceipt as sendBeforeReceipt } from './before-client.mjs';
const [role, control, input] = process.argv.slice(2);
const file = name => path.join(control, name);
const publish = (name, data) => {
  fs.writeFileSync(file(name + '.tmp'), JSON.stringify(data));
  fs.renameSync(file(name + '.tmp'), file(name));
};
if (role === 'leader') {
  const child = spawn(process.execPath, [import.meta.filename, 'writer', control, input], {
    detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  publish('writer.pid.json', child.pid);
  child.once('message', () => process.exit(0));
  child.once('error', () => process.exit(2));
} else {
  // A safety deadline is not a readiness signal. The test must stop and join us.
  const deadline = setTimeout(() => process.exit(3), 90000);
  const append = phase => {
    try {
      fs.appendFileSync(input, phase + '\\n');
      publish(phase + '.json', { pid: process.pid, written: phase });
    } catch (error) {
      publish(phase + '.json', { pid: process.pid, error: error.code });
    }
    // Durable publication precedes either receipt and the leader's exit.
    if (phase === 'before') sendBeforeReceipt(file('before.json'), 'written');
    else sendReceipt(file('after.json'), 'written');
  };
  process.on('SIGUSR1', () => append('after'));
  process.on('SIGTERM', () => { clearTimeout(deadline); });
  append('before');
  process.send('ready');
  process.disconnect();
}
`,
  );
  write(
    "01-retain.test.ts",
    `import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { threadId } from 'node:worker_threads';
import { createFixtureLifetime } from ${source("test/helpers/fixture-lifetime.ts")};
import { runManagedCommand, inspectManagedProcessGroup } from ${source("scripts/lib/managed-child-process.mts")};
import { fixtureReceiptClientSource, openFixtureReceiptChannel } from ${source("test/helpers/fixture-receipts.ts")};
import { withinTest } from ${source("test/helpers/promise.ts")};
const lifetime = createFixtureLifetime();
const control = ${JSON.stringify(root)};
const file = name => path.join(control, name);
let beforeReceipts;
beforeAll(async () => {
  beforeReceipts = await openFixtureReceiptChannel();
  fs.writeFileSync(file('before-client.mjs'), fixtureReceiptClientSource(beforeReceipts.endpoint) + '\\nexport { sendReceipt };\\n');
});
afterAll(async () => { await beforeReceipts.close(); });
let retained;
afterEach(async () => {
  try { await lifetime.cleanup(); }
  catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors[0]).toMatchObject({ code: 'EPROCESSGROUP_CLEANUP_FAILED', processTreeState: 'indeterminate' });
    expect(fs.existsSync(retained.root)).toBe(true);
    fs.writeFileSync(file('retained.json'), JSON.stringify({ ...retained, cleanup: error.message, cleanupCode: error.errors[0].code, processTreeState: error.errors[0].processTreeState }));
    ${mode === "swallowed" ? "" : "throw error;"}
  }
});
it('retains inputs after a genuine escaped writer fails strict join', async ({ signal }) => {
  const root = lifetime.createTempDir('inner-retained-');
  const input = path.join(root, 'input');
  fs.writeFileSync(input, 'owned\\n');
  let child;
  let exited;
  const command = lifetime.track(runManagedCommand({
    bin: process.execPath, args: [file('process.mjs'), 'leader', control, input],
    shell: false, stdio: ['ignore', 'pipe', 'pipe'], requireProcessTreeExit: true,
    timeoutMs: 15000, timeoutKillGraceMs: 0,
    onReady(owned) {
      child = owned;
      exited = new Promise(resolve => child.once('exit', resolve));
      fs.writeFileSync(file('leader.pid.json'), JSON.stringify(child.pid));
    },
  }));
  const settled = command.then(
    () => { if (!fs.existsSync(file('before.json'))) throw new Error('timeout waiting for ' + file('before.json')); },
    (error: unknown) => { if (!fs.existsSync(file('before.json'))) throw error; },
  );
  await withinTest(Promise.race([beforeReceipts.waitFor(file('before.json'), 'written'), settled]), signal);
  const before = JSON.parse(fs.readFileSync(file('before.json'), 'utf8'));
  expect(before.written).toBe('before');
  retained = { root, input, namespace: os.tmpdir(), workerPid: process.pid, threadId, leaderPid: child.pid, writerPid: before.pid };
  fs.writeFileSync(file('retained.json'), JSON.stringify(retained));
  ${mode === "crash" ? "process.kill(process.pid, 'SIGKILL'); await new Promise(() => {});" : ""}
  await withinTest(exited, signal);
  // The real writer has written and the leader has exited. Advance only the
  // unchanged drain deadline; native process/pipe observation remains real.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
  try {
    await expect(command).rejects.toMatchObject({ code: 'EPROCESSGROUP_CLEANUP_FAILED', processTreeState: 'indeterminate' });
  } finally {
    clock.mockRestore();
  }
  expect(child.exitCode).toBe(0);
  expect(inspectManagedProcessGroup(child, { errorPolicy: 'indeterminate' })).toBe('dead');
  expect(child.stdout.destroyed).toBe(true);
}, 25000);
`,
  );
  write(
    "02-reset.test.ts",
    `import fs from 'node:fs';
import { threadId } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
vi.resetModules();
const { createFixtureLifetime } = await import(${source("test/helpers/fixture-lifetime.ts")});
it('keeps retained inputs across the next non-isolated file and module reset', async () => {
  const retained = JSON.parse(fs.readFileSync(${JSON.stringify(file("retained.json"))}, 'utf8'));
  expect(process.pid).toBe(retained.workerPid);
  expect(threadId).toBe(retained.threadId);
  await createFixtureLifetime().cleanup();
  expect(fs.readFileSync(retained.input, 'utf8')).toBe('owned\\nbefore\\n');
});
`,
  );
  write(
    "vitest.config.ts",
    `import { sharedVitestConfig } from ${source("test/vitest/vitest.shared.config.ts")};
import { BaseSequencer } from 'vitest/node';
class Ordered extends BaseSequencer {
  async sort(files) { return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)); }
}
export default {
  resolve: sharedVitestConfig.resolve, plugins: sharedVitestConfig.plugins,
  cacheDir: ${JSON.stringify(file("cache"))},
  test: {
    include: [${JSON.stringify(mode === "crash" ? "01-retain.test.ts" : "0*.test.ts")}], pool: ${JSON.stringify(pool)}, isolate: false,
    maxWorkers: 1, fileParallelism: false, sequence: { sequencer: Ordered },
    runner: ${source("test/non-isolated-runner.ts")},
    reporters: ['verbose', 'json'], outputFile: ${JSON.stringify(file("report.json"))},
    testTimeout: 25000, hookTimeout: 10000, teardownTimeout: 5000,
  },
};
`,
  );
  const args = [
    path.join(repoRoot, "scripts/run-vitest.mjs"),
    "run",
    "--config",
    file("vitest.config.ts"),
    "--root",
    root,
    "--configLoader",
    "native",
  ];
  const { child, completion } = spawnOwnedVitestProcess({
    command: process.execPath,
    args,
    options: {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: file("home"),
        USERPROFILE: file("home"),
        TMPDIR: file("tmp"),
        TMP: file("tmp"),
        TEMP: file("tmp"),
        CI: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
        TSX_DISABLE_CACHE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  });
  let output = "";
  for (const pipe of [child.stdout, child.stderr]) {
    pipe!.on("data", (chunk) => {
      output += String(chunk);
    });
  }
  const outcome = completion.then(
    (result) => ({ result }),
    (error: unknown) => ({ error: String(error) }),
  );
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  const killGroup = (pid: number) => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  };
  const abort = () => killGroup(child.pid!);
  signal.addEventListener("abort", abort, { once: true });
  let outerClosed = false;
  const taskProcesses = () => {
    let pids: string;
    try {
      // Select the unique fixture first: unrelated host argv can exceed ps's
      // capture budget and must never enter test diagnostics or cleanup.
      pids = execFileSync("pgrep", ["-f", root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")], {
        encoding: "utf8",
        timeout: 2000,
      }).trim();
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 1) {
        return [];
      }
      throw error;
    }
    return execFileSync("ps", ["-p", pids.split(/\s+/).join(","), "-o", "pid=,pgid=,command="], {
      encoding: "utf8",
      timeout: 2000,
    })
      .split("\n")
      .filter(
        (line) =>
          line
            .trimStart()
            .replace(/^\d+\s+\d+\s+/, "")
            .startsWith(process.execPath + " ") &&
          line.includes(root) &&
          [
            file("process.mjs"),
            "scripts/run-vitest.mjs",
            "scripts/lib/vitest-worker-bootstrap.mts",
          ].some((entry) => line.includes(entry)),
      )
      .map((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s/.exec(line);
        if (!match) {
          throw new Error("Could not inspect task-owned process");
        }
        return { pid: Number(match[1]), group: Number(match[2]) };
      });
  };
  try {
    await runQaGatewayFixture(
      async () => {
        signal.throwIfAborted();
        const outer = await withinTest(outcome, signal);
        await withinTest(closed, signal);
        const retained = read("retained.json");
        const before = read("before.json");
        process.kill(before.pid, "SIGUSR1");
        await withinTest(receipts.waitFor(file("after.json"), "written"), signal);
        const after = read("after.json");
        const observation = {
          pool,
          mode,
          node: process.version,
          command: [process.execPath, ...args],
          outer,
          outerPid: child.pid,
          outerAlive: isProcessAlive(child.pid!),
          workerAlive: isProcessAlive(retained.workerPid),
          leaderAlive: isProcessAlive(retained.leaderPid),
          retained,
          before,
          after,
          writerAlive: isProcessAlive(retained.writerPid),
          rootExists: fs.existsSync(retained.root),
          namespaceExists: fs.existsSync(retained.namespace),
          processes: execFileSync(
            "ps",
            ["-o", "pid=,ppid=,pgid=,stat=", "-p", String(retained.writerPid)],
            { encoding: "utf8", timeout: 2000 },
          ).trim(),
        };
        write("observation.json", JSON.stringify(observation, null, 2));
        if (mode !== "crash") {
          const report = read("report.json");
          expect(report.testResults.map((entry: { status: string }) => entry.status)).toEqual([
            mode === "failure" ? "failed" : "passed",
            "passed",
          ]);
          if (mode === "failure") {
            expect(report.testResults[0].assertionResults[0].failureMessages.join("\n")).toContain(
              "Managed command cleanup could not verify child, process group, and output closure",
            );
          } else {
            expect(report.success).toBe(true);
          }
        }
        expect(outer).toHaveProperty(
          "error",
          expect.stringContaining("retained temporary namespace"),
        );
        expect(output).toContain(`retained temporary namespace ${retained.namespace}`);
        expect(observation.outerAlive).toBe(false);
        expect(observation.workerAlive).toBe(false);
        expect(observation.leaderAlive).toBe(false);
        expect(observation.writerAlive).toBe(true);
        expect(after.pid).toBe(before.pid);
        expect(
          observation.rootExists,
          `nested retained root was deleted while writer ${after.pid} remained live; evidence: ${file("observation.json")}`,
        ).toBe(true);
        expect(after).toEqual({ pid: before.pid, written: "after" });
      },
      async () => {
        // Include detached nested coordinators; killing only the first wrapper
        // cannot prevent a late inner launch after a failed readiness wait.
        if (child.exitCode === null && child.signalCode === null) {
          abort();
        }
        const spawners = taskProcesses();
        for (const { group } of spawners) {
          killGroup(group);
        }
        await closed;
        await outcome;
        outerClosed = true;
        for (const { pid } of spawners) {
          await waitForReaped(pid, signal);
        }
      },
      async () => {
        const recorded = ["leader.pid.json", "writer.pid.json"]
          .filter((name) => fs.existsSync(file(name)))
          .map((name) => Number(fs.readFileSync(file(name), "utf8")))
          .filter((pid) => Number.isSafeInteger(pid) && pid > 1);
        // Close the spawn-to-PID-publication window using the exact task argv.
        const remaining = taskProcesses();
        for (const { group } of remaining) {
          killGroup(group);
        }
        const pids = [...new Set([...recorded, ...remaining.map(({ pid }) => pid)])];
        await runQaGatewayFixture(
          async () => {},
          ...pids.map((pid) => async () => {
            if (!Number.isSafeInteger(pid) || pid <= 1) {
              throw new Error("Invalid owned fixture PID");
            }
            killGroup(pid);
            await waitForReaped(pid, signal);
          }),
        );
        expect(taskProcesses()).toEqual([]);
        write(
          "cleanup.json",
          JSON.stringify(
            {
              outerPid: child.pid,
              outerClosed,
              pids: pids.map((pid) => ({ pid, alive: isProcessAlive(pid) })),
            },
            null,
            2,
          ),
        );
      },
    );
  } finally {
    signal.removeEventListener("abort", abort);
    write("output.log", output);
  }
  // Only a successful scenario and every joined cleanup may dispose the complete
  // fixture. Any body or cleanup failure retains its evidence and inputs.
  fs.rmSync(root, { recursive: true, force: true });
}
