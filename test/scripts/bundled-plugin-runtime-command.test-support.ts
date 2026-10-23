import childProcess, { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it, type TestContext, vi } from "vitest";
import { hasErrnoCode } from "../../src/infra/errno.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";

const runtimeSmokePath = path.resolve(
  "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs",
);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());

export function fixtureReadySource(filePath: string): string {
  return `${fixtureReceiptClientSource(receipts.endpoint)}
sendReceipt(${JSON.stringify(filePath)}, "ready");`;
}

export function registerFixtureCleanup(
  onTestFinished: TestContext["onTestFinished"],
  cleanup: () => Promise<void>,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  const finish = () => (pending ??= cleanup());
  // Abort resumes finally, but Vitest only joins explicitly registered cleanup.
  onTestFinished(finish);
  return finish;
}

export function childClosed(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("close", () => resolve());
    child.once("error", reject);
  });
}

async function fixtureReadyBeforeSettlement(
  filePath: string,
  operation: PromiseLike<unknown>,
  signal: AbortSignal,
  ready = () => fs.existsSync(filePath),
  message = `timeout waiting for ${filePath}`,
): Promise<void> {
  // Separate transports may deliver settlement before the receipt. The fixture
  // commits this record before reporting readiness or allowing its owner to exit.
  await withinTest(
    Promise.race([
      receipts.waitFor(filePath, "ready"),
      Promise.resolve(operation).then(() => {
        if (!ready()) {
          throw new Error(message);
        }
      }),
    ]),
    signal,
  );
}

function parseCompletedPidFile(content: string): number | undefined {
  const pid = Number(/^([1-9]\d*)\n$/u.exec(content)?.[1]);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

export function readCompletedPidFile(filePath: string): number | undefined {
  try {
    return parseCompletedPidFile(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function waitForPidFile(
  filePath: string,
  operation: PromiseLike<unknown>,
  signal: AbortSignal,
): Promise<number> {
  await fixtureReadyBeforeSettlement(
    filePath,
    operation,
    signal,
    () => readCompletedPidFile(filePath) !== undefined,
    `timeout waiting for pid in ${filePath}`,
  );
  return readOwnedDescendantPid(filePath);
}

export function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Foreign descendants have no ChildProcess handle here. The runtime sends tree
// signals but does not join exact-PID extinction, including after stopGateway.
export async function waitForDead(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (pidIsAlive(pid)) {
      await waitForProcessTick(20, undefined, { signal });
    }
  } catch (cause) {
    throw new Error(`timeout waiting for pid ${pid} to exit`, { cause });
  }
}

export function killPidIfAlive(pid: number | undefined): void {
  if (pid !== undefined && pidIsAlive(pid)) {
    killOwnedPid(pid);
  }
}

function killOwnedPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    // The process can exit after the liveness probe; ESRCH already satisfies cleanup.
    if (!hasErrnoCode(error, "ESRCH")) {
      throw error;
    }
  }
}

function readOwnedDescendantPid(filePath: string): number {
  const pid = parseCompletedPidFile(fs.readFileSync(filePath, "utf8"));
  if (pid === undefined) {
    throw new Error("owned descendant PID is incomplete");
  }
  return pid;
}

function killOwnedRuntimeCommand(child: ChildProcess | undefined, detached: boolean): void {
  if (!child?.pid) {
    return;
  }
  if (detached) {
    killOwnedPid(-child.pid);
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function observeRuntimeCommandTimeout(params: {
  args: string[];
  ready: (child: ChildProcess, operation: Promise<unknown>) => Promise<number[]>;
  timeoutMs: number;
  detached: boolean;
  runDetached?: boolean;
  root?: string;
  descendantPidPath?: string;
  signal: AbortSignal;
  onTestFinished: TestContext["onTestFinished"];
}): Promise<Error> {
  const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
  const spawnSpy = vi.spyOn(childProcess, "spawn");
  let child: ChildProcess | undefined;
  let commandResult: Promise<unknown> | undefined;
  let closed: Promise<void> | undefined;
  let descendantPid: number | undefined;
  let cleanupSignalsSent = false;
  let settled = false;
  const cleanup = registerFixtureCleanup(params.onTestFinished, async () => {
    try {
      try {
        // Recover ownership before fallible joins, including failed readiness.
        if (params.descendantPidPath && fs.existsSync(params.descendantPidPath)) {
          descendantPid = readOwnedDescendantPid(params.descendantPidPath);
        }
      } finally {
        try {
          killOwnedRuntimeCommand(child, params.detached);
        } finally {
          // Even broken group termination must reap the descendant after death assertions.
          killPidIfAlive(descendantPid);
        }
      }
      cleanupSignalsSent = true;
    } finally {
      vi.useRealTimers();
      spawnSpy.mockRestore();
      await commandResult;
      await closed;
      if (descendantPid !== undefined && !params.signal.aborted) {
        await waitForDead(descendantPid, params.signal);
      }
      if (settled && cleanupSignalsSent && params.root) {
        fs.rmSync(params.root, { force: true, recursive: true });
      }
    }
  });
  // Freeze the parent's policy clock, not subprocess startup, I/O, readiness or cleanup.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const command: Promise<unknown> = runtimeSmoke
      .runCommand(process.execPath, params.args, {
        detached: params.runDetached,
        timeoutMs: params.timeoutMs,
      })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    commandResult = command;
    const spawned = spawnSpy.mock.results[0];
    if (spawned?.type !== "return" || !spawned.value.pid) {
      throw new Error("runtime command did not expose its spawned child");
    }
    child = spawned.value;
    closed = childClosed(child);
    const descendants = await withinTest(params.ready(child, command), params.signal);
    const assertRunning = () => {
      for (const pid of [child!.pid!, ...descendants]) {
        expect(pidIsAlive(pid)).toBe(true);
      }
      expect(settled).toBe(false);
    };
    assertRunning();
    await vi.advanceTimersByTimeAsync(params.timeoutMs - 1);
    assertRunning();
    await vi.advanceTimersByTimeAsync(1);
    const error = await withinTest(command, params.signal);
    if (!(error instanceof Error)) {
      throw new Error("expected runtime command to time out");
    }
    await withinTest(closed, params.signal);
    expect(pidIsAlive(child.pid!)).toBe(false);
    for (const pid of descendants) {
      await waitForDead(pid, params.signal);
    }
    return error;
  } finally {
    await cleanup();
  }
}

export function registerRuntimeCommandTimeoutTests(createPackageRoot: () => string): void {
  (process.platform !== "win32" ? it : it.skip).for([
    { name: "kills timed-out runtime command groups", detached: true, timeoutMs: 250 },
    {
      name: "falls back to direct kills for non-detached command timeouts",
      detached: false,
      timeoutMs: 500,
    },
  ])("$name", async ({ detached, timeoutMs }, { signal, onTestFinished }) => {
    const root = createPackageRoot();
    const commandPath = path.join(root, "timeout-command.mjs");
    const descendantPidPath = path.join(root, "timed-out-descendant.pid");
    const readyPath = path.join(root, "timed-out-descendant.ready");
    const descendantSource = `import fs from 'node:fs';
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
${fixtureReadySource(readyPath)}`;
    const spawnDescendant = `import childProcess from 'node:child_process';
const child = childProcess.spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });`;
    fs.writeFileSync(
      commandPath,
      `import fs from 'node:fs';
${detached ? spawnDescendant : ""}
setInterval(() => {}, 1000);
fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(${detached ? "child" : "process"}.pid) + "\\n");
${fixtureReadySource(descendantPidPath)}
`,
      "utf8",
    );
    const error = await observeRuntimeCommandTimeout({
      args: [commandPath],
      ready: async (child, operation) => {
        const pid = await waitForPidFile(descendantPidPath, operation, signal);
        if (detached) {
          await fixtureReadyBeforeSettlement(readyPath, operation, signal);
          return [pid];
        }
        expect(pid).toBe(child.pid);
        return [];
      },
      timeoutMs,
      detached,
      runDetached: detached ? undefined : false,
      root,
      descendantPidPath: detached ? descendantPidPath : undefined,
      signal,
      onTestFinished,
    });
    expect(error.message).toMatch(new RegExp(`timed out after ${timeoutMs}ms`, "u"));
  });
}

export function registerRuntimeCommandOutputTimeoutTest(): void {
  it("bounds runtime smoke child commands and preserves captured output", async ({
    signal,
    onTestFinished,
  }) => {
    const startedAt = Date.now();
    const error = await observeRuntimeCommandTimeout({
      args: [
        "-e",
        "setInterval(() => {}, 1000); process.stdout.write('partial\\n'); process.stderr.write('problem\\n');",
      ],
      ready: async (child, operation) => {
        const outputReady = createDeferred();
        const output = { stdout: "", stderr: "" };
        const listeners = (["stdout", "stderr"] as const).map((stream) => {
          const listener = (chunk: string | Buffer) => {
            output[stream] += chunk.toString();
            if (output.stdout.includes("partial") && output.stderr.includes("problem")) {
              outputReady.resolve();
            }
          };
          child[stream]!.on("data", listener);
          return () => child[stream]!.off("data", listener);
        });
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              outputReady.promise,
              operation,
              "runtime command settled before output",
            ),
            signal,
          );
          return [];
        } finally {
          listeners.forEach((remove) => remove());
        }
      },
      timeoutMs: 200,
      detached: process.platform !== "win32",
      signal,
      onTestFinished,
    });
    expect(error.message).toMatch(/timed out after 200ms[\s\S]*partial[\s\S]*problem/u);
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });
}
