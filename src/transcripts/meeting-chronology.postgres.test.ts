import { fork } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterEach, expect, it } from "vitest";
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

it.skipIf(!connection)("ensures schema and paginates PostgreSQL chronology", ({ signal }) =>
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
    const messages: Array<ChronologyProof | { error: string } | { namespace: string }> = [];
    child.on("message", (message: (typeof messages)[number]) => messages.push(message));
    try {
      const [[code]] = await Promise.all([
        once(child, "exit"),
        new Promise<void>((resolve, reject) => {
          child.send({ path: pathname, connection }, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
      ]);
      const result = messages.findLast((message) => !("namespace" in message));
      if (code !== 0 || !result) {
        throw new Error(`Meeting chronology host exited ${code} without a result`);
      }
      if ("error" in result) {
        throw new Error(result.error);
      }
      const { threadId, ...proof } = result;
      expect(threadId).not.toBe(0);
      expect(proof).toEqual({
        list: "later tie-a-iso tie-a-offset tie-b older invalid-a invalid-b".split(" "),
        filtered: ["tie-a-iso", "tie-a-offset", "tie-b"],
        invalidFilter: [],
        pages: [
          { selectors: ["later", "tie-a-iso"], hasMore: true },
          { selectors: ["tie-a-offset", "tie-b"], hasMore: true },
          { selectors: ["older", "invalid-a"], hasMore: true },
          { selectors: ["invalid-b"], hasMore: false },
        ],
        retainedInstant: 1704067200000,
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      await closed;
      const namespace = messages.findLast((message) => "namespace" in message)?.namespace;
      if (namespace) {
        const client = new pg.Client({ connectionString: connection });
        await client.connect();
        try {
          await client.query(`DROP SCHEMA IF EXISTS "${namespace.replaceAll('"', '""')}" CASCADE`);
        } finally {
          await client.end();
        }
      }
    }
  }),
);
