import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
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
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function createFleet() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("preflight-startup-prepared-") };
  const agentIds = ["first", "second", "third"];
  const config: OpenClawConfig = {
    agents: {
      entries: Object.fromEntries(agentIds.map((id, index) => [id, { default: index === 0 }])),
    },
  };
  const paths = agentIds.map((agentId) => openOpenClawAgentDatabase({ agentId, env }).path);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const pathname of paths) {
    const database = new (requireNodeSqlite().DatabaseSync)(pathname);
    try {
      database.exec("PRAGMA journal_mode=DELETE;");
    } finally {
      database.close();
    }
  }
  const onAgentInspection = vi.fn();
  return {
    env,
    paths,
    onAgentInspection,
    ready: () =>
      assertOpenClawDatabasesReady({
        env,
        config,
        operation: "gateway-startup",
        onAgentInspection,
      }),
    inspect: (signal?: AbortSignal) =>
      preflightOpenClawDatabaseSchemas({
        env,
        signal,
        reuseStartupSchemaPreparation: true,
        onAgentInspection,
      }),
  };
}

it("carries fleet compatibility once into bootstrap while readiness always inspects fresh", async () => {
  const fleet = createFleet();
  await withAgentDatabaseStartupAdmission(async () => {
    await fleet.ready();
    expect(fleet.onAgentInspection).toHaveBeenLastCalledWith(
      expect.objectContaining({ schemaInspectionCount: fleet.paths.length }),
    );
    // Migration admission before and under its lease must remain independent.
    await fleet.ready();
    expect(fleet.onAgentInspection).toHaveBeenLastCalledWith(
      expect.objectContaining({ schemaInspectionCount: fleet.paths.length }),
    );
    expect(await fleet.inspect()).toEqual({ incompatible: [], indeterminate: [] });
    expect(fleet.onAgentInspection).toHaveBeenLastCalledWith({
      schemaInspectionCount: 0,
      schemaProcessCount: 0,
      schemaSnapshotCount: 0,
    });
    await fleet.inspect();
    expect(fleet.onAgentInspection).toHaveBeenLastCalledWith(
      expect.objectContaining({ schemaInspectionCount: fleet.paths.length }),
    );
  });
  await fleet.inspect();
  expect(fleet.onAgentInspection).toHaveBeenLastCalledWith(
    expect.objectContaining({ schemaInspectionCount: fleet.paths.length }),
  );
});

it.each(["WAL commit", "replacement", "new registration"] as const)(
  "inspects only changed fleet members after %s and still refuses their newer schema",
  async (change) => {
    const fleet = createFleet();
    let changedPath = fleet.paths[0]!;
    const writer =
      change === "WAL commit" ? new (requireNodeSqlite().DatabaseSync)(changedPath) : undefined;
    writer?.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    try {
      await withAgentDatabaseStartupAdmission(async () => {
        await fleet.ready();
        if (change === "WAL commit") {
          const originalMainBytes = fs.readFileSync(changedPath);
          writer!.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
          expect(fs.readFileSync(changedPath)).toEqual(originalMainBytes);
        } else {
          if (change === "new registration") {
            changedPath = openOpenClawAgentDatabase({ agentId: "newcomer", env: fleet.env }).path;
            closeOpenClawAgentDatabasesForTest();
            closeOpenClawStateDatabaseForTest();
          }
          const replacement = path.join(path.dirname(changedPath), "replacement.sqlite");
          const mutationPath = change === "replacement" ? replacement : changedPath;
          if (change === "replacement") {
            fs.copyFileSync(changedPath, replacement);
          }
          const database = new (requireNodeSqlite().DatabaseSync)(mutationPath);
          try {
            database.exec(
              `PRAGMA journal_mode=DELETE; PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`,
            );
          } finally {
            database.close();
          }
          if (change === "replacement") {
            fs.renameSync(replacement, changedPath);
          }
        }
        expect(await fleet.inspect()).toMatchObject({
          incompatible: [
            {
              kind: "agent",
              path: changedPath,
              foundVersion: OPENCLAW_AGENT_SCHEMA_VERSION + 1,
            },
          ],
          indeterminate: [],
        });
        expect(fleet.onAgentInspection).toHaveBeenLastCalledWith(
          expect.objectContaining({ schemaInspectionCount: 1 }),
        );
      });
    } finally {
      writer?.close();
    }
  },
);

it("does not let prepared compatibility bypass cancellation or survive startup retirement", async () => {
  const fleet = createFleet();
  await withAgentDatabaseStartupAdmission(async (admission) => {
    await fleet.ready();
    const controller = new AbortController();
    const cancellation = new Error("startup cancelled after fleet admission");
    controller.abort(cancellation);
    fleet.onAgentInspection.mockClear();
    await expect(fleet.inspect(controller.signal)).rejects.toBe(cancellation);
    expect(fleet.onAgentInspection).not.toHaveBeenCalled();
    await admission.stop();
    expect(await fleet.inspect()).toEqual({ incompatible: [], indeterminate: [] });
    expect(fleet.onAgentInspection).toHaveBeenLastCalledWith(
      expect.objectContaining({ schemaInspectionCount: fleet.paths.length }),
    );
  });
});
