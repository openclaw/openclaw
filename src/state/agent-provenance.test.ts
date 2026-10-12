import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { readAgentProvenance } from "../test-utils/agent-provenance.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  deleteAgentProvenanceForAgent,
  listAgentProvenance,
  recordAgentProvenance,
} from "./agent-provenance.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

it("records captured provenance and destination in the worker", async () => {
  await withOpenClawTestState(
    { layout: "state-only", scenario: "empty", label: "agent-provenance-capture" },
    async (state) => {
      const options = {
        env: { ...state.env },
        path: resolveOpenClawStateSqlitePath(state.env),
        nowMs: 42,
      };
      const redirectedPath = path.join(state.root, "redirected.sqlite");
      const provenance = { createdVia: "agent" as const, creatorAgentId: "Main" };
      const sql = observeMainThreadSql();
      try {
        const writing = recordAgentProvenance("Worker", provenance, options);
        provenance.creatorAgentId = "replacement";
        options.path = redirectedPath;
        options.env.OPENCLAW_STATE_DIR = path.join(state.root, "redirected");
        options.nowMs = 99;
        await writing;
        sql.expectIdle();
      } finally {
        sql.restore();
      }
      expect(fs.existsSync(redirectedPath)).toBe(false);
      expect(readAgentProvenance("worker", { env: state.env })).toEqual({
        agentId: "worker",
        createdVia: "agent",
        creatorAgentId: "main",
        createdAtMs: 42,
      });
    },
  );
});

it("reads absent provenance without creating state and observes its later writer", async () => {
  await withOpenClawTestState(
    { layout: "state-only", scenario: "empty", label: "agent-provenance-read" },
    async (state) => {
      const options = { env: state.env };
      expect(readAgentProvenance("worker", options)).toBeUndefined();
      expect(fs.existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);

      const database = openOpenClawStateDatabase(options);
      database.db.exec("DROP TABLE IF EXISTS agent_provenance");
      expect(readAgentProvenance("worker", options)).toBeUndefined();
      expect(tableExists(database.db, "agent_provenance")).toBe(false);

      await recordAgentProvenance("worker", { createdVia: "operator" }, { ...options, nowMs: 42 });
      expect(readAgentProvenance("worker", options)?.createdAtMs).toBe(42);
      database.db.exec("ALTER TABLE agent_provenance RENAME COLUMN created_via TO invalid_kind");
      expect(() => readAgentProvenance("worker", options)).toThrow();
    },
  );
});

it("records, replaces, lists, and deletes agent creation provenance", async () => {
  await withOpenClawTestState(
    { layout: "state-only", scenario: "empty", label: "agent-provenance" },
    async (state) => {
      await recordAgentProvenance(
        "Worker",
        { createdVia: "operator" },
        { env: state.env, nowMs: 10 },
      );
      expect(readAgentProvenance("worker", { env: state.env })).toEqual({
        agentId: "worker",
        createdVia: "operator",
        creatorAgentId: null,
        createdAtMs: 10,
      });

      await recordAgentProvenance(
        "worker",
        { createdVia: "agent", creatorAgentId: "Main" },
        { env: state.env, nowMs: 20 },
      );
      expect(await listAgentProvenance({ env: state.env })).toEqual([
        {
          agentId: "worker",
          createdVia: "agent",
          creatorAgentId: "main",
          createdAtMs: 20,
        },
      ]);

      const database = openOpenClawStateDatabase({ env: state.env });
      deleteAgentProvenanceForAgent(database.db, "worker");
      expect(readAgentProvenance("worker", { env: state.env })).toBeUndefined();
    },
  );
});
