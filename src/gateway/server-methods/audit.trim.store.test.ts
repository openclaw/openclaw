import { existsSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { listAuditEvents, recordAuditEventInDatabase } from "../../audit/audit-event-store.js";
import { prepareExecutionIdentityContextAtAdmission } from "../../audit/execution-identity.test-support.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { auditHandlers } from "./audit.js";

const tempDirs: string[] = [];

function createDatabaseOptions() {
  const stateDir = makeTempDir(tempDirs, "openclaw-audit-trim-");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return { env: { OPENCLAW_STATE_DIR: stateDir } };
}

async function callAudit(method: keyof typeof auditHandlers, params: object) {
  const respond = vi.fn();
  await expectDefined(auditHandlers[method], "audit handler")({ params, respond } as never);
  expect(respond).toHaveBeenCalledWith(true, expect.anything());
  const result: unknown = respond.mock.calls[0]?.[1];
  return result;
}
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  delete process.env.OPENCLAW_STATE_DIR;
});

afterAll(() => cleanupTempDirs(tempDirs));

describe("audit methods against a real audit store", () => {
  it.each([false, true])(
    "inspects retained execution identity without host SQLite (writable actor: %s)",
    async (warmActor) => {
      const database = createDatabaseOptions();
      expect(
        prepareExecutionIdentityContextAtAdmission(
          {
            runId: "inspection-run",
            agentId: "main",
            ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
            runtime: { kind: "embedded" },
          },
          { ...database, contextId: "inspection-context", executionId: "inspection-execution" },
        ),
      ).toBeDefined();
      await closeOpenClawStateDatabaseAsync();
      if (warmActor) {
        await listAuditEvents({ database, limit: 1 });
      }
      requireNodeSqlite();
      const counters = observeMainThreadSql({ includeClose: true });
      const result = await callAudit("audit.run.inspect", {
        executionId: "inspection-execution",
        decisionLimit: 1,
      });
      const run = { runId: "inspection-run", executionId: "inspection-execution", status: "known" };
      expect(result).toHaveProperty("run", run);
      expect(result).toMatchObject({
        identity: { state: "present" },
        decisionDisplays: [{ selectorId: "inspection-context:admission" }],
      });
      expect(result).not.toHaveProperty("decisions");
      counters.expectIdle();
    },
  );

  it.each([{ runId: "missing-run" }, { executionId: "missing-execution" }])(
    "keeps absent state absent during inspection: %j",
    async (params) => {
      const database = createDatabaseOptions();
      const stateDir = database.env.OPENCLAW_STATE_DIR;
      expect(await callAudit("audit.run.inspect", params)).toMatchObject({
        identity: { state: "unknown" },
        decisionDisplays: [],
      });
      expect(existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
    },
  );

  it.each(["audit.list", "audit.activity.list"] as const)(
    "%s returns padded filters without host SQLite",
    async (method) => {
      const database = createDatabaseOptions();
      const input = {
        sourceId: "audit-trim-run-source",
        occurredAt: Date.now(),
        kind: "agent_run" as const,
        actorType: "agent" as const,
        actorId: "main",
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "run-trim-1",
      };
      recordAuditEventInDatabase(
        { ...input, sourceSequence: 1, action: "agent.run.started", status: "started" },
        { ...database, database: openOpenClawStateDatabase(database) },
      );
      const finished = recordAuditEventInDatabase(
        {
          ...input,
          sourceId: "audit-trim-finished",
          sourceSequence: 2,
          action: "agent.run.finished",
          status: "succeeded",
        },
        { ...database, database: openOpenClawStateDatabase(database) },
      );

      // Negative control: untrimmed filter values miss the planted row at the store.
      const untrimmed = await listAuditEvents({
        limit: 20,
        filters: { agentId: " main ", runId: " run-trim-1 " },
        database,
      });
      expect(untrimmed.events).toEqual([]);

      await closeOpenClawStateDatabaseAsync();
      requireNodeSqlite();
      const counters = observeMainThreadSql();
      const result = await callAudit(method, {
        limit: 1,
        agentId: " main ",
        sessionKey: " agent:main:main ",
        runId: " run-trim-1 ",
      });

      counters.expectIdle();
      expect(result).toMatchObject({
        nextCursor: String(finished?.sequence),
        events: [
          {
            agentId: "main",
            runId: "run-trim-1",
            action: "agent.run.finished",
          },
        ],
      });
      const next = await callAudit(method, { limit: 1, cursor: String(finished?.sequence) });
      expect(next).toEqual({
        events: [expect.objectContaining({ action: "agent.run.started" })],
      });
      counters.expectIdle();
    },
  );
});
