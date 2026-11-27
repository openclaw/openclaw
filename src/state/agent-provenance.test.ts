import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { readAgentProvenance, seedAgentProvenance } from "../test-utils/agent-provenance.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { completeAgentDeletionJournalInDatabase } from "./agent-deletion-journal.js";
import { journalInput } from "./agent-deletion-journal.test-support.js";
import { agentProvenancePublication } from "./agent-provenance-publication.js";
import {
  listAgentProvenance as list,
  readAgentProvenanceForDisplay as display,
  recordAgentProvenance as record,
} from "./agent-provenance.js";
import { deleteAgentProvenanceForAgent as remove } from "./agent-provenance.kernel.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const withState = (run: Parameters<typeof withOpenClawTestState>[1]) =>
  withOpenClawTestState(
    { layout: "state-only", scenario: "empty", label: "agent-provenance" },
    run,
  );
const operator = {
  agentId: "worker",
  createdVia: "operator",
  creatorAgentId: null,
};
const agent = { ...operator, createdVia: "agent", creatorAgentId: "main" };

it("records captured provenance and destination in the worker", async () => {
  await withState(async ({ root, env }) => {
    const options = {
      env: { ...env },
      path: resolveOpenClawStateSqlitePath(env),
      nowMs: 42,
    };
    const redirectedPath = path.join(root, "redirected.sqlite");
    const provenance = { createdVia: "agent" as const, creatorAgentId: "Main" };
    const sql = observeMainThreadSql();
    try {
      const writing = record("Worker", provenance, options);
      provenance.creatorAgentId = "replacement";
      options.path = redirectedPath;
      options.env.OPENCLAW_STATE_DIR = path.join(root, "redirected");
      options.nowMs = 99;
      await writing;
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    expect(fs.existsSync(redirectedPath)).toBe(false);
    expect(readAgentProvenance("worker", { env })).toEqual({ ...agent, createdAtMs: 42 });
  });
});

it("reads absent provenance without creating state and observes its later writer", async () => {
  await withState(async ({ env }) => {
    const options = { env };
    const expectAbsent = async () => {
      expect([
        readAgentProvenance("worker", options),
        await list(options),
        await display(["worker"], options),
      ]).toEqual([undefined, [], []]);
    };
    await expectAbsent();
    expect(fs.existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);

    const database = openOpenClawStateDatabase(options);
    database.db.exec("DROP TABLE IF EXISTS agent_provenance");
    await expectAbsent();
    expect(tableExists(database.db, "agent_provenance")).toBe(false);

    await record("worker", { createdVia: "operator" }, { ...options, nowMs: 42 });
    expect(readAgentProvenance("worker", options)?.createdAtMs).toBe(42);
    expect(await display(["missing", "WORKER", "worker"], options)).toEqual([
      { ...operator, createdAtMs: 42 },
      { ...operator, createdAtMs: 42 },
    ]);
    database.db.exec("ALTER TABLE agent_provenance RENAME COLUMN created_via TO invalid_kind");
    expect(() => readAgentProvenance("worker", options)).toThrow();
  });
});

it("records, replaces, lists, and deletes agent creation provenance", async () => {
  await withState(async ({ env }) => {
    await record("Worker", { createdVia: "operator" }, { env, nowMs: 10 });
    expect(readAgentProvenance("worker", { env })).toEqual({ ...operator, createdAtMs: 10 });

    await record("worker", { createdVia: "agent", creatorAgentId: "Main" }, { env, nowMs: 20 });
    expect(await list({ env })).toEqual([{ ...agent, createdAtMs: 20 }]);

    const database = openOpenClawStateDatabase({ env });
    remove(database.db, "worker");
    expect(readAgentProvenance("worker", { env })).toBeUndefined();
  });
});

it("publishes a provenance deletion only when its own journal completion commits", async () => {
  await withState(async (state) => {
    const options = { env: state.env };
    const other = { ...options, path: path.join(state.root, "other.sqlite") };
    seedAgentProvenance("worker", { createdVia: "operator" }, { ...options, nowMs: 10 });
    seedAgentProvenance("worker", { createdVia: "operator" }, { ...other, nowMs: 20 });
    const journal = beginAgentDeletionJournal(journalInput(state), options);
    const published: string[] = [];
    const unsubscribe = agentProvenancePublication.subscribeFacts((change) => {
      if (change.kind === "committed" && change.receipt.facts.get("worker")?.kind === "absent") {
        published.push("worker");
      }
    });
    try {
      const complete = (operationId: string, rollback = false) =>
        runOpenClawStateWriteTransaction((database) => {
          const completed = completeAgentDeletionJournalInDatabase(database, "WORKER", operationId);
          if (rollback) {
            expect(completed).toBe(true);
            throw new Error("rollback completion");
          }
          return completed;
        }, options);
      expect(complete("superseded")).toBe(false);
      expect(() => complete(journal.operationId, true)).toThrow("rollback completion");
      expect(readAgentProvenance("worker", options)?.createdAtMs).toBe(10);
      expect(published).toEqual([]);
      expect(complete(journal.operationId)).toBe(true);
      expect(published).toEqual(["worker"]);
      expect(readAgentProvenance("worker", options)).toBeUndefined();
      expect(readAgentProvenance("worker", other)?.createdAtMs).toBe(20);
    } finally {
      unsubscribe();
    }
  });
});
