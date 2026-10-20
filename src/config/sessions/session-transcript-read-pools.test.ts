import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runWithSqliteDatabaseAdmissionTurn } from "../../infra/sqlite-database-admission-turn.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionTranscriptReadPool } from "./session-transcript-read-worker-runtime.js";
import type { SessionSqliteTargetWorkerInput } from "./session-transcript-worker-read.types.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

function readWorkers(contexts: readonly unknown[]): Worker[] {
  return contexts.map((context) => {
    if (!(context instanceof Worker)) {
      throw new Error("Expected a real foreground Worker");
    }
    return context;
  });
}

it.each(["exact", "family", "alias", "history-reuse", "history-first"] as const)(
  "joins foreground reader exit on %s close and reuses the pool afterward",
  async (selection) => {
    await withOpenClawTestState({ label: "foreground-reader-close" }, async (state) => {
      const pool = createSessionTranscriptReadPool<SessionSqliteTargetWorkerInput>(1);
      const sharesHistory = selection === "history-reuse" || selection === "history-first";
      const alias = state.path("alias");
      if (selection === "alias") {
        await fs.symlink(state.stateDir, alias, "junction");
      }
      const storePath =
        selection === "alias"
          ? path.join(alias, "transcript.sqlite")
          : sharesHistory
            ? resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env })
            : state.statePath(selection === "family" ? "transcript.json" : "transcript.sqlite");
      const closingPath = sharesHistory
        ? storePath
        : state.statePath(selection === "family" ? "transcript.main.sqlite" : "transcript.sqlite");
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
        const readWithHistory = () =>
          withSessionHistoryWorkerDatabase(
            { agentId: "main", path: storePath, env: state.env },
            async (owner) => {
              if (selection === "history-first") {
                await maintenance.run(() => read(storePath));
              }
              await maintenance.close();
              await expect(
                owner.prewarm({ env: state.env, history: false }),
              ).resolves.toBeUndefined();
            },
          );
        if (selection === "history-first") {
          await readWithHistory();
        } else {
          await maintenance.run(() => read(storePath));
          if (selection === "history-reuse") {
            await readWithHistory();
          } else {
            await read(storePath);
            await maintenance.close();
          }
        }
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
