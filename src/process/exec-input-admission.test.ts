import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import * as execSpawn from "./exec-spawn.js";
import { withCommandProcessScope } from "./exec-spawn.js";
import { runCommandWithTimeout } from "./exec.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const unbufferedExecSpawn: {
  spawnCommandWithInvocation: typeof execSpawn.spawnCommandWithInvocation<{ buffer: false }>;
} = execSpawn;

describe("child input admission", () => {
  it.runIf(process.platform === "linux")(
    "withholds native input until delayed custody binding succeeds",
    async ({ signal }) => {
      const effect = path.join(tempDirs.make("openclaw-native-input-admission-"), "effect");
      const readStarted = createDeferred();
      const releaseRead = createDeferred();
      const ready = createDeferred();
      const nativeRead = fsPromises.readFile.bind(fsPromises);
      let delayed = false;
      const reads = vi.spyOn(fsPromises, "readFile").mockImplementation((file, options) => {
        const reading = nativeRead(file, options);
        if (!delayed && typeof file === "string" && /^\/proc\/\d+\/stat$/.test(file)) {
          delayed = true;
          return reading.then(async (stat) => {
            readStarted.resolve();
            await releaseRead.promise;
            return stat;
          });
        }
        return reading;
      });
      const spawn = execSpawn.spawnCommandWithInvocation;
      let child: ChildProcess | undefined;
      const observeSpawn = vi
        .spyOn(execSpawn, "spawnCommandWithInvocation")
        .mockImplementation((...args) => {
          const spawned = spawn(...args);
          child = spawned.child.nodeChildProcess;
          child.stdout!.once("data", () => ready.resolve());
          return spawned;
        });
      const refusal = new Error("custody binding refused");
      const spawned = vi.fn((_identity: { pid: number; startedAt: number | null }) => {
        throw refusal;
      });
      const settled = vi.fn();
      const beforeInput = vi.fn();
      const work = withCommandProcessScope(
        () =>
          runCommandWithTimeout(
            [
              process.execPath,
              "-e",
              "process.stdin.on('data',()=>require('node:fs').writeFileSync(" +
                JSON.stringify(effect) +
                ",'received'));process.stdout.write('ready');setInterval(()=>{},1000)",
            ],
            { input: "forbidden", beforeInput, timeoutMs: 5_000, killProcessTree: true },
          ),
        undefined,
        { reserve: () => ({ spawned, settled }) },
      );
      void work.catch(() => {});
      try {
        // Both the actual procfs read and the real child must start; a launch failure is not proof.
        await withinTest(
          awaitGateBeforeSettlement(
            Promise.all([readStarted.promise, ready.promise]),
            work,
            "native child did not reach admission",
          ),
          signal,
        );
        expect(child?.pid).toBeTypeOf("number");
        expect(spawned).not.toHaveBeenCalled();
        expect(beforeInput).not.toHaveBeenCalled();
        expect(existsSync(effect)).toBe(false);
        releaseRead.resolve();
        await expect(withinTest(work, signal)).rejects.toMatchObject({
          code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN",
          cause: refusal,
        });
        expect(spawned).toHaveBeenCalledTimes(1);
        expect(spawned.mock.calls[0]?.[0]).toMatchObject({
          pid: child!.pid,
          startedAt: expect.any(Number),
        });
        expect(beforeInput).not.toHaveBeenCalled();
        expect(existsSync(effect)).toBe(false);
        expect(settled).toHaveBeenCalledTimes(1);
        expect(isPidAlive(child!.pid!)).toBe(false);
      } finally {
        releaseRead.resolve();
        await work.catch(() => {});
        reads.mockRestore();
        observeSpawn.mockRestore();
      }
    },
  );

  it
    .runIf(process.platform === "linux")
    .for(["complete", "observer-stop", "observer-error", "output-limit"] as const)(
    "retains native output before delayed custody admission: %s",
    async (mode, { signal }) => {
      const readStarted = createDeferred();
      const releaseRead = createDeferred();
      const closed = createDeferred();
      const nativeRead = fsPromises.readFile.bind(fsPromises);
      let delayed = false;
      const reads = vi.spyOn(fsPromises, "readFile").mockImplementation((file, options) => {
        const reading = nativeRead(file, options);
        if (!delayed && typeof file === "string" && /^\/proc\/\d+\/stat$/.test(file)) {
          delayed = true;
          return reading.then(async (stat) => {
            readStarted.resolve();
            await releaseRead.promise;
            return stat;
          });
        }
        return reading;
      });
      const spawn = execSpawn.spawnCommandWithInvocation;
      const observeSpawn = vi
        .spyOn(execSpawn, "spawnCommandWithInvocation")
        .mockImplementation((...args) => {
          const spawned = spawn(...args);
          spawned.child.nodeChildProcess.once("close", () => closed.resolve());
          return spawned;
        });
      const observed = { stdout: "", stderr: "" };
      const bound = vi.fn();
      const beforeInput = vi.fn();
      const observerError = new Error("native output observer failed");
      const work = withCommandProcessScope(
        () =>
          runCommandWithTimeout(
            [
              process.execPath,
              "-e",
              "process.on('SIGTERM',()=>{});const fs=require('node:fs');fs.writeSync(1,'early stdout');fs.writeSync(2,'early stderr')",
            ],
            {
              timeoutMs: 5_000,
              ...(mode === "complete" ? {} : { input: "forbidden", beforeInput }),
              ...(mode === "output-limit"
                ? { maxOutputBytes: 4, terminateOnOutputLimit: true }
                : {}),
              onOutputChunk: (chunk, stream) => {
                observed[stream] += chunk.toString();
                if (mode === "observer-error") {
                  throw observerError;
                }
                if (mode === "observer-stop") {
                  return false;
                }
                return undefined;
              },
            },
          ),
        undefined,
        { reserve: () => ({ spawned: bound, settled: () => {} }) },
      );
      void work.catch(() => {});
      try {
        // Close proves the real child and both pipes finished before releasing the actual read.
        await withinTest(
          awaitGateBeforeSettlement(
            Promise.all([readStarted.promise, closed.promise]),
            work,
            "native child did not finish before admission",
          ),
          signal,
        );
        expect(bound).not.toHaveBeenCalled();
        releaseRead.resolve();
        if (mode === "observer-error") {
          await expect(withinTest(work, signal)).rejects.toBe(observerError);
        } else {
          expect(await withinTest(work, signal)).toMatchObject({
            stdout: mode === "output-limit" ? "dout" : "early stdout",
            stderr: mode === "output-limit" ? "derr" : "early stderr",
            ...(mode === "complete"
              ? { code: 0 }
              : { termination: "signal", outputLimitExceeded: true }),
          });
        }
        if (mode === "complete") {
          expect(observed).toEqual({ stdout: "early stdout", stderr: "early stderr" });
        } else {
          expect(beforeInput).not.toHaveBeenCalled();
          expect(observed.stdout + observed.stderr).not.toBe("");
        }
      } finally {
        releaseRead.resolve();
        await work.catch(() => {});
        reads.mockRestore();
        observeSpawn.mockRestore();
      }
    },
  );

  it("publishes input only after binding the actual spawned PID and argv", async () => {
    let admittedPid: number | undefined;
    let admittedArgv: readonly string[] | undefined;
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        "let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({pid:process.pid,argv:[process.argv0,...process.execArgv,...process.argv.slice(1)],input})))",
      ],
      {
        input: "owned",
        timeoutMs: 5_000,
        beforeInput: (pid, argv) => {
          admittedPid = pid;
          admittedArgv = argv;
        },
      },
    );
    expect(result.code).toBe(0);
    expect(admittedArgv).toBeDefined();
    expect(JSON.parse(result.stdout)).toEqual({
      pid: admittedPid,
      argv: admittedArgv,
      input: "owned",
    });
  });

  it.each(["refused", "EPIPE", "async"] as const)(
    "joins the child without delivering input when admission is %s",
    async (kind) => {
      let pid: number | undefined;
      const refusal = Object.assign(new Error("authority lost before input"), {
        code: kind === "EPIPE" ? kind : undefined,
      });
      const options = {
        input: "forbidden",
        timeoutMs: 5_000,
        killProcessTree: true,
        beforeInput: (childPid: number) => {
          pid = childPid;
          throw refusal;
        },
      };
      if (kind === "async") {
        // An untyped caller can violate the synchronous callback contract.
        Reflect.set(options, "beforeInput", async (childPid: number) => {
          pid = childPid;
          throw refusal;
        });
      }
      const work = runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          "process.stdin.on('data',()=>process.stdout.write('effect'));setInterval(()=>{},1000)",
        ],
        options,
      );
      if (kind === "async") {
        await expect(work).rejects.toThrow("must complete synchronously");
      } else {
        await expect(work).rejects.toBe(refusal);
        expect(refusal).toMatchObject({
          cleanup: process.platform === "win32" ? "forced" : "cooperative",
        });
      }
      expect(pid).toBeTypeOf("number");
      expect(isPidAlive(pid!)).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32").each([
    { admitted: false, exitCode: 23 },
    { admitted: true, exitCode: 0 },
    { admitted: true, exitCode: 23 },
  ])(
    "preserves results after early stdin closure (admitted=$admitted, exit=$exitCode)",
    { timeout: 5_000 },
    async ({ admitted, exitCode }) => {
      const beforeInput = vi.fn();
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          `require('node:fs').closeSync(0);process.stderr.write('stdin closed\\n');process.exitCode=${exitCode};`,
        ],
        {
          timeoutMs: 3_000,
          // Exceed the pipe buffer so early closure exercises the pending write.
          input: "x".repeat(8 * 1024 * 1024),
          ...(admitted ? { beforeInput } : {}),
        },
      );
      expect(result).toMatchObject({
        code: exitCode,
        stderr: "stdin closed\n",
        termination: "exit",
      });
      expect(beforeInput).toHaveBeenCalledTimes(admitted ? 1 : 0);
    },
  );

  it("cancels and joins the child after a non-EPIPE input fault", async () => {
    const spawn = execSpawn.spawnCommandWithInvocation;
    let child: ChildProcess | undefined;
    const observeSpawn = vi
      .spyOn(execSpawn, "spawnCommandWithInvocation")
      .mockImplementation((...args) => {
        const spawned = spawn(...args);
        child = spawned.child.nodeChildProcess;
        return spawned;
      });
    const failure = Object.assign(new Error("synthetic stdin failure"), { code: "EIO" });
    const controller = new AbortController();
    let running: ReturnType<typeof runCommandWithTimeout> | undefined;
    try {
      running = runCommandWithTimeout([process.execPath, "-e", "setInterval(()=>{},1000)"], {
        input: "x".repeat(8 * 1024 * 1024),
        beforeInput: () => {
          queueMicrotask(() => child!.stdin!.destroy(failure));
        },
        signal: controller.signal,
        killProcessTree: true,
        timeoutMs: 3_000,
      });
      await expect(running).rejects.toBe(failure);
      expect(child?.pid).toBeTypeOf("number");
      expect(isPidAlive(child!.pid!)).toBe(false);
    } finally {
      controller.abort();
      await running?.catch(() => {});
      observeSpawn.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")(
    "withholds EOF from a rejected child until its process exits",
    async ({ signal }) => {
      const dir = tempDirs.make("openclaw-exec-input-admission-");
      const effect = path.join(dir, "effect");
      const argv = [
        process.execPath,
        "-e",
        [
          "const fs=require('node:fs')",
          "process.on('SIGTERM',()=>process.exit(0))",
          "fs.writeSync(1,'ready')",
          "fs.readFileSync(0,'utf8')",
          `fs.writeFileSync(${JSON.stringify(effect)},'unauthorized')`,
          "setInterval(()=>{},1000)",
        ].join(";"),
      ];
      const spawnOptions = {
        buffer: false,
        detached: true,
        encoding: "buffer",
        reject: false,
        stdio: ["pipe", "pipe", "pipe"],
      } satisfies Parameters<typeof execSpawn.spawnCommandWithInvocation>[1];
      const spawned = execSpawn.spawnCommandWithInvocation<{ buffer: false }>(argv, spawnOptions);
      let restoreSpawn: (() => void) | undefined;
      try {
        // The real child must install its signal handler before admission rejects.
        // Its synchronous read prevents SIGTERM handling until input reaches EOF.
        expect(await once(spawned.child.stdout!, "data", { signal })).toEqual([
          Buffer.from("ready"),
        ]);
        const spawnSpy = vi
          .spyOn(unbufferedExecSpawn, "spawnCommandWithInvocation")
          .mockImplementationOnce((_argv, options) => {
            expect(options?.buffer).toBe(false);
            return spawned;
          });
        restoreSpawn = () => spawnSpy.mockRestore();
        const refusal = new Error("authority lost before input");
        const work = runCommandWithTimeout(argv, {
          input: "forbidden",
          timeoutMs: 5_000,
          killProcessTree: true,
          beforeInput: () => {
            throw refusal;
          },
        });
        await expect(work).rejects.toBe(refusal);
        expect(existsSync(effect)).toBe(false);
        expect(refusal).toMatchObject({ cleanup: "forced" });
        expect(isPidAlive(spawned.child.pid!)).toBe(false);
      } finally {
        restoreSpawn?.();
        if (
          spawned.child.nodeChildProcess.exitCode === null &&
          spawned.child.nodeChildProcess.signalCode === null
        ) {
          spawned.child.kill("SIGKILL");
        }
        await spawned.child;
      }
    },
  );

  it.skipIf(process.platform === "win32").for([
    { kind: "empty text", input: "" },
    { kind: "empty bytes", input: new Uint8Array(0) },
  ])(
    "preserves $kind completion when an admitted child has closed stdin",
    async ({ input }, { signal }) => {
      const argv = [
        process.execPath,
        "-e",
        "require('node:fs').closeSync(0);process.on('message',()=>process.exit(0));require('node:fs').writeSync(1,'ready')",
      ];
      const spawnOptions = {
        buffer: false,
        detached: true,
        encoding: "buffer",
        ipc: true,
        reject: false,
        stdio: ["pipe", "pipe", "pipe"],
      } satisfies Parameters<typeof execSpawn.spawnCommandWithInvocation>[1];
      const spawned = execSpawn.spawnCommandWithInvocation<{ buffer: false }>(argv, spawnOptions);
      let restoreSpawn: (() => void) | undefined;
      try {
        expect(await once(spawned.child.stdout!, "data", { signal })).toEqual([
          Buffer.from("ready"),
        ]);
        const spawnSpy = vi
          .spyOn(unbufferedExecSpawn, "spawnCommandWithInvocation")
          .mockImplementationOnce((_argv, options) => {
            expect(options?.buffer).toBe(false);
            return spawned;
          });
        restoreSpawn = () => spawnSpy.mockRestore();
        const beforeInput = vi.fn(() => {
          // Keep the peer alive through input publication; cancellation may win the reply.
          setImmediate(() => spawned.child.nodeChildProcess.send("finish", () => {}));
        });
        const work = runCommandWithTimeout(argv, {
          input,
          timeoutMs: 5_000,
          killProcessTree: true,
          beforeInput,
        });
        await expect(work).resolves.toMatchObject({ code: 0, cleanup: "normal" });
        expect(beforeInput).toHaveBeenCalledExactlyOnceWith(
          spawned.child.pid,
          spawned.child.nodeChildProcess.spawnargs,
        );
        expect(isPidAlive(spawned.child.pid!)).toBe(false);
      } finally {
        restoreSpawn?.();
        if (
          spawned.child.nodeChildProcess.exitCode === null &&
          spawned.child.nodeChildProcess.signalCode === null
        ) {
          spawned.child.kill("SIGKILL");
        }
        await spawned.child;
      }
    },
  );
});
