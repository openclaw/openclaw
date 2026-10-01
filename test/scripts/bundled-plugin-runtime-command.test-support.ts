import childProcess, { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const runtimeSmokePath = path.resolve(
  "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs",
);

export async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => {
      realSetTimeout(resolve, 20);
    });
  }
  throw new Error(`timeout waiting for ${filePath}`);
}

function parseCompletedPidFile(content: string): number | undefined {
  const match = /^([1-9]\d*)\n$/u.exec(content);
  if (!match) {
    return undefined;
  }
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

export async function waitForPidFile(filePath: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = parseCompletedPidFile(fs.readFileSync(filePath, "utf8"));
      if (pid !== undefined) {
        return pid;
      }
    } catch {
      // The child creates the file asynchronously; keep polling until its payload is complete.
    }
    await new Promise((resolve) => {
      realSetTimeout(resolve, 20);
    });
  }
  throw new Error(`timeout waiting for pid in ${filePath}`);
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

export async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) {
      return;
    }
    await new Promise((resolve) => {
      realSetTimeout(resolve, 20);
    });
  }
  throw new Error(`timeout waiting for pid ${pid} to exit`);
}

export function killPidIfAlive(pid: number | undefined): void {
  if (pid === undefined || !pidIsAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    // The process can exit after the liveness probe; ESRCH already satisfies cleanup.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH") {
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
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function withRealWatchdog<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = realSetTimeout(
          () => reject(new Error("runtime command did not settle")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    realClearTimeout(timer);
  }
}

async function observeRuntimeCommandTimeout(params: {
  run: () => Promise<unknown>;
  ready: (child: ChildProcess) => Promise<number[]>;
  timeoutMs: number;
  detached: boolean;
  root?: string;
  descendantPidPath?: string;
  exitTimeoutMs?: number;
}): Promise<Error> {
  const spawnSpy = vi.spyOn(childProcess, "spawn");
  let child: ChildProcess | undefined;
  let commandResult: Promise<unknown> | undefined;
  let descendantPid: number | undefined;
  let cleanupSignalsSent = false;
  let settled = false;
  // Freeze only the parent's policy clock. Real subprocess startup, pipe I/O,
  // readiness and cleanup watchdogs must not consume or depend on that clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    commandResult = params
      .run()
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    const spawned = spawnSpy.mock.results[0];
    if (spawned?.type !== "return" || !spawned.value.pid) {
      throw new Error("runtime command did not expose its spawned child");
    }
    child = spawned.value;
    const descendants = await params.ready(child);
    const assertRunning = () => {
      expect(pidIsAlive(child!.pid!)).toBe(true);
      for (const pid of descendants) {
        expect(pidIsAlive(pid)).toBe(true);
      }
      expect(settled).toBe(false);
    };
    assertRunning();
    await vi.advanceTimersByTimeAsync(params.timeoutMs - 1);
    assertRunning();
    await vi.advanceTimersByTimeAsync(1);
    const error = await withRealWatchdog(commandResult, 2000);
    if (!(error instanceof Error)) {
      throw new Error("expected runtime command to time out");
    }
    for (const pid of [child.pid!, ...descendants]) {
      await waitForDead(pid, params.exitTimeoutMs ?? 2000);
    }
    return error;
  } finally {
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
          // A broken group-termination path must still reap the known descendant.
          // This fallback follows the successful-path death assertions above.
          killPidIfAlive(descendantPid);
        }
      }
      cleanupSignalsSent = true;
    } finally {
      vi.useRealTimers();
      spawnSpy.mockRestore();
      if (commandResult) {
        await withRealWatchdog(commandResult, 2000);
      }
      if (child?.pid) {
        await waitForDead(child.pid, params.exitTimeoutMs ?? 2000);
      }
      if (descendantPid !== undefined) {
        await waitForDead(descendantPid, 2000);
      }
      if (settled && cleanupSignalsSent && params.root) {
        fs.rmSync(params.root, { force: true, recursive: true });
      }
    }
  }
}

export function registerRuntimeCommandTimeoutTests(createPackageRoot: () => string): void {
  (process.platform !== "win32" ? it : it.skip)(
    "kills timed-out runtime command groups",
    async () => {
      const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
      const root = createPackageRoot();
      const commandPath = path.join(root, "timeout-command.mjs");
      const descendantPidPath = path.join(root, "timed-out-descendant.pid");
      const readyPath = path.join(root, "timed-out-descendant.ready");
      const descendantScript = [
        "import fs from 'node:fs';",
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
        `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
      ].join("\n");
      fs.writeFileSync(
        commandPath,
        [
          "import childProcess from 'node:child_process';",
          "import fs from 'node:fs';",
          `const child = childProcess.spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(
            descendantScript,
          )}], { stdio: "ignore" });`,
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid) + "\\n");`,
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        "utf8",
      );

      const error = await observeRuntimeCommandTimeout({
        run: () =>
          runtimeSmoke.runCommand(process.execPath, [commandPath], {
            detached: undefined,
            timeoutMs: 250,
          }),
        ready: async () => {
          const pid = await waitForPidFile(descendantPidPath, 1000);
          await waitForFile(readyPath, 1000);
          return [pid];
        },
        timeoutMs: 250,
        detached: true,
        root,
        descendantPidPath,
      });
      expect(error.message).toMatch(/timed out after 250ms/u);
    },
  );

  (process.platform !== "win32" ? it : it.skip)(
    "falls back to direct kills for non-detached command timeouts",
    async () => {
      const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
      const root = createPackageRoot();
      const commandPath = path.join(root, "non-detached-timeout-command.mjs");
      const commandPidPath = path.join(root, "non-detached-command.pid");
      fs.writeFileSync(
        commandPath,
        [
          "import fs from 'node:fs';",
          "setInterval(() => {}, 1000);",
          `fs.writeFileSync(${JSON.stringify(commandPidPath)}, String(process.pid) + "\\n");`,
          "",
        ].join("\n"),
        "utf8",
      );

      const error = await observeRuntimeCommandTimeout({
        run: () =>
          runtimeSmoke.runCommand(process.execPath, [commandPath], {
            detached: false,
            timeoutMs: 500,
          }),
        ready: async (child) => {
          expect(await waitForPidFile(commandPidPath, 1000)).toBe(child.pid);
          return [];
        },
        timeoutMs: 500,
        detached: false,
        root,
        exitTimeoutMs: 1000,
      });
      expect(error.message).toMatch(/timed out after 500ms/u);
    },
  );
}

export function registerRuntimeCommandOutputTimeoutTest(): void {
  it("bounds runtime smoke child commands and preserves captured output", async () => {
    const runtimeSmoke = await import(pathToFileURL(runtimeSmokePath).href);
    const startedAt = Date.now();
    const error = await observeRuntimeCommandTimeout({
      run: () =>
        runtimeSmoke.runCommand(
          process.execPath,
          [
            "-e",
            "setInterval(() => {}, 1000); process.stdout.write('partial\\n'); process.stderr.write('problem\\n');",
          ],
          { timeoutMs: 200 },
        ),
      ready: async (child) => {
        let stdout = "",
          stderr = "";
        const onStdout = (chunk: string | Buffer) => {
          stdout += chunk.toString();
        };
        const onStderr = (chunk: string | Buffer) => {
          stderr += chunk.toString();
        };
        child.stdout!.on("data", onStdout);
        child.stderr!.on("data", onStderr);
        try {
          const deadline = Date.now() + 1000;
          while (
            (!stdout.includes("partial") || !stderr.includes("problem")) &&
            Date.now() < deadline
          ) {
            await new Promise<void>((resolve) => {
              realSetTimeout(resolve, 20);
            });
          }
          expect(stdout).toContain("partial");
          expect(stderr).toContain("problem");
          return [];
        } finally {
          child.stdout!.off("data", onStdout);
          child.stderr!.off("data", onStderr);
        }
      },
      timeoutMs: 200,
      detached: process.platform !== "win32",
    });
    expect(error.message).toMatch(/timed out after 200ms[\s\S]*partial[\s\S]*problem/u);
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });
}
