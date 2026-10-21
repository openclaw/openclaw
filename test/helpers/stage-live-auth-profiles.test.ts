import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../../src/agents/auth-profiles/sqlite.js";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../../src/state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../src/state/openclaw-state-db.js";
import { stageLiveAuthProfiles } from "./stage-live-auth-profiles.js";
import { createTempDirTracker } from "./temp-dir.js";

const tempDirs = createTempDirTracker();
const agentDir = (stateDir: string) => path.join(stateDir, "agents", "main", "agent");

function createAuthSource(stateDir: string): string {
  const source = agentDir(stateDir);
  runAuthProfileWriteTransaction(
    source,
    (database) => {
      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: {
            "openai:test": {
              type: "api_key",
              provider: "openai",
              keyRef: { source: "env", provider: "default", id: "OPENCLAW_LIVE_OPENAI_KEY" },
            },
          },
        },
        source,
        database,
      );
      writePersistedAuthProfileStateRaw({ version: 1 }, source, database);
    },
    { stateDir },
  );
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  return source;
}

function stagingFixture(sql: string) {
  const source = tempDirs.make("openclaw-live-auth-source-");
  const target = tempDirs.make("openclaw-live-auth-target-");
  const database = openNodeSqliteDatabase(resolveAuthProfileDatabasePath(createAuthSource(source)));
  database.exec(sql);
  database.close();
  return { stage: () => stageLiveAuthProfiles(source, target), target: agentDir(target) };
}

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

it.each([
  "DROP TABLE auth_profile_store;",
  "DROP TABLE auth_profile_state;",
  "DROP TABLE auth_profile_store; DROP TABLE auth_profile_state;",
])("fails closed for incomplete auth schema: %s", async (sql) => {
  const fixture = stagingFixture(sql);
  await expect(fixture.stage()).rejects.toThrow("canonical auth schema is incomplete");
  expect(fs.existsSync(resolveAuthProfileDatabasePath(fixture.target))).toBe(false);
});

it("stages a readable store when the state row is absent", async () => {
  const fixture = stagingFixture("DELETE FROM auth_profile_state;");
  await expect(fixture.stage()).resolves.toBeUndefined();
  expect(inspectPersistedAuthProfileStoreRaw(fixture.target).status).toBe("readable");
  expect(inspectPersistedAuthProfileStateRaw(fixture.target)).toEqual({
    status: "missing",
    reason: "row",
  });
});
