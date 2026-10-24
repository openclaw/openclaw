import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { migrateLegacyConfigHealth } from "../infra/state-migrations.runtime-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeMigrateAuthProfileJsonStoresToSqlite } from "./doctor-auth-flat-profiles.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
});
afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await state?.cleanup();
});

it("preserves malformed config-health bytes without importing replacement characters", async () => {
  const source = Buffer.concat([
    Buffer.from('{"entries":{"synthetic-config":{"lastKnownGood":{"hash":"caf'),
    Buffer.from([0xe9]),
    Buffer.from('"}}}}'),
  ]);
  const sourcePath = await state.writeText("logs/config-health.json", "");
  fs.writeFileSync(sourcePath, source);

  const result = migrateLegacyConfigHealth({
    detected: { sourcePath, hasLegacy: true },
    stateDir: state.stateDir,
  });

  expect(result.changes).toEqual([]);
  expect(result.warnings).toEqual([expect.stringContaining("valid UTF-8")]);
  expect(fs.readFileSync(sourcePath)).toEqual(source);
  expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
  expect(
    openOpenClawStateDatabase({ env: state.env })
      .db.prepare("SELECT config_path FROM config_health_entries")
      .all(),
  ).toEqual([]);
});

it.each([false, true])("preserves auth bytes across UTF-8 admission (valid=%s)", async (valid) => {
  const key = "synthetic-合法-�-😀";
  const source = Buffer.concat([
    Buffer.from(
      '{"version":1,"profiles":{"openai:default":{"type":"api_key","provider":"openai","key":"',
    ),
    valid ? Buffer.from(key) : Buffer.from([0xff]),
    Buffer.from('"}}}'),
  ]);
  const authPath = await state.writeText("agents/main/agent/auth-profiles.json", "");
  fs.writeFileSync(authPath, source);

  const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
    cfg: {},
    env: state.env,
    prompter: { confirmAutoFix: async () => true },
  });
  const profiles =
    loadPersistedSharedAuthProfileStore(state.env)?.profiles ??
    loadPersistedAuthProfileStore(state.agentDir())?.profiles;
  const archives = fs
    .readdirSync(path.dirname(authPath))
    .filter((name) => name.startsWith("auth-profiles.json.migrated-"));
  if (valid) {
    expect(result.warnings).toEqual([]);
    expect(profiles?.["openai:default"]).toMatchObject({ key });
    expect(archives).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(authPath), archives[0]!))).toEqual(source);
  } else {
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("valid UTF-8")]);
    expect(fs.readFileSync(authPath)).toEqual(source);
    expect(archives).toEqual([]);
    expect(profiles?.["openai:default"]).toBeUndefined();
  }
});
