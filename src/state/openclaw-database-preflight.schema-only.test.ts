import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db.js";
import {
  assertOpenClawDatabasesReady,
  preflightOpenClawDatabaseSchemas,
} from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("schema-only agent preflight", () => {
  it.each(
    ["DELETE", "WAL"].flatMap((mode) =>
      [false, true].map((verifyCurrentSchemaShape) => ({ mode, verifyCurrentSchemaShape })),
    ),
  )(
    "checks fresh $mode metadata without space for an agent snapshot (shape=$verifyCurrentSchemaShape)",
    async ({ mode, verifyCurrentSchemaShape }) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("schema-only-preflight-") };
      const agentPath = openOpenClawAgentDatabase({ agentId: "worker", env }).path;
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const { DatabaseSync } = requireNodeSqlite();
      const writer = new DatabaseSync(agentPath);
      writer.exec(`PRAGMA journal_mode=${mode}; PRAGMA wal_autocheckpoint=0;`);
      writer
        .prepare("UPDATE schema_meta SET app_version='inspection-fixture' WHERE meta_key='primary'")
        .run();
      const prepare = snapshots.prepareSqliteReadOnlyLocation;
      vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
        (pathname, options) => {
          if (path.resolve(pathname) === agentPath) {
            throw new Error("No space for a full agent database snapshot");
          }
          return prepare(pathname, options);
        },
      );
      const config = { agents: { list: [{ id: "worker", default: true }] } };
      const ready = (operation: "doctor" | "gateway-restart" | "gateway-startup") =>
        assertOpenClawDatabasesReady({
          env,
          config,
          operation,
          configuredAgentDatabaseTargets: [{ agentId: "worker", path: agentPath }],
        });
      const inspect = () =>
        preflightOpenClawDatabaseSchemas({
          env,
          verifyCurrentSchemaShape,
          agentAdmissionConfig: config,
          supportedVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
        });
      try {
        await expect(ready("doctor")).resolves.toBeUndefined();
        await expect(ready("gateway-restart")).resolves.toBeUndefined();
        await expect(ready("gateway-startup")).resolves.toBeUndefined();
        expect(await inspect()).toEqual({ incompatible: [], indeterminate: [] });
        writer.exec("BEGIN IMMEDIATE; PRAGMA user_version=999;");
        try {
          await expect(ready("doctor")).resolves.toBeUndefined();
          expect(writer.isTransaction).toBe(true);
          expect(writer.prepare("PRAGMA user_version").get()).toEqual({ user_version: 999 });
        } finally {
          writer.exec("ROLLBACK;");
        }
        writer.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
        expect(await inspect()).toMatchObject({
          incompatible: [
            {
              kind: "agent",
              path: agentPath,
              foundVersion: OPENCLAW_AGENT_SCHEMA_VERSION + 1,
              writerAppVersion: "inspection-fixture",
            },
          ],
          indeterminate: [],
        });
        writer.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION};`);
        writer
          .prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = 'primary'")
          .run("foreign");
        expect((await inspect()).agentRefusals).toEqual([
          expect.objectContaining({ agentId: "worker", code: "agent-database-ownership-mismatch" }),
        ]);
        await expect(ready("doctor")).rejects.toThrow("belongs to agent foreign");
        await expect(ready("gateway-restart")).rejects.toThrow("belongs to agent foreign");
        await expect(ready("gateway-startup")).rejects.toThrow("belongs to agent foreign");
        writer
          .prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = 'primary'")
          .run("worker");
        writer.exec("DROP INDEX idx_agent_cache_expiry;");
        expect(await inspect()).toMatchObject({
          incompatible: [],
          indeterminate: verifyCurrentSchemaShape
            ? [
                {
                  kind: "agent",
                  path: agentPath,
                  reason: expect.stringContaining("idx_agent_cache_expiry"),
                },
              ]
            : [],
        });
        if (!verifyCurrentSchemaShape) {
          writer.exec("ALTER TABLE schema_meta RENAME COLUMN agent_id TO retired_agent_id;");
          expect(await inspect()).toMatchObject({
            incompatible: [],
            indeterminate: [expect.objectContaining({ kind: "agent", path: agentPath })],
          });
        }
      } finally {
        writer.close();
      }
    },
  );
});

it.each(
  (["header", "shape", "startup"] as const).flatMap((mode) =>
    (["false", "reject"] as const).map((cleanupFailure) => ({ mode, cleanupFailure })),
  ),
)(
  "finishes sibling inspections after private snapshot cleanup $cleanupFailure ($mode)",
  async ({ mode, cleanupFailure }) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("schema-owned-snapshot-") };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker", env }).path;
    for (const agentId of ["sibling", "queued"]) {
      openOpenClawAgentDatabase({ agentId, env });
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const snapshotPath = path.join(tempDirs.make("schema-owned-copy-"), "snapshot.sqlite");
    fs.copyFileSync(agentPath, snapshotPath);
    const cleanup = vi.fn(() => true);
    const controller = new AbortController();
    const onAgentInspection = vi.fn();
    const rejectedCleanup = new Error("snapshot cleanup failed: fixture removal rejected");
    const prepare = snapshots.prepareSqliteReadOnlyLocation;
    vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
      async (pathname, options) => {
        if (path.resolve(pathname) !== agentPath) {
          return prepare(pathname, options);
        }
        return { location: snapshotPath, cleanup, cleanupAsync: async () => cleanup() };
      },
    );
    const inspect = () => {
      const run = () =>
        preflightOpenClawDatabaseSchemas({
          env,
          verifyCurrentSchemaShape: mode !== "header",
          requireStartupMigrationReadiness: mode === "startup",
          signal: controller.signal,
          onAgentInspection,
          supportedVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
        });
      return mode === "startup" ? withAgentDatabaseStartupAdmission(run) : run();
    };
    expect(await inspect()).toEqual({ incompatible: [], indeterminate: [] });
    if (cleanupFailure === "false") {
      cleanup.mockReturnValue(false);
    } else {
      cleanup.mockImplementation(() => {
        throw rejectedCleanup;
      });
    }
    onAgentInspection.mockClear();
    expect(await inspect()).toEqual({
      incompatible: [],
      indeterminate:
        mode === "startup"
          ? []
          : [
              {
                kind: "agent",
                path: agentPath,
                reason: expect.stringContaining("snapshot cleanup failed"),
              },
            ],
      ...(mode === "startup"
        ? {
            agentRefusals: [
              expect.objectContaining({
                agentId: "worker",
                paths: [agentPath],
                code: "agent-database-inspection-failed",
                reason: expect.stringContaining("snapshot cleanup failed"),
              }),
            ],
          }
        : {}),
    });
    expect(onAgentInspection).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ schemaInspectionCount: 3 }),
    );
    if (cleanupFailure === "reject") {
      const cancelled = new Error("caller stopped during cleanup");
      cleanup.mockImplementation(() => {
        controller.abort(cancelled);
        throw rejectedCleanup;
      });
      await expect(inspect()).rejects.toBe(cancelled);
    }
    expect(cleanup).toHaveBeenCalledTimes(cleanupFailure === "reject" ? 3 : 2);
  },
);
