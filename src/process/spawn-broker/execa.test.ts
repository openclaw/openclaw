import { readFile } from "node:fs/promises";
import path from "node:path";
import { serialize } from "node:v8";
import { execa, type Options } from "execa";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { BrokerChild } from "./child.js";
import { brokerExecaOptions, spawnBrokerCommand } from "./execa-client.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("broker execa parity", () => {
  let host: SpawnBrokerHost;
  beforeAll(async () => {
    host = createSpawnBrokerHost();
    await host.ready();
  });
  afterAll(async () => {
    await host.close();
  });

  function start(source: string, options: Options, broker: boolean) {
    const argv = [process.execPath, "-e", source];
    if (!broker) {
      return execa(argv[0]!, argv.slice(1), options);
    }
    const prepared = brokerExecaOptions(options);
    if (!prepared) {
      throw new Error("Fixture unexpectedly selected an in-process transport");
    }
    return spawnBrokerCommand(host, argv, options, prepared);
  }

  const cases = [
    { name: "success", source: "process.stdout.write('out\\n');process.stderr.write('err\\n')" },
    { name: "exit code", source: "process.stdout.write('partial');process.exitCode=7" },
    {
      name: "binary diagnostics",
      source:
        "process.stdout.write(Buffer.from([239,187,191,0,8,9,13,27,91,51,49,109,65,27,91,48,109,255,10]));process.stderr.write('failure\\r\\n');process.exitCode=3",
    },
    {
      name: "Unicode diagnostics",
      source:
        "process.stdout.write('漢字\\u2028\\u007f\\u0001\\n');process.stderr.write('failure\\n');process.exitCode=4",
      options: { encoding: "utf8" as const },
    },
    { name: "signal", source: "process.kill(process.pid,'SIGTERM')" },
    { name: "timeout", source: "setInterval(()=>{},1000)", options: { timeout: 100 } },
    {
      name: "maxBuffer",
      source: "process.stdout.write('x'.repeat(8192))",
      options: { maxBuffer: 128 },
    },
    {
      name: "cancel",
      source: "process.stdout.write('ready');setInterval(()=>{},1000)",
      cancel: true,
    },
    {
      name: "forced cancel",
      source: "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
      cancel: true,
    },
  ];

  it.each(cases)("preserves buffered $name results and errors", async (fixture) => {
    const outcomes: unknown[] = [];
    for (const broker of [false, true]) {
      const controller = new AbortController();
      const command = start(
        fixture.source,
        {
          encoding: "buffer",
          stdin: "ignore",
          stripFinalNewline: false,
          forceKillAfterDelay: 50,
          cancelSignal: controller.signal,
          ...fixture.options,
        },
        broker,
      );
      if (command.nodeChildProcess instanceof BrokerChild) {
        await command.nodeChildProcess.ready();
      }
      if (fixture.cancel) {
        command.stdout?.once("data", () => controller.abort());
      }
      const result = await command.then(
        (value) => value,
        (error: unknown) => error,
      );
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
  });

  it.each([false, true])(
    "preserves both output streams and stdin beyond 1 MiB with buffer:%s",
    async (buffer) => {
      const size = 1024 * 1024 + 137;
      const prefix = "broker input\n";
      const command = start(
        `const input=[];process.stdin.on('data',b=>input.push(b));process.stdin.on('end',()=>{const prefix=Buffer.concat(input);for(const stream of [process.stdout,process.stderr]){stream.write(prefix);for(let i=0;i<${size};i+=4096){const count=Math.min(4096,${size}-i);stream.write(Buffer.alloc(count,(i/4096)%251));}}});`,
        {
          buffer,
          input: prefix,
          encoding: "buffer",
          maxBuffer: 2 * 1024 * 1024,
          stripFinalNewline: false,
        },
        true,
      );
      const child = command.nodeChildProcess;
      if (!(child instanceof BrokerChild)) {
        throw new Error("Fixture did not use the broker");
      }
      await child.ready();
      const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      command.stdout?.on("data", (chunk: Buffer) => chunks.stdout.push(chunk));
      command.stderr?.on("data", (chunk: Buffer) => chunks.stderr.push(chunk));
      const result = await command;
      const expected = Buffer.concat([
        Buffer.from(prefix),
        Buffer.from(Array.from({ length: size }, (_, index) => Math.floor(index / 4096) % 251)),
      ]);
      for (const name of ["stdout", "stderr"] as const) {
        expect(Buffer.concat(chunks[name])).toEqual(expected);
        if (buffer) {
          expect(Buffer.from(result[name] as Uint8Array)).toEqual(expected);
        }
      }
      expect(result.exitCode).toBe(0);
    },
  );

  it("drains buffered results larger than one IPC frame when callers only await", async () => {
    const command = start(
      "process.stdout.write('x'.repeat(17*1024*1024))",
      {
        encoding: "buffer",
        stdin: "ignore",
        stderr: "ignore",
        maxBuffer: 18 * 1024 * 1024,
      },
      true,
    );
    const result = await command;
    expect(result.stdout).toHaveLength(17 * 1024 * 1024);
  });

  it.each(["buffer", "utf8"] as const)(
    "carries failed %s output only once on the wire",
    async (encoding) => {
      const size = 1024 * 1024;
      const remote = host.spawnExeca(
        [
          process.execPath,
          "-e",
          `process.stdout.write('x'.repeat(${size}));process.stderr.write('y'.repeat(${size}));process.exitCode=7`,
        ],
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
    },
  );

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
      true,
    );
    expect(await readFile(file, "utf8")).toBe("file bytes");
    expect(result).toBeInstanceOf(Error);
    expect(result.exitCode).toBe(9);
    expect(result.stderr).toBe("failure");
  });

  it("preserves launch errors and cancellation during broker admission", async () => {
    for (const buffer of [false, true]) {
      const options = { buffer, stdin: "ignore", reject: false } as const;
      const prepared = brokerExecaOptions(options)!;
      const missing = await spawnBrokerCommand(
        host,
        ["openclaw-broker-nonexistent-command"],
        options,
        prepared,
      );
      expect(missing).toBeInstanceOf(Error);
      expect(missing).toMatchObject({ failed: true, code: "ENOENT" });
    }
    const controller = new AbortController();
    controller.abort();
    const canceled = await start(
      "setInterval(()=>{},1000)",
      {
        input: Buffer.alloc(2 * 1024 * 1024),
        reject: false,
        cancelSignal: controller.signal,
      },
      true,
    );
    expect(canceled).toBeInstanceOf(Error);
    expect(canceled).toMatchObject({ failed: true, isCanceled: true });
  });

  it("fails in-flight commands on broker loss and resumes in the next broker", async () => {
    const command = start(
      "process.stdout.write('ready');setTimeout(()=>{},2000)",
      { stdin: "ignore" },
      true,
    );
    const child = command.nodeChildProcess;
    if (!(child instanceof BrokerChild)) {
      throw new Error("Fixture did not use the broker");
    }
    await child.ready();
    const oldPid = host.pid!;
    process.kill(oldPid, "SIGKILL");
    await expect(command).rejects.toMatchObject({ code: "ERR_SPAWN_BROKER_UNAVAILABLE" });
    await host.ready();
    const result = await start(
      "process.stdout.write(String(process.ppid))",
      { stdin: "ignore" },
      true,
    );
    expect(Number(result.stdout)).toBe(host.pid);
    expect(host.pid).not.toBe(oldPid);
  });
});
