import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDurableRuntimeSqlitePath } from "../../durable/config.js";
import { openDurableRuntimeSqliteStore } from "../../durable/sqlite-store.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db.js";
import { durableHandlers } from "./durable.js";

describe("durable gateway methods", () => {
  it("returns coordination projection for a durable runtime run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-gateway-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const previousEnabled = process.env.OPENCLAW_DURABLE_RUNTIME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_DURABLE_RUNTIME = "1";
    process.env.OPENCLAW_STATE_DIR = dir;
    const store = openDurableRuntimeSqliteStore({ path: dbPath });
    let storeClosed = false;
    try {
      const parent = store.createRun({
        operationKind: "test.parent",
        status: "waiting_child",
        recoveryState: "waiting_child",
        metadata: {
          taskId: "task-parent",
          taskFlowId: "flow-parent",
          sessionKey: "agent:bo:main",
        },
        now: 100,
      });
      store.createStep({
        runtimeRunId: parent.runtimeRunId,
        stepId: "subagents",
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        now: 110,
      });
      const child = store.createRun({
        operationKind: "test.child",
        status: "succeeded",
        recoveryState: "terminal",
        now: 120,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: "subagents",
        childRuntimeRunId: child.runtimeRunId,
        linkType: "subagent",
        status: "succeeded",
        now: 130,
      });
      store.close();
      storeClosed = true;

      const calls: unknown[][] = [];
      await durableHandlers["durable.coordination.get"]?.({
        params: { runtimeRunId: parent.runtimeRunId },
        respond: (...args: unknown[]) => calls.push(args),
      } as never);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(true);
      expect(calls[0]?.[1]).toMatchObject({
        projection: {
          runtimeRunId: parent.runtimeRunId,
          waitingReason: "child",
          currentStepId: "subagents",
          external: {
            taskId: "task-parent",
            taskFlowId: "flow-parent",
            sessionKey: "agent:bo:main",
          },
          children: {
            total: 1,
            succeeded: 1,
            terminal: 1,
            open: 0,
          },
        },
      });
    } finally {
      if (!storeClosed) {
        store.close();
      }
      if (previousEnabled === undefined) {
        delete process.env.OPENCLAW_DURABLE_RUNTIME;
      } else {
        process.env.OPENCLAW_DURABLE_RUNTIME = previousEnabled;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not create durable state when the feature is disabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-disabled-"));
    const previousEnabled = process.env.OPENCLAW_DURABLE_RUNTIME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_DURABLE_RUNTIME;
    process.env.OPENCLAW_STATE_DIR = dir;
    try {
      const calls: unknown[][] = [];
      await durableHandlers["durable.coordination.get"]?.({
        params: { runtimeRunId: "rt_disabled" },
        respond: (...args: unknown[]) => calls.push(args),
      } as never);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(false);
      expect(fs.existsSync(path.join(dir, "state", "openclaw.sqlite"))).toBe(false);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.OPENCLAW_DURABLE_RUNTIME;
      } else {
        process.env.OPENCLAW_DURABLE_RUNTIME = previousEnabled;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("responds with a safe error for a future shared state schema", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-future-"));
    const previousEnabled = process.env.OPENCLAW_DURABLE_RUNTIME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_DURABLE_RUNTIME = "1";
    process.env.OPENCLAW_STATE_DIR = dir;
    const sqlitePath = resolveDurableRuntimeSqlitePath(process.env);
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(sqlitePath);
    try {
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    } finally {
      db.close();
    }

    try {
      const calls: unknown[][] = [];
      await durableHandlers["durable.coordination.get"]?.({
        params: { runtimeRunId: "rt_future" },
        respond: (...args: unknown[]) => calls.push(args),
      } as never);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(false);
      expect(calls[0]?.[2]).toMatchObject({
        code: "UNAVAILABLE",
        message: expect.stringContaining("newer schema version"),
      });
      const verifyDb = new DatabaseSync(sqlitePath);
      try {
        expect(
          verifyDb
            .prepare(
              `SELECT name FROM sqlite_master
                 WHERE type = 'table'
                   AND name LIKE 'durable_runtime_%'
                 ORDER BY name`,
            )
            .all(),
        ).toEqual([]);
      } finally {
        verifyDb.close();
      }
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.OPENCLAW_DURABLE_RUNTIME;
      } else {
        process.env.OPENCLAW_DURABLE_RUNTIME = previousEnabled;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid coordination params before opening durable state", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-invalid-"));
    const previousEnabled = process.env.OPENCLAW_DURABLE_RUNTIME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_DURABLE_RUNTIME = "1";
    process.env.OPENCLAW_STATE_DIR = dir;
    try {
      const calls: unknown[][] = [];
      await durableHandlers["durable.coordination.get"]?.({
        params: { runtimeRunId: "", includeSteps: true },
        respond: (...args: unknown[]) => calls.push(args),
      } as never);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(false);
      expect(fs.existsSync(path.join(dir, "state", "openclaw.sqlite"))).toBe(false);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.OPENCLAW_DURABLE_RUNTIME;
      } else {
        process.env.OPENCLAW_DURABLE_RUNTIME = previousEnabled;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
