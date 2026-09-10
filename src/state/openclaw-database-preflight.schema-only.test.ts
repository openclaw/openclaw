import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import * as snapshots from "../infra/sqlite-readonly-location.js";
import { acquireStateDatabaseHandleExclusion } from "../infra/state-database-coordinator.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("schema-only agent preflight", () => {
  it.each(["DELETE", "WAL"])(
    "checks fresh %s metadata without space for an agent snapshot",
    async (mode) => {
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
      const inspect = () =>
        preflightOpenClawDatabaseSchemas({
          env,
          verifyCurrentSchemaShape: true,
          supportedVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
        });
      try {
        expect(await inspect()).toEqual({ incompatible: [], indeterminate: [] });
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
        writer.exec(
          `PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION}; DROP INDEX idx_agent_cache_expiry;`,
        );
        expect(await inspect()).toMatchObject({
          incompatible: [],
          indeterminate: [
            {
              kind: "agent",
              path: agentPath,
              reason: expect.stringContaining("idx_agent_cache_expiry"),
            },
          ],
        });
      } finally {
        writer.close();
      }
    },
  );
});

it("uses the mutation owner's snapshot while that owner excludes source readers", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("schema-owned-snapshot-") };
  const agentPath = openOpenClawAgentDatabase({ agentId: "worker", env }).path;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  const snapshotPath = path.join(tempDirs.make("schema-owned-copy-"), "snapshot.sqlite");
  fs.copyFileSync(agentPath, snapshotPath);
  const exclusion = acquireStateDatabaseHandleExclusion({ databasePath: agentPath });
  const cleanup = vi.fn(() => true);
  try {
    await exclusion.runWithCanonicalMutation(
      () => exclusion.assertCurrent(),
      async () => {
        expect(
          await preflightOpenClawDatabaseSchemas({
            env,
            verifyCurrentSchemaShape: true,
            supportedVersions: {
              state: OPENCLAW_STATE_SCHEMA_VERSION,
              agent: OPENCLAW_AGENT_SCHEMA_VERSION,
            },
          }),
        ).toEqual({ incompatible: [], indeterminate: [] });
      },
      async (assertCurrent) => {
        assertCurrent();
        return { location: resolveImmutableSqliteFileUri(snapshotPath), cleanup };
      },
    );
  } finally {
    exclusion.release();
  }
  expect(cleanup).toHaveBeenCalledOnce();
});
