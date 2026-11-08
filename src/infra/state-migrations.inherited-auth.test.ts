import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import * as ownership from "../agents/auth-profiles/path-resolve.js";
import * as paths from "../agents/auth-profiles/shared-main-dir.js";
import { inspectSharedAuthLegacyRowsReadOnly } from "../agents/auth-profiles/shared-store-bootstrap.js";
import * as sqlite from "../agents/auth-profiles/sqlite.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import * as stateDb from "../state/openclaw-state-db.js";
import * as doctor from "./state-migrations.doctor.js";
import * as migration from "./state-migrations.shared-auth-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  sqlite.closeAuthProfileReadPool();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await stateDb.closeOpenClawStateDatabaseAsync();
  stateDb.closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});
function makeStore(profileId: string, key: string) {
  return {
    version: 1,
    profiles: { [profileId]: { type: "api_key" as const, provider: "openai", key } },
  };
}
async function createEmptyFixture() {
  const stateDir = tempDirs.make("openclaw-inherited-auth-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_AGENT_DIR", "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_AGENT_DIR: undefined,
  };
  return { stateDir, env };
}
async function createFixture() {
  const fixture = await createEmptyFixture();
  const mainAgentDir = paths.resolveSharedMainAuthAgentDir(fixture.env);
  const opsAgentDir = path.join(fixture.stateDir, "agents/ops/agent");
  sqlite.writePersistedAuthProfileStoreRaw(makeStore("openai:shared", "shared-key"), mainAgentDir);
  sqlite.writePersistedAuthProfileStoreRaw(makeStore("openai:ops", "ops-key"), opsAgentDir);
  return { ...fixture, mainAgentDir, opsAgentDir };
}
describe("Doctor inherited auth owner", () => {
  it.each(["standard", "custom", "main override"] as const)(
    "relocates the configured inheritance owner through Doctor (%s)",
    async (layout) => {
      const fixture = await createEmptyFixture();
      const ownerDir = path.join(
        fixture.stateDir,
        layout === "custom" ? "custom-owner" : "agents/ops/agent",
      );
      const peerDir = path.join(fixture.stateDir, "agents/dev/agent");
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { authInheritance: { agentId: "ops" } },
          entries: { ops: { agentDir: ownerDir }, dev: {} },
        },
        plugins: { enabled: false },
      };
      const env: NodeJS.ProcessEnv = { ...fixture.env };
      if (layout === "main override") {
        env.OPENCLAW_AGENT_DIR = path.join(fixture.stateDir, "relocated-main");
      }
      const inherited = makeStore("openai:owner", "synthetic-owner-key");
      const privateStore = makeStore("openai:private", "synthetic-private-key");
      resolveAgentDir(config, "ops", env);
      sqlite.writePersistedAuthProfileStoreRaw(inherited, ownerDir);
      sqlite.writePersistedAuthProfileStoreRaw(privateStore, peerDir);
      const detected = await doctor.detectLegacyStateMigrations({
        cfg: config,
        env,
        doctorOnlyStateMigrations: true,
        pluginSessionStoreAgentIds: [],
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      const result = await migration.migrateSharedAuthStore({
        detected: detected.sharedAuthStore,
        stateDir: fixture.stateDir,
        env,
      });
      expect(result.warnings).toEqual([]);
      expect(result.notices).toBeUndefined();
      expect(sqlite.readPersistedSharedAuthProfileStoreRaw(env)).toEqual(inherited);
      expect(sqlite.readPersistedAuthProfileStoreRaw(ownerDir)).toBeNull();
      expect(sqlite.readPersistedAuthProfileStoreRaw(peerDir)).toEqual(privateStore);
      expect(loadAuthProfileStoreWithoutExternalProfiles(peerDir).profiles).toEqual({
        ...inherited.profiles,
        ...privateStore.profiles,
      });
      const database = stateDb.openOpenClawStateDatabase({ env }).db;
      expect(
        database
          .prepare(
            "SELECT DISTINCT source_path FROM migration_sources WHERE migration_kind = 'shared-auth-store-state-db'",
          )
          .all(),
      ).toEqual([{ source_path: path.join(ownerDir, "openclaw-agent.sqlite") }]);
      expect(
        migration.detectSharedAuthStoreMigration({
          stateDir: fixture.stateDir,
          env,
          config,
          doctorOnlyStateMigrations: true,
        }).hasLegacy,
      ).toBe(false);
    },
  );

  it.each(["empty owner", "directory alias"] as const)(
    "preserves main-source relocation with a configured %s",
    async (scenario) => {
      const fixture = await createEmptyFixture();
      const mainDir = paths.resolveSharedMainAuthAgentDir(fixture.env);
      const ownerDir = path.join(fixture.stateDir, "ops-alias");
      const store = makeStore("openai:shared", "synthetic-main-key");
      sqlite.writePersistedAuthProfileStoreRaw(store, mainDir);
      if (scenario === "directory alias") {
        fs.symlinkSync(mainDir, ownerDir, process.platform === "win32" ? "junction" : "dir");
      }
      const detected = migration.detectSharedAuthStoreMigration({
        stateDir: fixture.stateDir,
        env: fixture.env,
        config: {
          agents: {
            defaults: { authInheritance: { agentId: "ops" } },
            entries: { ops: { agentDir: ownerDir } },
          },
        },
        doctorOnlyStateMigrations: true,
      });
      expect(detected.ownerId).toBeUndefined();
      const result = await migration.migrateSharedAuthStore({
        detected,
        stateDir: fixture.stateDir,
        env: fixture.env,
      });
      expect(result.warnings).toEqual([]);
      expect(result.notices).toEqual([
        "The main agent no longer owns shared credentials and can now be deleted.",
      ]);
      expect(sqlite.readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(store);
      expect(sqlite.readPersistedAuthProfileStoreRaw(mainDir)).toBeNull();
    },
  );

  it.each(["credentials", "malformed"])("keeps both stores when main contains %s", async (kind) => {
    const fixture = await createFixture();
    if (kind === "malformed") {
      sqlite.runAuthProfileWriteTransaction(fixture.mainAgentDir, (database) => {
        database.db
          .prepare("UPDATE auth_profile_store SET store_json = ? WHERE store_key = 'primary'")
          .run("not-json");
      });
    }
    const config: OpenClawConfig = {
      agents: { defaults: { authInheritance: { agentId: "ops" } }, entries: { ops: {} } },
    };
    const mainPath = path.join(fixture.mainAgentDir, "openclaw-agent.sqlite");
    const beforeMain = inspectSharedAuthLegacyRowsReadOnly(mainPath);
    const detected = migration.detectSharedAuthStoreMigration({
      stateDir: fixture.stateDir,
      env: fixture.env,
      config,
      doctorOnlyStateMigrations: true,
    });
    const result = await migration.migrateSharedAuthStore({
      detected,
      stateDir: fixture.stateDir,
      env: fixture.env,
    });
    expect(result).toMatchObject({
      changes: [],
      outcome: "skipped",
      warningDisposition: "recoverable",
      warnings: [expect.stringContaining("also stores credentials")],
    });
    expect(sqlite.readPersistedAuthProfileStoreRaw(fixture.opsAgentDir)).toEqual(
      makeStore("openai:ops", "ops-key"),
    );
    expect(inspectSharedAuthLegacyRowsReadOnly(mainPath)).toEqual(beforeMain);
    expect(ownership.resolveSharedAuthStoreOwnership(fixture.env)).toEqual({
      location: "legacy-main",
    });
  });
});
