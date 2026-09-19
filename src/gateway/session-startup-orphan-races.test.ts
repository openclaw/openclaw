import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCompletionFromSessionEntry } from "../agents/subagents/registry/subagent-session-reconciliation.js";
import * as accessor from "../config/sessions/session-accessor.js";
import { readSessionEntriesByStatus } from "../config/sessions/session-accessor.sqlite-status.js";
import { registerAgentRunContext, clearAgentRunContext } from "../infra/agent-run-registry.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
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
  "durable-owner",
  "snapshot-owner",
  "snapshot-lease-release",
  "snapshot-lease-replace",
] as const)("retains the row when %s changes after startup prepares its patch", async (race) => {
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
          const patch = accessor.patchSessionEntryCore;
          let prepared = false;
          vi.spyOn(accessor, "patchSessionEntryCore").mockImplementation(
            (target, update, options) =>
              patch(
                target,
                async (current, context) => {
                  const next = await update(current, context);
                  if (next?.status === "interrupted") {
                    prepared = true;
                    if (race === "session") {
                      accessor.replaceSessionEntrySync(scope, {
                        ...current,
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
                  }
                  return next;
                },
                options,
              ),
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
          const current = accessor.loadSessionEntryReadOnly(scope);
          expect(current).toEqual({
            ...original,
            ...(race === "session" ? { sessionId: "successor" } : {}),
            ...(race === "generation" ? { lifecycleRevision: "successor" } : {}),
          });
        });
      } finally {
        closeOpenClawAgentDatabasesForTest();
        await lock.release();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
});

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
