import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runWithSqliteDatabaseAdmissionTurn } from "../../infra/sqlite-database-admission-turn.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionTranscriptReadPool } from "./session-transcript-read-pools.js";
import type {
  SessionEntryWorkerInput,
  SessionSqliteTargetWorkerInput,
} from "./session-transcript-worker-read.types.js";

function readWorkers(contexts: readonly unknown[]): Worker[] {
  return contexts.map((context) => {
    if (!(context instanceof Worker)) {
      throw new Error("Expected a real foreground Worker");
    }
    return context;
  });
}

it("preserves admitted schema when a session export reader exits", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const pool = createSessionTranscriptReadPool<SessionEntryWorkerInput>(1, true);
    const storePath = state.statePath("agents/main/sessions/sessions.json");
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    try {
      expect(
        await pool.run(
          {
            kind: "session-entry",
            absPath: state.statePath("agents/main/sessions/export.jsonl"),
            options: { agentId: "main", sessionId: "export", storePath },
          },
          {},
          { storePaths: [storePath], admissionPaths: [database.path] },
        ),
      ).toMatchObject({ ok: true, value: { entry: { content: "" } } });
      const schema = getAdmittedSqliteSchemaFacts(database.db);
      expect(schema).toBeDefined();
      const workers = new Set(readWorkers(posts.mock.contexts));
      expect(workers.size).toBeGreaterThan(0);
      await Promise.all([...workers].map((worker) => worker.terminate()));
      expect(getAdmittedSqliteSchemaFacts(database.db)?.admissionId).toBe(schema?.admissionId);
    } finally {
      posts.mockRestore();
      await closeOpenClawStateDatabaseAsync();
    }
  });
});

it.each(["exact", "family", "alias"] as const)(
  "joins foreground reader exit on %s close and reuses the pool afterward",
  async (selection) => {
    await withOpenClawTestState({ label: "foreground-reader-close" }, async (state) => {
      const pool = createSessionTranscriptReadPool<SessionSqliteTargetWorkerInput>(1);
      const alias = state.path("alias");
      if (selection === "alias") {
        await fs.symlink(state.stateDir, alias, "junction");
      }
      const storePath =
        selection === "alias"
          ? path.join(alias, "transcript.sqlite")
          : state.statePath(selection === "family" ? "transcript.json" : "transcript.sqlite");
      const closingPath = state.statePath(
        selection === "family" ? "transcript.main.sqlite" : "transcript.sqlite",
      );
      const otherPath = state.statePath("other.sqlite");
      const posts = vi.spyOn(Worker.prototype, "postMessage");
      const workers = new Set<Worker>();
      const read = (pathname: string) =>
        pool.run(
          {
            kind: "sqlite-target",
            storePath: pathname,
            env: state.env,
            registeredDatabases: [],
          },
          { timeoutMs: 60_000 },
          { storePaths: [pathname], admissionPaths: [pathname] },
        );
      try {
        const maintenance = createOpenClawDatabaseMaintenanceScope();
        await maintenance.run(() => read(storePath));
        await read(storePath);
        await maintenance.close();
        for (const worker of readWorkers(posts.mock.contexts)) {
          workers.add(worker);
        }
        const first = [...workers][0];
        expect(first).toBeInstanceOf(Worker);
        expect(first!.threadId).toBeGreaterThan(0);
        await closeOpenClawAgentDatabaseByPathAsync(closingPath);
        expect(first!.threadId).toBe(-1);

        posts.mockClear();
        // Closing an unrelated database must not retire this pool's replacement worker.
        await read(otherPath);
        const replacement = readWorkers(posts.mock.contexts)[0]!;
        workers.add(replacement);
        await closeOpenClawAgentDatabaseByPathAsync(closingPath);
        expect(replacement.threadId).toBeGreaterThan(0);
        await read(otherPath);
        await closeOpenClawStateDatabaseAsync();
        expect(replacement.threadId).toBe(-1);
      } finally {
        for (const worker of readWorkers(posts.mock.contexts)) {
          workers.add(worker);
        }
        posts.mockRestore();
        await closeOpenClawStateDatabaseAsync();
        // Also release test-owned workers on the unfixed implementation's failing path.
        await Promise.all(
          [...workers]
            .filter((worker) => worker.threadId !== -1)
            .map((worker) => worker.terminate()),
        );
      }
    });
  },
);

it("revokes a foreground read waiting for database admission before it can reopen the store", async () => {
  await withOpenClawTestState({ label: "foreground-reader-pending" }, async (state) => {
    const pool = createSessionTranscriptReadPool<SessionSqliteTargetWorkerInput>(1);
    const storePath = path.join(state.stateDir, "pending.sqlite");
    const started = createDeferred();
    const release = createDeferred();
    const preceding = runWithSqliteDatabaseAdmissionTurn([storePath], async () => {
      started.resolve();
      await release.promise;
    });
    let pending: Promise<unknown> | undefined;
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    try {
      await started.promise;
      pending = pool.run(
        { kind: "sqlite-target", storePath, env: state.env, registeredDatabases: [] },
        { timeoutMs: 60_000 },
        { storePaths: [storePath], admissionPaths: [storePath] },
      );
      const rejected = expect(pending).rejects.toThrow(
        "Session transcript database read was revoked",
      );
      await closeOpenClawAgentDatabaseByPathAsync(storePath);
      release.resolve();
      await preceding;
      await rejected;
    } finally {
      release.resolve();
      await preceding;
      await pending?.catch(() => undefined);
      const workers = new Set(readWorkers(posts.mock.contexts));
      posts.mockRestore();
      await closeOpenClawStateDatabaseAsync();
      await Promise.all(
        [...workers].filter((worker) => worker.threadId !== -1).map((worker) => worker.terminate()),
      );
    }
  });
});
