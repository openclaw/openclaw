import { existsSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { listAuditEvents, recordAuditEvent } from "../../audit/audit-event-store.js";
import {
  configureExecutionIdentityAdmissionSink,
  enqueueExecutionIdentityContextAtAdmission,
} from "../../audit/execution-identity-admission.js";
import { processExecutionIdentityAdmissionWork } from "../../audit/execution-identity-context.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { auditHandlers } from "./audit.js";

const tempDirs: string[] = [];

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  return { env: { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "openclaw-audit-trim-") } };
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  delete process.env.OPENCLAW_STATE_DIR;
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("audit methods against a real audit store", () => {
  it.each([false, true])(
    "inspects retained execution identity without host SQLite (writable actor: %s)",
    async (warmActor) => {
      const database = createDatabaseOptions();
      process.env.OPENCLAW_STATE_DIR = database.env!.OPENCLAW_STATE_DIR;
      const clear = configureExecutionIdentityAdmissionSink((work) => {
        processExecutionIdentityAdmissionWork(work, database);
        return true;
      });
      try {
        expect(
          enqueueExecutionIdentityContextAtAdmission(
            {
              runId: "inspection-run",
              agentId: "main",
              ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
              runtime: { kind: "embedded" },
            },
            { enabled: true, contextId: "inspection-context", executionId: "inspection-execution" },
          ),
        ).toBeDefined();
      } finally {
        clear();
      }
      await closeOpenClawStateDatabaseAsync();
      if (warmActor) {
        await listAuditEvents({ database, limit: 1 });
      }
      const native = requireNodeSqlite();
      const counters = [
        vi.spyOn(native.DatabaseSync.prototype, "prepare"),
        vi.spyOn(native.DatabaseSync.prototype, "exec"),
        vi.spyOn(native.DatabaseSync.prototype, "close"),
        ...(["get", "all", "run", "iterate"] as const).map((operation) =>
          vi.spyOn(native.StatementSync.prototype, operation),
        ),
      ];
      const respond = vi.fn();
      await expectDefined(
        auditHandlers["audit.run.inspect"],
        "audit inspection handler",
      )({
        params: { executionId: "inspection-execution", decisionLimit: 1 },
        respond,
      } as never);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          run: { runId: "inspection-run", executionId: "inspection-execution", status: "known" },
          identity: expect.objectContaining({ state: "present" }),
          decisionDisplays: [
            expect.objectContaining({ selectorId: "inspection-context:admission" }),
          ],
        }),
      );
      expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("decisions");
      expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    },
  );

  it.each([{ runId: "missing-run" }, { executionId: "missing-execution" }])(
    "keeps absent state absent during inspection: %j",
    async (params) => {
      const database = createDatabaseOptions();
      const stateDir = expectDefined(database.env?.OPENCLAW_STATE_DIR, "temp state dir");
      process.env.OPENCLAW_STATE_DIR = stateDir;
      const respond = vi.fn();
      await expectDefined(
        auditHandlers["audit.run.inspect"],
        "audit inspection handler",
      )({
        params,
        respond,
      } as never);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          identity: expect.objectContaining({ state: "unknown" }),
          decisionDisplays: [],
        }),
      );
      expect(existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
    },
  );

  it.each(["audit.list", "audit.activity.list"] as const)(
    "%s returns padded filters without host SQLite",
    async (method) => {
      const database = createDatabaseOptions();
      const stateDir = expectDefined(database.env?.OPENCLAW_STATE_DIR, "temp state dir");
      process.env.OPENCLAW_STATE_DIR = stateDir;

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
      recordAuditEvent(
        { ...input, sourceSequence: 1, action: "agent.run.started", status: "started" },
        database,
      );
      const finished = recordAuditEvent(
        {
          ...input,
          sourceId: "audit-trim-finished",
          sourceSequence: 2,
          action: "agent.run.finished",
          status: "succeeded",
        },
        database,
      );

      // Negative control: untrimmed filter values miss the planted row at the store.
      expect(
        (
          await listAuditEvents({
            limit: 20,
            filters: { agentId: " main ", runId: " run-trim-1 " },
            database,
          })
        ).events,
      ).toEqual([]);

      await closeOpenClawStateDatabaseAsync();
      const native = requireNodeSqlite();
      const counters = [
        vi.spyOn(native.DatabaseSync.prototype, "prepare"),
        vi.spyOn(native.DatabaseSync.prototype, "exec"),
        ...(["get", "all", "run", "iterate"] as const).map((operation) =>
          vi.spyOn(native.StatementSync.prototype, operation),
        ),
      ];
      const respond = vi.fn();
      await expectDefined(
        auditHandlers[method],
        "audit.list handler",
      )({
        params: {
          limit: 1,
          agentId: " main ",
          sessionKey: " agent:main:main ",
          runId: " run-trim-1 ",
        },
        respond,
      } as never);

      expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          nextCursor: String(finished?.sequence),
          events: [
            expect.objectContaining({
              agentId: "main",
              runId: "run-trim-1",
              action: "agent.run.finished",
            }),
          ],
        }),
      );
      respond.mockClear();
      await expectDefined(
        auditHandlers[method],
        "audit list handler",
      )({
        params: { limit: 1, cursor: String(finished?.sequence) },
        respond,
      } as never);
      expect(respond).toHaveBeenCalledWith(true, {
        events: [expect.objectContaining({ action: "agent.run.started" })],
      });
      expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    },
  );
});
