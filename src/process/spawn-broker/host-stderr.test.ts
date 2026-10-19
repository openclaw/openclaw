import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSqliteReadOnlyWorkerSession } from "../../infra/sqlite-readonly-worker-session.js";
import { createSpawnBrokerHost } from "./host.js";
import { SpawnBrokerError } from "./protocol.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32")(
  "classifies loader stderr transferred after a read-only session is constructed",
  async () => {
    const executable = process.execPath;
    const host = createSpawnBrokerHost();
    let session: ReturnType<typeof createSqliteReadOnlyWorkerSession> | undefined;
    try {
      await host.ready();
      const brokenRuntime = path.join(tempDirs.make("openclaw-broker-reader-runtime-"), "node");
      await writeFile(
        brokenRuntime,
        '#!/bin/sh\necho "node: error while loading shared libraries: libfixture.so: cannot open shared object file" >&2\nexit 127\n',
        { mode: 0o700 },
      );
      process.execPath = brokenRuntime;
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
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) {
        throw new Error("Expected recorded broker shutdown failure");
      }
      const failure = error.errors.find(
        (entry: unknown): entry is SpawnBrokerError => entry instanceof SpawnBrokerError,
      );
      expect(failure?.message).toBe("Spawn broker shutdown failed");
      const cause = failure?.cause;
      if (!(cause instanceof Error)) {
        throw new Error("Expected broker exit error as shutdown cause");
      }
      const message = cause.message;
      expect(message).toContain("exited with code=1 signal=none");
      expect(message).toContain("🦞 Spawn broker cleanup failed: synthetic cleanup failure");
      expect(message).toContain("password=");
      expect(message).not.toContain("synthetic-password-value");
      expect(message).not.toContain("discarded-prefix");
      expect(message).not.toContain("\uFFFD");
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
    const executable = process.execPath;
    const brokenRuntime = path.join(tempDirs.make("openclaw-broker-runtime-"), "node");
    await writeFile(
      brokenRuntime,
      '#!/bin/sh\necho "dyld[123]: Library not loaded: /fixture/libsimdutf.dylib" >&2\nexit 134\n',
      { mode: 0o700 },
    );
    if (kind === "permission") {
      await chmod(brokenRuntime, 0o600);
    }
    let host: ReturnType<typeof createSpawnBrokerHost> | undefined;
    try {
      process.execPath = brokenRuntime;
      host = createSpawnBrokerHost();
      await expect(host.ready()).rejects.toThrow(
        `The Node.js runtime this Gateway started with (${brokenRuntime}) can no longer start worker processes`,
      );
      await expect(host.ready()).rejects.toThrow("Restart the Gateway.");
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
                message: `The Node.js runtime this Gateway started with (${brokenRuntime}) can no longer start worker processes, likely because it was upgraded or removed. Restart the Gateway.`,
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
