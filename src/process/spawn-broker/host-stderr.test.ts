import assert from "node:assert/strict";
import { existsSync, watch } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSqliteReadOnlyWorkerSession } from "../../infra/sqlite-readonly-worker-session.js";
import { createSpawnBrokerHost } from "./host.js";
import { SpawnBrokerError } from "./protocol.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const executable = process.execPath;
async function brokenRuntime(diagnostic: string, mode = 0o700, exit = 134) {
  const runtime = path.join(tempDirs.make("openclaw-broker-runtime-"), "node");
  await writeFile(runtime, `#!/bin/sh\necho "${diagnostic}" >&2\nexit ${exit}\n`, { mode });
  return runtime;
}

it.skipIf(process.platform === "win32").each(["loader", "permission", "session"] as const)(
  "classifies runtime failure at %s without restarting the broker",
  async (kind) => {
    const runtime = await brokenRuntime(
      "dyld[123]: Library not loaded: /fixture/libsimdutf.dylib",
      kind === "permission" ? 0o600 : 0o700,
    );
    let host: ReturnType<typeof createSpawnBrokerHost> | undefined;
    let session: ReturnType<typeof createSqliteReadOnlyWorkerSession> | undefined;
    try {
      if (kind !== "session") {
        process.execPath = runtime;
      }
      host = createSpawnBrokerHost();
      const failure = {
        code: "NODE_RUNTIME_UNAVAILABLE",
        message: `The Node.js runtime this Gateway started with (${runtime}) can no longer start worker processes, likely because it was upgraded or removed. Restart the Gateway.`,
      };
      if (kind === "session") {
        await host.ready();
        process.execPath = runtime;
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
        await expect(session.run("fixture", { mode: "staging-create" })).rejects.toMatchObject(
          failure,
        );
      } else {
        await expect(host.ready()).rejects.toMatchObject(failure);
        await expect(host.ready()).rejects.toMatchObject(failure);
      }
    } finally {
      try {
        await session?.close();
      } finally {
        process.execPath = executable;
        await host?.close().catch((error: unknown) => {
          expect(kind).toBe("loader");
          expect(error).toMatchObject({
            name: "AggregateError",
            errors: [
              {
                code: "ERR_SPAWN_BROKER_UNAVAILABLE",
                cause: {
                  code: "NODE_RUNTIME_UNAVAILABLE",
                  message: expect.stringContaining(runtime),
                },
              },
            ],
          });
        });
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

it.skipIf(process.platform === "win32").each(["exit", "timeout"] as const)(
  "logs first-start %s and keeps subsequent broker starts in-process",
  async (failure) => {
    const directory = tempDirs.make("openclaw-broker-startup-");
    const marker = path.join(directory, "attempts");
    const worker = path.join(directory, "worker.mjs");
    await writeFile(
      worker,
      'import {appendFileSync} from "node:fs"; appendFileSync(' +
        JSON.stringify(marker) +
        ',"attempt\\n");' +
        (failure === "exit"
          ? "process.exit(73);"
          : 'process.on("message",()=>{}); process.once("disconnect",()=>process.exit(0));'),
    );
    const watcher = watch(directory);
    const attempted = new Promise<void>((resolve, reject) => {
      watcher.on("change", () => {
        if (existsSync(marker)) {
          resolve();
        }
      });
      watcher.on("error", reject);
    });
    const hosts: ReturnType<typeof createSpawnBrokerHost>[] = [];
    try {
      vi.resetModules();
      const now = process.hrtime.bigint.bind(process.hrtime);
      let offset = 0n;
      vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now() + offset);
      const owner = await import("./host.js");
      const create = owner.createSpawnBrokerHost;
      vi.spyOn(owner, "createSpawnBrokerHost").mockImplementation((options) => {
        const host = create({ ...options, workerUrl: pathToFileURL(worker) });
        hosts.push(host);
        return host;
      });
      const context = await import("./context.js");
      const onReady = vi.fn();
      const onStartupFailure = vi.fn<(message: string) => void>();
      const options = { onReady, onStartupFailure };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const starting = expect(context.startGatewaySpawnBroker(options)).resolves.toBeUndefined();
      if (failure === "timeout") {
        await attempted;
        offset = 15_000_000_000n;
        await vi.advanceTimersByTimeAsync(15_000);
      }
      await starting;
      await expect(context.startGatewaySpawnBroker(options)).resolves.toBeUndefined();
      expect(hosts).toHaveLength(1);
      expect((await readFile(marker, "utf8")).trim()).toBe("attempt");
      expect(onReady).not.toHaveBeenCalled();
      expect(onStartupFailure).toHaveBeenCalledOnce();
      const message = onStartupFailure.mock.calls[0]![0];
      expect(message).toMatch(/before readiness|before becoming ready/);
      expect(message).toContain(worker);
      expect(message).toContain("in-process spawning");
      expect(message).not.toMatch(/[\r\n]/);
      if (failure === "timeout") {
        expect(message).toContain("readiness deadline exceeded");
      }
      const { runExec } = await import("../exec.js");
      const result = await context.runWithSpawnBroker(hosts[0], () =>
        runExec(process.execPath, ["-e", "console.log(process.ppid)"], { logOutput: false }),
      );
      expect(Number(result.stdout)).toBe(process.pid);
    } finally {
      watcher.close();
      vi.useRealTimers();
      await Promise.all(hosts.map((host) => host.close().catch(() => {})));
      vi.restoreAllMocks();
    }
  },
  35_000,
);
