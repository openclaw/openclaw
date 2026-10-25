import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
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
          message: "Spawn broker cleanup did not complete",
          errors: [
            {
              code: "ERR_SPAWN_BROKER_UNAVAILABLE",
              message: "Spawn broker shutdown failed",
              cause: {
                code: "NODE_RUNTIME_UNAVAILABLE",
                message,
              },
            },
          ],
        });
      });
    }
    const healthyHost = createSpawnBrokerHost();
    try {
      await healthyHost.ready();
    } finally {
      await healthyHost.close();
    }
  },
);
