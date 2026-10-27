import { ok } from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { serialize } from "node:v8";
import { execa } from "execa";
import { afterAll, afterEach, aroundEach, beforeAll, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createRemoteShellSandboxSession } from "../../agents/sandbox/remote-shell-transport.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { spawnCommand, withCommandProcessScope } from "../exec-spawn.js";
import { runCommandBuffered, runCommandWithTimeout, runExec } from "../exec.js";
import { prepareOomScoreAdjustedSpawn } from "../linux-oom-score.js";
import { createChildAdapter } from "../supervisor/adapters/child.js";
import { BrokerChild } from "./child.js";
import { runWithSpawnBroker } from "./context.js";
import type { CommandSpawnOptions } from "./execa-types.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const nodeArgv = (source: string, ...args: string[]) => [process.execPath, "-e", source, ...args];

describe.skipIf(!supportsSpawnBrokerCommandTransport())("broker command transports", () => {
  let host: SpawnBrokerHost;
  beforeAll(async () => {
    host = createSpawnBrokerHost();
    await host.ready();
  });
  afterAll(() => host.close());

  function launch(argv: string[], options: CommandSpawnOptions, broker = true) {
    if (!broker) {
      return execa(argv[0]!, argv.slice(1), options);
    }
    return runWithSpawnBroker(host, () => spawnCommand(argv, options));
  }
  const start = (source: string, options: CommandSpawnOptions, broker = true) =>
    launch(nodeArgv(source), options, broker);

  async function readyCommand(command: ReturnType<typeof start>, required = true) {
    const child = command.nodeChildProcess;
    if (required || child instanceof BrokerChild) {
      ok(child instanceof BrokerChild, "Fixture did not use the broker");
      await child.ready();
    }
  }

  const cases: Array<[string, string, CommandSpawnOptions?, boolean?]> = [
    [
      "success",
      "process.stdin.pipe(process.stdout);process.stderr.write('err\\n')",
      { input: "out\n", stdin: "pipe" },
    ],
    [
      "binary diagnostics",
      "process.stdout.write(Buffer.from([239,187,191,0,8,9,13,27,91,51,49,109,65,27,91,48,109,255,10]));process.stderr.write('failure\\r\\n');process.exitCode=3",
    ],
    [
      "Unicode diagnostics",
      "process.stdout.write('漢字\\u2028\\u007f\\u0001\\n');process.stderr.write('failure\\n');process.exitCode=4",
      { encoding: "utf8" },
    ],
    ["signal", "process.kill(process.pid,'SIGTERM')"],
    ["timeout", "setInterval(()=>{},1000)", { timeout: 100 }],
    ["maxBuffer", "process.stdout.write('x'.repeat(8192))", { maxBuffer: 128 }],
    ["cancel", "process.stdout.write('ready');setInterval(()=>{},1000)", undefined, true],
    [
      "forced cancel",
      "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
      undefined,
      true,
    ],
  ];

  it.each([
    { guarded: true, revoked: false },
    { guarded: true, revoked: true },
    { guarded: false, revoked: false },
  ])(
    "guards sandbox launch (guarded: $guarded, revoked: $revoked)",
    async ({ guarded, revoked }) => {
      const marker = path.join(tempDirs.make("sandbox-broker-revocation-"), "effect");
      const ownerContext = new AsyncLocalStorage<string>();
      const refusal = new Error("Sandbox runtime removed");
      let current = !revoked;
      const launches: Array<{ current: boolean; pid: number; context: string | undefined }> = [];
      const settled = vi.fn();
      const assertCurrent = vi.fn(() => {
        expect(ownerContext.getStore()).toBe("sandbox-owner");
        if (!current) {
          throw refusal;
        }
      });
      const session = createRemoteShellSandboxSession({
        buildCommand: () => ({
          argv: nodeArgv("require('node:fs').writeFileSync(process.argv[1], 'dispatched')", marker),
          env: { ...process.env },
        }),
        assertCurrent: guarded ? assertCurrent : undefined,
      });
      const scope = {
        reserve: () => ({
          spawned: ({ pid }) => {
            launches.push({ current, pid, context: ownerContext.getStore() });
          },
          settled,
        }),
      } satisfies NonNullable<Parameters<typeof withCommandProcessScope>[2]>;
      const run = () =>
        withCommandProcessScope(
          () => session.runCommand({ remoteCommand: "synthetic" }),
          undefined,
          scope,
        );
      const command = ownerContext.run("sandbox-owner", () => runWithSpawnBroker(host, run));
      const spawnedSynchronously = launches.length > 0;
      current = false;
      if (revoked) {
        await expect(command).rejects.toBe(refusal);
        await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
        expect(launches).toEqual([]);
        expect(settled).not.toHaveBeenCalled();
      } else {
        await expect(command).resolves.toMatchObject({ code: 0 });
        await expect(readFile(marker, "utf8")).resolves.toBe("dispatched");
        expect(launches).toEqual([
          { current: guarded, pid: expect.any(Number), context: "sandbox-owner" },
        ]);
        expect(settled).toHaveBeenCalledOnce();
      }
      expect(spawnedSynchronously).toBe(guarded && !revoked);
      expect(assertCurrent).toHaveBeenCalledTimes(guarded ? 1 : 0);
      await session.dispose();
    },
  );

  it.each([0, 23])("preserves admitted stdin closure (exit=%s)", async (exitCode) => {
    const beforeInput = vi.fn();
    const result = await runWithSpawnBroker(host, () =>
      runCommandWithTimeout(
        nodeArgv(
          `require('node:fs').closeSync(0);process.stderr.write('stdin closed\\n');process.exitCode=${exitCode};`,
        ),
        { input: "x".repeat(8 * 1024 * 1024), beforeInput, timeoutMs: 3_000 },
      ),
    );
    expect(result).toMatchObject({ code: exitCode, stderr: "stdin closed\n", termination: "exit" });
    expect(beforeInput).toHaveBeenCalledOnce();
  });

  it.each(["EPIPE", "EIO"])("preserves transferred stdin errors (%s)", async (code) => {
    const outcomes: unknown[] = [];
    for (const broker of [false, true]) {
      const command = start(
        "const keepAlive=setInterval(()=>{},1000);process.on('SIGUSR2',()=>{clearInterval(keepAlive);process.stderr.write('finished\\n');process.exitCode=23});process.stdin.resume();process.stdout.write('ready');",
        { stdin: "pipe", reject: false, timeout: 3_000, stripFinalNewline: false },
        broker,
      );
      try {
        await readyCommand(command, broker);
        await new Promise<void>((resolve) => {
          command.stdout!.once("data", () => resolve());
        });
        const input = command.stdin!;
        const closed = new Promise<void>((resolve) => {
          input.once("close", () => resolve());
        });
        input.destroy(Object.assign(new Error("synthetic stdin failure"), { code }));
        await closed;
        // The pipe acknowledgement precedes this signal on the broker's private channel.
        command.kill("SIGUSR2");
        const result = await command;
        outcomes.push({
          code: result.code,
          exitCode: result.exitCode,
          originalMessage: Reflect.get(result, "originalMessage"),
          stderr: result.stderr,
        });
      } finally {
        command.kill("SIGKILL");
        await command.catch(() => {});
      }
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[0]).toMatchObject({ code: code === "EIO" ? "EIO" : undefined, exitCode: 23 });
  });

  it.each(cases)(
    "matches buffered %s results and errors",
    async (_name, source, options, cancel) => {
      const outcomes: unknown[] = [];
      for (const broker of [false, true]) {
        const controller = new AbortController();
        const command = start(
          source,
          {
            encoding: "buffer",
            stdin: "ignore",
            stripFinalNewline: false,
            forceKillAfterDelay: 50,
            cancelSignal: controller.signal,
            ...options,
          },
          broker,
        );
        await readyCommand(command, broker);
        if (cancel) {
          command.stdout?.once("data", () => controller.abort());
        }
        const result = await command.catch((error: unknown) => error);
        expect(result).toBeTypeOf("object");
        const value = result as Awaited<typeof command>;
        outcomes.push({
          error: result instanceof Error,
          message: result instanceof Error ? result.message : undefined,
          stdout: value.stdout,
          stderr: value.stderr,
          exitCode: value.exitCode,
          signal: value.signal,
          failed: value.failed,
          timedOut: value.timedOut,
          isCanceled: value.isCanceled,
          isMaxBuffer: value.isMaxBuffer,
          isTerminated: value.isTerminated,
          isForcefullyTerminated: value.isForcefullyTerminated,
          shortMessage: value.shortMessage,
        });
      }
      expect(outcomes[1]).toEqual(outcomes[0]);
    },
  );

  it("drains buffered results larger than one IPC frame when callers only await", async () => {
    const command = start("process.stdout.write('x'.repeat(17*1024*1024))", {
      encoding: "buffer",
      stdin: "ignore",
      stderr: "ignore",
      maxBuffer: 18 * 1024 * 1024,
    });
    const result = await command;
    expect(result.stdout).toHaveLength(17 * 1024 * 1024);
  });

  it.each(["buffer", "utf8"] as const)("sends failed %s output once", async (encoding) => {
    const size = 1024 * 1024;
    const remote = host.spawnExeca(
      nodeArgv(
        `process.stdout.write('x'.repeat(${size}));process.stderr.write('y'.repeat(${size}));process.exitCode=7`,
      ),
      { stdin: "ignore", encoding, reject: false, maxBuffer: size },
    );
    await remote.child.ready();
    remote.child.stdout?.resume();
    remote.child.stderr?.resume();
    const result = await remote.result;
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toHaveLength(size);
    expect(result.stderr).toHaveLength(size);
    // IPC capacity accounts for captured output once, plus bounded result metadata.
    expect(serialize(result).byteLength).toBeLessThan(2 * size + 16 * 1024);
  });

  it("retains execa file output and Error results with reject:false", async () => {
    const directory = tempDirs.make("openclaw-broker-execa-");
    const file = path.join(directory, "stdout");
    const result = await start(
      "process.stdout.write('file bytes');process.stderr.write('failure');process.exitCode=9",
      {
        stdin: "ignore",
        stdout: { file },
        buffer: { stdout: false },
        reject: false,
      },
    );
    expect(await readFile(file, "utf8")).toBe("file bytes");
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({ exitCode: 9, stderr: "failure" });
  });

  it("preserves launch errors and cancellation during broker admission", async () => {
    for (const buffer of [false, true]) {
      const options = { buffer, stdin: "ignore", reject: false } as const;
      const missing = await launch(["openclaw-broker-nonexistent-command"], options);
      expect(missing).toBeInstanceOf(Error);
      expect(missing).toMatchObject({ failed: true, code: "ENOENT" });
    }
    const controller = new AbortController();
    controller.abort();
    const canceled = await start("setInterval(()=>{},1000)", {
      input: Buffer.alloc(2 * 1024 * 1024),
      reject: false,
      cancelSignal: controller.signal,
    });
    expect(canceled).toBeInstanceOf(Error);
    expect(canceled).toMatchObject({ failed: true, isCanceled: true });
  });

  it("fails in-flight commands on broker loss and resumes in the next broker", async () => {
    const command = start("process.stdout.write('ready');setTimeout(()=>{},2000)", {
      stdin: "ignore",
    });
    await readyCommand(command);
    const oldPid = host.pid!;
    process.kill(oldPid, "SIGKILL");
    await expect(command).rejects.toMatchObject({ code: "ERR_SPAWN_BROKER_UNAVAILABLE" });
    await host.ready();
    const result = await start("process.stdout.write(String(process.ppid))", { stdin: "ignore" });
    expect(Number(result.stdout)).toBe(host.pid);
    expect(host.pid).not.toBe(oldPid);
  });

  it.runIf(process.platform === "linux").each([
    { name: "adjusted", enabled: true, missing: false },
    { name: "opt-out", enabled: false, missing: false },
    { name: "failed launch", enabled: true, missing: true },
  ])("restores the broker OOM score after $name", async ({ enabled, missing }) => {
    const scorePath = `/proc/${host.pid}/oom_score_adj`;
    const original = await readFile(scorePath, "utf8");
    const prepared = prepareOomScoreAdjustedSpawn(
      missing ? "/openclaw-nonexistent-oom-command" : "/bin/cat",
      missing ? [] : ["/proc/self/oom_score_adj"],
      { env: { ...process.env, OPENCLAW_CHILD_OOM_SCORE_ADJ: enabled ? "1" : "0" } },
    );
    const child = host.spawn(prepared.command, prepared.args, {
      env: prepared.env,
      stdio: missing ? "ignore" : ["ignore", "pipe", "ignore"],
    });
    if (missing) {
      await expect(child.ready()).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await child.ready();
      const output = text(child.stdout!);
      expect(await once(child, "close")).toEqual([0, null]);
      expect((await output).trim()).toBe(enabled ? "1000" : original.trim());
      expect(child.spawnfile).toBe("/bin/cat");
    }
    expect(await readFile(scorePath, "utf8")).toBe(original);
  });

  it.each(["buffered", "adapter"])("routes %s commands through the broker", async (transport) => {
    await runWithSpawnBroker(host, async () => {
      const argv = nodeArgv("process.stdout.write(String(process.ppid))");
      if (transport === "buffered") {
        const result = await runCommandBuffered(argv);
        expect(result.termination).toBe("exit");
        expect(Number(result.stdout.toString())).toBe(host.pid);
      } else {
        const { adapter, ready } = await createChildAdapter({
          argv,
          stdinMode: "pipe-closed",
          exactEnv: true,
        });
        let output = "";
        adapter.onStdout((chunk) => {
          output += chunk;
        });
        const result = await ready.then(() => adapter.wait()).finally(() => adapter.dispose());
        expect(result).toEqual({ code: 0, signal: null });
        expect(Number(output)).toBe(host.pid);
      }
    });
  });

  it("preserves runExec launch error metadata across asynchronous readiness", async () => {
    const command = "/openclaw-nonexistent-spawn-broker-command";
    const run = () => runExec(command, [], { logOutput: false }).catch((error: unknown) => error);
    const local = await run();
    const remote = await runWithSpawnBroker(host, run);
    expect(local).toBeInstanceOf(Error);
    const message = (local as Error).message;
    expect(remote).toMatchObject({ code: "ENOENT", failed: true, stdout: "", stderr: "", message });
  });

  describe("brokered process lifecycle owners", () => {
    aroundEach((runTest) => runWithSpawnBroker(host, runTest));

    it("forwards the ownedWorker start gate and disconnect through the broker", async ({
      signal,
    }) => {
      const response = createDeferredCore<unknown>();
      const { adapter, ready } = await createChildAdapter({
        argv: [
          process.execPath,
          "-e",
          `
          process.once('message',()=>process.send({ppid:process.ppid}));
          process.once('disconnect',()=>process.exit(0));
        `,
        ],
        ownedWorker: true,
        exactEnv: true,
        stdinMode: "pipe-closed",
        onWorkerMessage: response.resolve,
      });
      adapter.onStdout(() => {});
      adapter.onStderr(() => {});
      try {
        await ready;
        await adapter.openStartGate?.();
        await expect(
          withinTest(
            awaitGateBeforeSettlement(
              response.promise,
              adapter.wait(),
              "worker settled before acknowledging its start gate",
            ),
            signal,
          ),
        ).resolves.toEqual({ ppid: host.pid });
        adapter.closeStartGate?.();
        await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
      } finally {
        adapter.kill("SIGKILL");
        adapter.dispose();
      }
    });
  });
});
