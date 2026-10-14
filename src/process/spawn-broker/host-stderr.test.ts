import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSpawnBrokerHost } from "./host.js";
import { SpawnBrokerError } from "./protocol.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
