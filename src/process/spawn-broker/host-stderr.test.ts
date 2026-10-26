import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createSqliteReadOnlyWorkerSession } from "../../infra/sqlite-readonly-worker-session.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { spawnBrokerContextEntrypoints } from "./context-runtime.test-support.js";
import { createSpawnBrokerHost } from "./host.js";
import { SpawnBrokerError } from "./protocol.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const executable = process.execPath;
async function brokenRuntime(diagnostic: string, mode = 0o700, exit = 134) {
  const runtime = path.join(tempDirs.make("openclaw-broker-runtime-"), "node");
  await writeFile(runtime, `#!/bin/sh\necho "${diagnostic}" >&2\nexit ${exit}\n`, { mode });
  return runtime;
}

it.skipIf(process.platform === "win32")(
  "classifies loader stderr transferred after a read-only session is constructed",
  async () => {
    const host = createSpawnBrokerHost();
    let session: ReturnType<typeof createSqliteReadOnlyWorkerSession> | undefined;
    try {
      await host.ready();
      process.execPath = await brokenRuntime(
        "node: error while loading shared libraries: libfixture.so: cannot open shared object file",
        0o700,
        127,
      );
      session = createSqliteReadOnlyWorkerSession({
        env: {},
        cwd: process.cwd(),
        transport: { kind: "broker", owner: host },
        argv: [],
        retainLifetime: false,
        requestArgs: () => [],
        readBudget: () => ({ timeoutMs: 5_000, size: "fixture" }),
        deadlineOwnedByCaller: () => true,
        timeoutError: () => new Error("unexpected timeout"),
        closeTimeoutMs: 5_000,
      });
      await expect(session.run("fixture", { mode: "staging-create" })).rejects.toMatchObject({
        code: "NODE_RUNTIME_UNAVAILABLE",
        message: expect.stringContaining("Restart the Gateway."),
      });
    } finally {
      try {
        await session?.close();
      } finally {
        process.execPath = executable;
        await host.close();
      }
    }
  },
);

it.each([undefined, true] as const)(
  "retains bounded, redacted UTF-8 stderr on shutdown (native resources: %s)",
  async (nativeResources) => {
    const worker = path.join(tempDirs.make("openclaw-broker-stderr-"), "worker.mjs");
    await writeFile(
      worker,
      `
        let stopping = false;
        function shutdown() {
          if (stopping) return;
          stopping = true;
          process.exitCode = 1;
          // More than a pipe buffer: shutdown cannot finish unless the host drains it.
          process.stderr.write('discarded-prefix\\n' + '🦞'.repeat(256 * 1024), () => {
            const tail = Buffer.from('🦞 Spawn broker cleanup failed: synthetic cleanup failure password=synthetic-password-value\\n');
            process.stderr.write(tail.subarray(0, 1), () => {
              setImmediate(() => process.stderr.end(tail.subarray(1), () => {
                if (process.connected) process.disconnect();
              }));
            });
          });
        }
        process.on('message', message => {
          if (message.type === 'bootstrap') process.send({type: 'ready', pid: process.pid});
          if (message.type === 'shutdown') shutdown();
        });
        process.once('disconnect', shutdown);
      `,
    );
    const host = createSpawnBrokerHost({ workerUrl: pathToFileURL(worker), nativeResources });
    try {
      await host.ready();
      const error: unknown = await host.close().catch((failure: unknown) => failure);
      assert(error instanceof AggregateError, "Expected recorded broker shutdown failure");
      const failure = error.errors.find(
        (entry: unknown): entry is SpawnBrokerError => entry instanceof SpawnBrokerError,
      );
      expect(failure?.message).toBe("Spawn broker shutdown failed");
      const cause = failure?.cause;
      assert(cause instanceof Error, "Expected broker exit error as shutdown cause");
      const message = cause.message;
      expect(message).toContain("exited with code=1 signal=none");
      expect(message).toContain("🦞 Spawn broker cleanup failed: synthetic cleanup failure");
      expect(message).toContain("password=");
      expect(message).not.toMatch(/synthetic-password-value|discarded-prefix|\uFFFD/u);
      const tail = message.split("\nstderr:\n")[1];
      expect(tail).toBeDefined();
      expect(Buffer.byteLength(tail ?? "")).toBeLessThanOrEqual(2048);
    } finally {
      await host.close().catch(() => {});
    }
  },
);

it.skipIf(process.platform === "win32").each(["loader", "permission"])(
  "reports runtime %s failure before broker readiness and does not restart it",
  async (kind) => {
    const runtime = await brokenRuntime(
      "dyld[123]: Library not loaded: /fixture/libsimdutf.dylib",
      kind === "permission" ? 0o600 : 0o700,
    );
    const message = `The Node.js runtime this Gateway started with (${runtime}) can no longer start worker processes, likely because it was upgraded or removed. Restart the Gateway.`;
    let host: ReturnType<typeof createSpawnBrokerHost> | undefined;
    try {
      process.execPath = runtime;
      host = createSpawnBrokerHost();
      await expect(host.ready()).rejects.toThrow(message);
      await expect(host.ready()).rejects.toThrow(message);
    } finally {
      process.execPath = executable;
      await host?.close().catch((error: unknown) => {
        // Early bootstrap EPIPE can make the intentional loader exit arrive during close.
        expect(kind).toBe("loader");
        expect(error).toMatchObject({
          name: "AggregateError",
          errors: [
            {
              code: "ERR_SPAWN_BROKER_UNAVAILABLE",
              cause: { code: "NODE_RUNTIME_UNAVAILABLE", message },
            },
          ],
        });
      });
    }
  },
);

it.skipIf(process.platform === "win32").each(["exit", "timeout"] as const)(
  "logs first-start %s and keeps subsequent broker starts in-process",
  async (failure) => {
    const directory = tempDirs.make("openclaw-broker-startup-fallback-");
    const marker = path.join(directory, "attempts");
    const preload = path.join(directory, "exit-before-ready.mjs");
    await writeFile(
      preload,
      `
      import {appendFileSync} from 'node:fs';
      if (/\\/spawn-broker\\/worker\\.(?:ts|js)$/.test(process.argv[1] ?? '')) {
        appendFileSync(${JSON.stringify(marker)}, 'attempt\\n');
        ${failure === "exit" ? "process.exit(73);" : "process.on('message',()=>{}); await new Promise(()=>{});"}
      }
    `,
    );
    const execUrl = resolveRuntimeWorkerUrl(spawnBrokerContextEntrypoints.exec).href;
    const contextUrl = resolveRuntimeWorkerUrl(spawnBrokerContextEntrypoints.context);
    const source = `
      import {existsSync,readFileSync,watch} from 'node:fs';
      import {mock} from 'node:test';
      const state = {parents:[],brokers:[],errors:[]};
      process.env.NODE_OPTIONS = ${JSON.stringify(`--import=${pathToFileURL(preload).href}`)};
      const realMonotonic = process.hrtime.bigint.bind(process.hrtime);
      let startupClockOffset = 0n;
      // The broker captures its clock at import; advance it with the startup timer below.
      const monotonic = ${failure === "timeout"}
        ? mock.method(process.hrtime, 'bigint', () => realMonotonic() + startupClockOffset)
        : undefined;
      const {startGatewaySpawnBroker} = await import(${JSON.stringify(contextUrl.href)});
      const {runExec} = await import(${JSON.stringify(execUrl)});
      let attemptWatcher;
      try {
        const attempted = ${failure === "timeout"} ? new Promise((resolve,reject) => {
          const observe = () => {
            if (existsSync(${JSON.stringify(marker)}) && readFileSync(${JSON.stringify(marker)},'utf8').trim()) resolve();
          };
          attemptWatcher = watch(${JSON.stringify(directory)}, observe);
          attemptWatcher.on('error', reject);
          observe();
        }) : undefined;
        if (attempted) mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
        for (let count=0;count<2;count++) {
          const starting = startGatewaySpawnBroker({
            onReady() { throw new Error('Failed broker reported readiness'); },
            onStartupFailure(message) { state.errors.push(message); }
          });
          if (attempted && count === 0) {
            await Promise.race([attempted, starting.then(() => {
              throw new Error('Broker started before the readiness deadline');
            })]);
            attemptWatcher.close();
            startupClockOffset += 15_000_000_000n;
            mock.timers.tick(15_000);
          }
          const broker = await starting;
          state.brokers.push(broker?.pid ?? null);
          state.parents.push(Number((await runExec(process.execPath,['-e','console.log(process.ppid)'],{logOutput:false})).stdout));
        }
        console.log(JSON.stringify({...state,hostPid:process.pid,attempts:readFileSync(${JSON.stringify(marker)},'utf8').trim().split('\\n').length}));
      } finally {
        attemptWatcher?.close();
        mock.timers.reset();
        monotonic?.mock.restore();
      }
    `;
    const node = resolveTestNodeExecPath();
    const result = spawnSync(
      node,
      [
        ...resolveRuntimeWorkerArgv(contextUrl, node).slice(0, -1),
        "--input-type=module",
        "--eval",
        source,
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed).toMatchObject({
      attempts: 1,
      brokers: [null, null],
      parents: Array(2).fill(observed.hostPid),
    });
    expect(observed.errors).toHaveLength(1);
    expect(observed.errors[0]).toMatch(/before readiness|before becoming ready/);
    expect(observed.errors[0]).toContain(
      fileURLToPath(resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.spawnBroker)),
    );
    if (failure === "timeout") {
      expect(observed.errors[0]).toContain("readiness deadline exceeded");
    }
    expect(observed.errors[0]).toContain("in-process spawning");
    expect(observed.errors[0]).not.toMatch(/[\r\n]/);
  },
  35_000,
);
