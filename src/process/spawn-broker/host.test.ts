import { spawn, type SpawnOptions } from "node:child_process";
import { once, type EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import type { SpawnInitiation } from "../spawn-initiation.js";
import { spawnAndWait } from "../spawn-utils.js";
import { runWithSpawnBroker } from "./context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";
import { SpawnBrokerError } from "./protocol.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const skipBrokerTests = !supportsSpawnBrokerCommandTransport();

function capture(stream: EventEmitter | null | undefined) {
  let output = "";
  stream?.on("data", (chunk) => {
    output += chunk;
  });
  return () => output;
}

async function runFixture(script: string, options: SpawnOptions, input?: string) {
  const child = spawn(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script],
    options,
  );
  const stdout = capture(child.stdout),
    stderr = capture(child.stderr);
  child.stdin?.end(input);
  const [code, signal] = await once(child, "close");
  return { code, signal, stdout: stdout(), stderr: stderr() };
}

const bootstrapModes = [
  "native",
  "stale-ambient",
  "send-throw",
  "send-callback",
  "child-disconnect",
] as const;

async function runBootstrapFixture(mode: (typeof bootstrapModes)[number]) {
  const script = `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import {once} from 'node:events';
    import {syncBuiltinESMExports} from 'node:module';
    import {mock} from 'node:test';
    const mode = ${JSON.stringify(mode)};
    const keys = ['OPENCLAW_SPAWN_RESOURCE_ENDPOINT', 'OPENCLAW_SPAWN_RESOURCE_SECRET', 'OPENCLAW_SPAWN_RESOURCE_GENERATION'];
    for (const key of keys) delete process.env[key];
    if (mode === 'stale-ambient') {
      process.env[keys[0]] = '/synthetic/stale/resource.sock';
      process.env[keys[1]] = 'synthetic-stale-value';
      process.env[keys[2]] = 'not-a-generation';
    }
    const originalSpawn = childProcess.spawn;
    let nativeChild;
    let environmentKeys;
    let bootstrapCalls = 0;
    let refused = 0;
    const events = [];
    const observed = mock.method(childProcess, 'spawn', function(command, args, options) {
      environmentKeys = keys.filter(key => key in (options.env ?? process.env));
      const child = Reflect.apply(originalSpawn, this, [command, args, options]);
      nativeChild = child;
      for (const event of ['spawn', 'exit', 'close']) child.once(event, () => events.push(event));
      const originalSend = child.send.bind(child);
      mock.method(child, 'send', function(message, ...args) {
        if (message?.type === 'bootstrap') {
          bootstrapCalls++;
          if (mode === 'stale-ambient') {
            assert.equal(message.nativeResource === undefined, true);
          }
          if (mode === 'send-throw') {
            refused++;
            throw new Error('synthetic initial bootstrap refusal');
          }
          if (mode === 'send-callback') {
            refused++;
            const callback = args.at(-1);
            assert.equal(typeof callback, 'function');
            queueMicrotask(() => callback(new Error('synthetic initial bootstrap refusal')));
            return false;
          }
        }
        return originalSend(message, ...args);
      });
      return child;
    });
    syncBuiltinESMExports();
    try {
      const {createSpawnBrokerHost} = await import(${JSON.stringify(new URL("./host.js", import.meta.url).href)});
      const host = createSpawnBrokerHost(mode === 'stale-ambient' ? {} : {nativeResources: true});
      assert.ok(nativeChild?.pid > 0);
      // The standalone fixture has no Gateway lifetime keeping an unreferenced broker alive.
      nativeChild.ref();
      nativeChild.channel?.ref();
      assert.equal(observed.mock.calls.length, 1);
      if (mode.startsWith('send-')) {
        await assert.rejects(host.ready(), error => error.cause?.message === 'synthetic initial bootstrap refusal');
      } else {
        await host.ready();
      }
      if (mode === 'child-disconnect') {
        const nativeClosures = new Set();
        nativeChild.on('message', message => {
          if (message?.type === 'closed') nativeClosures.add(message.id);
        });
        const command = host.spawn(process.execPath,
          ['-e', "process.on('disconnect', () => {}); process.send('ready');"],
          {stdio:['ignore','ignore','ignore','ipc'], serialization:'advanced'});
        const ready = once(command, 'message');
        await command.ready();
        assert.equal((await ready)[0], 'ready');
        command.disconnect();
        await command.waitForClose();
        const sibling = host.spawn(process.execPath, ['-e', 'process.exitCode=0'], {stdio:'ignore'});
        const siblingClosed = once(sibling, 'close');
        await sibling.ready();
        await siblingClosed;
        // IPC is ordered: native retirement precedes this later command's completion.
        assert.equal(nativeClosures.has(command.requestId), true,
          'broker native retirement receipt missing after parent IPC disconnect');
      }
      if (mode === 'stale-ambient') {
        const command = host.spawn(process.execPath, ['-e', 'process.exit(0)'], {stdio: 'ignore'});
        const commandClosed = once(command, 'close');
        await command.ready();
        const [code, signal] = await commandClosed;
        assert.deepEqual([code, signal], [0, null]);
      }
      await host.close();
      if (mode !== 'stale-ambient') {
        assert.deepEqual(environmentKeys, []);
        assert.equal(events[0], 'spawn');
        assert.equal(nativeChild.exitCode, 0);
        assert.equal(nativeChild.connected, false);
      }
      assert.ok(events.includes('exit'));
      assert.equal(bootstrapCalls, 1);
      assert.equal(refused, mode.startsWith('send-') ? 1 : 0);
      console.log('completed');
    } finally {
      if (nativeChild?.exitCode === null && nativeChild.signalCode === null) nativeChild.kill('SIGKILL');
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  `;
  // A failing bootstrap or close stays outside the shared broker afterEach cleanup.
  const { code, signal, stdout, stderr } = await runFixture(script, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
  expect({ code, signal }, stderr).toEqual({ code: 0, signal: null });
  expect(stdout.trim()).toBe("completed");
}

it.skipIf(process.platform === "win32").each(bootstrapModes)(
  "settles %s bootstrap and native close",
  runBootstrapFixture,
  20_000,
);

describe.skipIf(skipBrokerTests)("spawn broker native transport", () => {
  let host: SpawnBrokerHost;
  beforeEach(async () => {
    host = createSpawnBrokerHost();
    await host.ready();
  });
  afterEach(() => host?.close());
  function nodeCommand(source: string, options: SpawnOptions, initiate?: SpawnInitiation) {
    return host.spawn(process.execPath, ["-e", source], options, initiate);
  }
  async function expectParent(pid: number) {
    const child = nodeCommand("process.stdout.write(String(process.ppid))", {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await child.ready();
    const output = capture(child.stdout);
    expect(await once(child, "close")).toEqual([0, null]);
    expect(Number(output())).toBe(pid);
  }

  it("fences guarded launches and settles custody from native receipts", async () => {
    const marker = path.join(tempDirs.make("openclaw-broker-launch-"), "started");
    let current = true;
    const denied = host.spawn(
      process.execPath,
      ["-e", "require('node:fs').writeFileSync(process.argv[1], 'started')", marker],
      { stdio: "ignore" },
      (launch) => {
        if (!current) {
          throw new Error("launch authority revoked");
        }
        return launch();
      },
    );
    current = false;
    await expect(denied.ready()).rejects.toThrow("launch authority refused");
    expect(denied.pid).toBeUndefined();
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const admitted = createDeferredCore();
    const child = nodeCommand(
      "process.stdin.resume(); process.stdin.once('end', () => process.exit(0))",
      { stdio: ["pipe", "ignore", "ignore"] },
      (launch, settlement) => {
        if (!settlement) {
          throw new Error("Missing native launch settlement");
        }
        void settlement.then(() => admitted.resolve(), admitted.reject);
        return launch();
      },
    );
    await admitted.promise;
    expect(child.exitCode).toBeNull();
    await child.ready();
    const closed = once(child, "close");
    child.stdin!.end();
    expect(await closed).toEqual([0, null]);

    const grantReached = createDeferredCore<{ settlement: Promise<unknown> }>();
    let pausedPid: number | undefined;
    const failed = nodeCommand("process.exit(0)", { stdio: "ignore" }, (launch, settlement) => {
      if (!settlement || !host.pid) {
        throw new Error("Missing native launch settlement");
      }
      pausedPid = host.pid;
      process.kill(pausedPid, "SIGSTOP");
      try {
        const dispatched = launch();
        failed.fail(new Error("synthetic local proxy failure"));
        grantReached.resolve({ settlement });
        return dispatched;
      } catch (error) {
        process.kill(pausedPid, "SIGCONT");
        pausedPid = undefined;
        throw error;
      }
    });
    const locallyFailed = expect(failed.ready()).rejects.toThrow("synthetic local proxy failure");
    const { settlement } = await grantReached.promise;
    let settled = false;
    void settlement.then(() => {
      settled = true;
    });
    try {
      await locallyFailed;
      // Drain host promise reactions while the exact native peer cannot publish a receipt.
      await nextTurn();
      expect(settled).toBe(false);
    } finally {
      if (pausedPid) {
        process.kill(pausedPid, "SIGCONT");
      }
    }
    await settlement;
  });

  it.each(["coalesced", "later"])("orders native lifecycle events for %s exits", async (timing) => {
    const argv =
      timing === "coalesced"
        ? [process.platform === "darwin" ? "/usr/bin/true" : "/bin/true"]
        : [process.execPath, "-e", "setTimeout(()=>process.exit(0),50)"];
    const starting = runWithSpawnBroker(host, () =>
      spawnAndWait({ argv, options: { stdio: "ignore" } }),
    );
    await Promise.resolve();
    if (timing === "coalesced") {
      const resumeAt = performance.now() + 20;
      while (performance.now() < resumeAt) {
        /* Batch the broker's native lifecycle messages. */
      }
    }
    const child = await starting;
    await Promise.resolve();
    await Promise.resolve();
    const events: string[] = [];
    for (const event of ["exit", "close"]) {
      child.on(event, () => events.push(event));
    }
    expect(child.exitCode).toBe(null);
    const [code] = await once(child, "close", { signal: AbortSignal.timeout(1000) });
    await delay(0);
    expect(code).toBe(0);
    expect(child.exitCode).toBe(0);
    expect(events).toEqual(["exit", "close"]);
  });

  it("preserves raw-spawn identity, independent output streams, and stdin", async () => {
    const size = 2 * 1024 * 1024 + 137;
    const argv0 = "openclaw-broker-command";
    const args = [
      "-e",
      `
      process.stdin.resume(); let input = '';
      process.stdin.on('data', x => input += x);
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({parent:process.ppid,argv0:process.argv0}) + '\\n' + input + 'o'.repeat(${size}));
        process.stderr.write('e'.repeat(${size}));
      });
    `,
    ];
    const child = host.spawn(process.execPath, args, { argv0, stdio: ["pipe", "pipe", "pipe"] });
    await child.ready();
    expect(child).toMatchObject({ spawnfile: process.execPath, spawnargs: [argv0, ...args] });
    const stdout = capture(child.stdout),
      stderr = capture(child.stderr);
    child.stdin!.end("input-prefix:");
    await once(child, "close");
    const newline = stdout().indexOf("\n");
    expect(JSON.parse(stdout().slice(0, newline))).toEqual({ parent: host.pid, argv0 });
    expect(host.pid).not.toBe(process.pid);
    expect(stdout().slice(newline + 1)).toBe("input-prefix:" + "o".repeat(size));
    expect(stderr()).toBe("e".repeat(size));
  });

  it("preserves real inherited stdin across the host and broker", async () => {
    const input = "inherited-input:".repeat(32_000);
    for (const brokered of [false, true]) {
      const script = `
        import {spawn} from 'node:child_process';
        import {once} from 'node:events';
        import {createSpawnBrokerHost} from ${JSON.stringify(new URL("./host.js", import.meta.url).href)};
        const broker = ${brokered} ? createSpawnBrokerHost() : undefined;
        await broker?.ready();
        const args = ['-e','process.stdin.pipe(process.stdout)'];
        const options = {stdio:['inherit','pipe','pipe']};
        const child = broker ? broker.spawn(process.execPath,args,options) : spawn(process.execPath,args,options);
        if (broker) await child.ready();
        child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
        await once(child,'close'); await broker?.close();
      `;
      expect(await runFixture(script, { stdio: ["pipe", "pipe", "pipe"] }, input)).toEqual({
        code: 0,
        signal: null,
        stdout: input,
        stderr: "",
      });
    }
  });

  it("forwards child IPC and retains separate extra pipes", async () => {
    const child = nodeCommand(
      `
      const fs = require('node:fs');
      process.on('message', value => {
        fs.writeSync(3, 'private-pipe');
        process.send(value, () => process.disconnect());
      });
    `,
      { stdio: ["ignore", "pipe", "pipe", "pipe", "ipc"] },
    );
    await child.ready();
    const extra = capture(child.stdio[3]);
    const message = once(child, "message");
    const closed = once(child, "close");
    await new Promise<void>((resolve, reject) => {
      child.send({ hello: "broker" }, (error) => (error ? reject(error) : resolve()));
    });
    expect((await message)[0]).toEqual({ hello: "broker" });
    await closed;
    expect(extra()).toBe("private-pipe");
    expect(child.connected).toBe(false);
  });

  for (const output of ["ignore", "pipe"] as const) {
    it(
      "settles parent IPC disconnect (" + output + ")",
      async ({ signal }) => {
        const child = nodeCommand(
          "process.on('disconnect', () => { process.stdout.end('stdout-tail'); process.stderr.end('stderr-tail'); }); process.send('ready');",
          { stdio: ["ignore", output, output, "ipc"], serialization: "advanced" },
        );
        const ready = once(child, "message");
        await child.ready();
        // Native streams arrive with the spawn receipt, before lifecycle messages are released.
        const stdout = capture(child.stdout),
          stderr = capture(child.stderr);
        expect((await ready)[0]).toBe("ready");
        const exited = once(child, "exit");
        child.disconnect();
        expect(await withinTest(exited, signal)).toEqual([0, null]);
        await withinTest(child.waitForClose(), signal);
        expect(child).toMatchObject({ exitCode: 0, signalCode: null, connected: false });
        expect(stdout()).toBe(output === "pipe" ? "stdout-tail" : "");
        expect(stderr()).toBe(output === "pipe" ? "stderr-tail" : "");
      },
      10_000,
    );
  }

  it.each(["SIGTERM", "SIGINT"] as const)(
    "finishes commands and cleanup after supervisor %s",
    async (signal) => {
      const brokerPid = host.pid!;
      const child = nodeCommand(
        `
          process.on('message', () => {
            process.send('completed', () => process.disconnect());
          });
          process.send('ready');
        `,
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      await child.ready();
      expect((await once(child, "message"))[0]).toBe("ready");

      process.kill(brokerPid, signal);
      const [message, closed] = await Promise.all([
        once(child, "message"),
        once(child, "close"),
        new Promise<void>((resolve, reject) => {
          child.send("finish", (error) => (error ? reject(error) : resolve()));
        }),
      ]);
      expect(message[0]).toBe("completed");
      expect(closed).toEqual([0, null]);

      await expectParent(brokerPid);
      expect(host.pid).toBe(brokerPid);
    },
    15_000,
  );

  it("cleans a detached descendant after its root exits and the host disconnects", async ({
    signal,
  }) => {
    const child = nodeCommand(
      `
      const {spawn}=require('node:child_process');
      const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
      process.stdout.write(String(descendant.pid),()=>process.exit(0));
    `,
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    await child.ready();
    const pidOutput = once(child.stdout!, "data");
    const stdout = capture(child.stdout);
    await Promise.all([once(child, "exit"), pidOutput]);
    const descendant = Number(stdout());
    try {
      await withinTest(host.close(), signal);
      const running = async () => {
        try {
          process.kill(descendant, 0);
          if (process.platform === "linux") {
            const stat = await readFile(`/proc/${descendant}/stat`, "utf8");
            return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
          }
          return true;
        } catch (error) {
          if (hasErrnoCode(error, "ESRCH") || hasErrnoCode(error, "ENOENT")) {
            return false;
          }
          throw error;
        }
      };
      // Broker shutdown signals the orphaned group but cannot join this foreign PID.
      while (await running()) {
        await withinTest(delay(25), signal).catch((cause: unknown) => {
          throw new Error(`Detached descendant ${descendant} is still running`, { cause });
        });
      }
      expect(await running()).toBe(false);
    } finally {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {}
    }
  }, 15_000);

  it("fails in-flight commands on broker loss and restarts without local spawning", async () => {
    const previousPid = host.pid!;
    const child = nodeCommand(
      `
      let stopping = false;
      process.on('SIGTERM', () => {
        if (!stopping) {
          stopping = true;
          setTimeout(() => process.exit(0), 2000);
        }
      });
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `,
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await child.ready();
    expect(String((await once(child.stdout!, "data"))[0])).toBe("ready");
    const failure = new Promise<Error>((resolve) => {
      child.once("error", resolve);
    });
    try {
      process.kill(previousPid, "SIGKILL");
      expect(await failure).toBeInstanceOf(SpawnBrokerError);
      await expect(host.waitForCleanup()).resolves.toBeUndefined();
      expect(isPidDefinitelyDead(child.pid!)).toBe(true);
      await host.ready();
      expect(host.pid).not.toBe(previousPid);
      await expectParent(host.pid!);
    } finally {
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {}
    }
  });
});
