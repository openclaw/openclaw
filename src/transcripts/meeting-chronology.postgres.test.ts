import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { ChronologyProof } from "./meeting-chronology.postgres.test-support.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const fixture = createFixtureLifetime();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await fixture.cleanup();
    cleanup();
  }),
);

describe.skipIf(!connection)("PostgreSQL meeting chronology", () => {
  it("ensures eager schema, refuses unknown tables, and filters and pages persisted instants", ({
    signal,
  }) =>
    fixture.run(async () => {
      if (!connection) {
        throw new Error("PostgreSQL conformance connection is unavailable");
      }
      const pathname = path.join(tempDirs.make("meeting-chronology-postgres-"), "state.sqlite");
      const url = resolveRuntimeWorkerUrl({
        currentModuleUrl: import.meta.url,
        sourceWorkerName: "meeting-chronology.postgres.test-support",
        distWorkerPath: "transcripts/meeting-chronology.postgres.test-support.js",
      });
      // The native parent owns anchor descriptors; the proof still executes in its worker.
      const child = fork(fileURLToPath(url), [], {
        execArgv: resolveRuntimeWorkerArgv(url).slice(0, -1),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        signal,
      });
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      let namespace: string | undefined;
      try {
        const result = await new Promise<ChronologyProof>((resolve, reject) => {
          let proof: ChronologyProof | { error: string } | undefined;
          child.on(
            "message",
            (message: ChronologyProof | { error: string } | { namespace: string }) => {
              if ("namespace" in message) {
                namespace = message.namespace;
              } else {
                proof = message;
              }
            },
          );
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code !== 0 || !proof) {
              reject(new Error(`Meeting chronology host exited ${code} without a result`));
            } else if ("error" in proof) {
              reject(new Error(proof.error));
            } else {
              resolve(proof);
            }
          });
          child.send({ path: pathname, connection }, (error) => {
            if (error) {
              reject(error);
            }
          });
        });
        expect(result.threadId).not.toBe(0);
        expect(result.list).toEqual([
          "later",
          "tie-a-iso",
          "tie-a-offset",
          "tie-b",
          "older",
          "invalid-a",
          "invalid-b",
        ]);
        expect(result.filtered).toEqual(["tie-a-iso", "tie-a-offset", "tie-b"]);
        expect(result.invalidFilter).toEqual([]);
        expect(result.pages).toEqual([
          { selectors: ["later", "tie-a-iso"], hasMore: true },
          { selectors: ["tie-a-offset", "tie-b"], hasMore: true },
          { selectors: ["older", "invalid-a"], hasMore: true },
          { selectors: ["invalid-b"], hasMore: false },
        ]);
        expect(result.retainedInstant).toBe(1704067200000);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
        await closed;
        if (namespace) {
          const client = new pg.Client({ connectionString: connection });
          await client.connect();
          try {
            await client.query(
              `DROP SCHEMA IF EXISTS "${namespace.replaceAll('"', '""')}" CASCADE`,
            );
          } finally {
            await client.end();
          }
        }
      }
    }));
});
