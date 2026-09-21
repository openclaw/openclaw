import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCompletionFromSessionEntry } from "../agents/subagents/registry/subagent-session-reconciliation.js";
import * as accessor from "../config/sessions/session-accessor.js";
import * as entryStore from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { readSessionEntriesByStatus } from "../config/sessions/session-accessor.sqlite-status.js";
import * as transcriptStore from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { registerAgentRunContext, clearAgentRunContext } from "../infra/agent-run-registry.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import * as sessionRunError from "../sessions/session-run-error.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  clearAgentRunContext("startup-race-owner");
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each([
  "session",
  "generation",
  "local-owner",
  "session-admission",
  "durable-owner",
  "snapshot-owner",
  "snapshot-lease-release",
  "snapshot-lease-replace",
] as const)(
  "retains the row and emits no receipt when %s changes after repair preparation",
  async (race) => {
    const stateDir = fs.realpathSync.native(roots.make("startup-orphan-race-"));
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json") },
      async () => {
        const lock = await acquireGatewayLock({
          allowInTests: true,
          port: 24120,
          listenerMode: "foreground",
        });
        if (!lock) {
          throw new Error("expected isolated Gateway ownership");
        }
        let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
        try {
          await lock.run(async () => {
            const scope = { agentId: "main", sessionKey: "agent:main:subagent:race" };
            await accessor.replaceSessionEntry(scope, {
              sessionId: "predecessor",
              lifecycleRevision: "generation-1",
              lifecycleRunId: "run-1",
              status: "running",
              startedAt: Math.floor(performance.timeOrigin) - 100,
              updatedAt: Math.floor(performance.timeOrigin) - 100,
            });
            const database = openOpenClawAgentDatabase({ agentId: "main" });
            const original = accessor.loadSessionEntryReadOnly(scope);
            assert(original);
            const writeReceipt = sessionRunError.recordGatewaySessionRunFailure;
            let prepared = false;
            vi.spyOn(sessionRunError, "recordGatewaySessionRunFailure").mockImplementationOnce(
              async (params) => {
                await Promise.resolve();
                prepared = true;
                if (race === "session") {
                  accessor.replaceSessionEntrySync(scope, {
                    ...original,
                    sessionId: "successor",
                  });
                } else if (race === "generation") {
                  const other = new DatabaseSync(database.path);
                  try {
                    other
                      .prepare(
                        "UPDATE session_nodes SET entry_json = json_set(entry_json, ?, ?) WHERE session_key = ?",
                      )
                      .run("$.lifecycleRevision", "successor", scope.sessionKey);
                  } finally {
                    other.close();
                  }
                } else if (race === "local-owner") {
                  registerAgentRunContext("startup-race-owner", {
                    sessionKey: scope.sessionKey,
                    sessionId: "predecessor",
                    projectSessionActive: false,
                  });
                } else if (race === "session-admission") {
                  admission = await beginSessionWorkAdmission({
                    scope: database.path,
                    identities: [scope.sessionKey, "predecessor"],
                    assertAllowed: () => {},
                  });
                } else if (race === "snapshot-lease-release") {
                  openOpenClawStateDatabase()
                    .db.prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ?")
                    .run("gateway-owner", "global");
                } else if (race === "snapshot-lease-replace") {
                  openOpenClawStateDatabase()
                    .db.prepare(
                      "UPDATE state_leases SET owner = ? WHERE scope = ? AND lease_key = ?",
                    )
                    .run("replacement-owner", "gateway-owner", "global");
                } else {
                  openOpenClawStateDatabase()
                    .db.prepare(
                      "INSERT INTO subagent_runs(run_id,child_session_key,requester_session_key,created_at,payload_json) VALUES(?,?,?,?,?)",
                    )
                    .run(
                      "startup-race-owner",
                      scope.sessionKey,
                      "agent:main:main",
                      Date.now(),
                      "{}",
                    );
                }
                await writeReceipt(params);
              },
            );
            const log = { info: vi.fn(), warn: vi.fn() };
            const runStartup = () =>
              runStartupSessionMigration({ cfg: { agents: { entries: { main: {} } } }, log });
            if (
              race === "snapshot-owner" ||
              race === "snapshot-lease-release" ||
              race === "snapshot-lease-replace"
            ) {
              openOpenClawStateDatabase();
              await withOpenClawStateDatabaseReadSnapshot(runStartup);
            } else {
              await runStartup();
            }
            expect(
              prepared,
              JSON.stringify({
                warnings: log.warn.mock.calls,
                info: log.info.mock.calls,
                current: accessor.loadSessionEntryReadOnly(scope),
              }),
            ).toBe(true);
            expect(log.warn).toHaveBeenCalled();
            expect(
              (await accessor.loadTranscriptEvents({ ...scope, sessionId: "predecessor" })).filter(
                (event) => isRecord(event) && event.customType === "run-failed-before-reply",
              ),
            ).toEqual([]);
            const current = accessor.loadSessionEntryReadOnly(scope);
            expect(current).toEqual({
              ...original,
              ...(race === "session" ? { sessionId: "successor" } : {}),
              ...(race === "generation" ? { lifecycleRevision: "successor" } : {}),
            });
          });
        } finally {
          admission?.release();
          closeOpenClawAgentDatabasesForTest();
          await lock.release();
          closeOpenClawStateDatabaseForTest();
        }
      },
    );
  },
);

it.each(["owner", "settlement", "receipt"] as const)(
  "settles the orphan and receipt atomically after a %s failure",
  async (failure) => {
    const stateDir = fs.realpathSync.native(roots.make("startup-orphan-receipt-"));
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json") },
      async () => {
        const lock = await acquireGatewayLock({
          allowInTests: true,
          port: 24120,
          listenerMode: "foreground",
        });
        if (!lock) {
          throw new Error("expected isolated Gateway ownership");
        }
        try {
          await lock.run(async () => {
            const target = {
              agentId: "main",
              sessionKey: "agent:main:subagent:receipt",
              sessionId: "predecessor-receipt",
            };
            await accessor.replaceSessionEntry(target, {
              sessionId: target.sessionId,
              lifecycleRevision: "predecessor-generation",
              status: "running",
              startedAt: Math.floor(performance.timeOrigin) - 100,
              updatedAt: Math.floor(performance.timeOrigin) - 100,
            });
            const original = accessor.loadSessionEntryReadOnly(target);
            const log = { info: vi.fn(), warn: vi.fn() };
            const runStartup = () =>
              runStartupSessionMigration({ cfg: { agents: { entries: { main: {} } } }, log });
            if (failure === "receipt") {
              vi.spyOn(
                transcriptStore,
                "appendTranscriptEventInTransaction",
              ).mockImplementationOnce(() => {
                throw new Error("synthetic repair receipt write failure");
              });
            } else {
              const write = entryStore.writeSessionEntry;
              vi.spyOn(entryStore, "writeSessionEntry").mockImplementationOnce((...args) => {
                if (failure === "settlement") {
                  throw new Error("synthetic settlement failure");
                }
                registerAgentRunContext("startup-race-owner", {
                  sessionKey: target.sessionKey,
                  sessionId: target.sessionId,
                  projectSessionActive: false,
                });
                return write(...args);
              });
            }
            await runStartup();
            expect(accessor.loadSessionEntryReadOnly(target)).toEqual(original);
            expect(log.warn).toHaveBeenCalled();
            expect(
              (await accessor.loadTranscriptEvents(target)).filter(
                (event) => isRecord(event) && event.customType === "run-failed-before-reply",
              ),
            ).toEqual([]);
            clearAgentRunContext("startup-race-owner");

            const repairObservedAt = Date.now();
            await runStartup();
            const repaired = accessor.loadSessionEntryReadOnly(target);
            expect(repaired).toMatchObject({
              status: "interrupted",
              abortedLastRun: true,
              startedAt: original?.startedAt,
              updatedAt: original?.updatedAt,
            });
            expect(repaired?.endedAt).toBeGreaterThanOrEqual(repairObservedAt);
            expect(repaired?.runtimeMs).toBeUndefined();
            const receipts = async () =>
              (await accessor.loadTranscriptEvents(target)).filter(
                (event) => isRecord(event) && event.customType === "run-failed-before-reply",
              );
            expect(await receipts()).toMatchObject([
              {
                display: true,
                details: {
                  error: expect.stringContaining("interrupted before a terminal lifecycle event"),
                },
              },
            ]);
            await runStartup();
            expect(accessor.loadSessionEntryReadOnly(target)).toEqual(repaired);
            expect(await receipts()).toHaveLength(1);
          });
        } finally {
          closeOpenClawAgentDatabasesForTest();
          await lock.release();
          closeOpenClawStateDatabaseForTest();
        }
      },
    );
  },
);

it("keeps interrupted status distinct in canonical reads without inventing registry completion", async () => {
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: fs.realpathSync.native(roots.make("startup-orphan-status-")),
  };
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  for (const status of ["interrupted", "failed", "running"] as const) {
    await accessor.upsertSessionEntryCore(
      { agentId: "main", env, sessionKey: "agent:main:subagent:" + status },
      { sessionId: status, status, updatedAt: 10 },
    );
  }
  expect(
    readSessionEntriesByStatus(database, ["interrupted"]).map((row) => row.entry.status),
  ).toEqual(["interrupted"]);
  expect(readSessionEntriesByStatus(database, ["failed"]).map((row) => row.entry.status)).toEqual([
    "failed",
  ]);
  expect(readSessionEntriesByStatus(database, ["running"]).map((row) => row.entry.status)).toEqual([
    "running",
  ]);
  expect(
    resolveCompletionFromSessionEntry(
      { sessionId: "orphan", status: "interrupted", updatedAt: 10 },
      1000,
    ),
  ).toBeNull();
});
