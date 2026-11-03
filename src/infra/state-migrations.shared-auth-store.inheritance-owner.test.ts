import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import * as ownership from "../agents/auth-profiles/path-resolve.js";
import * as paths from "../agents/auth-profiles/shared-main-dir.js";
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
    profiles: {
      [profileId]: { type: "api_key" as const, provider: "openai", key },
    },
  };
}

function createEmptyFixture() {
  const stateDir = tempDirs.make("openclaw-shared-auth-owner-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_AGENT_DIR", "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_AGENT_DIR: undefined,
  };
  const sourcePath = sqlite.resolveAuthProfileDatabasePath(
    paths.resolveSharedMainAuthAgentDir(env),
  );
  return { env, stateDir, sourcePath };
}

function createFixture() {
  const fixture = createEmptyFixture();
  const mainAgentDir = paths.resolveSharedMainAuthAgentDir(fixture.env);
  const opsAgentDir = path.join(fixture.stateDir, "agents", "ops", "agent");
  sqlite.writePersistedAuthProfileStoreRaw(makeStore("openai:shared", "shared-key"), mainAgentDir);
  sqlite.writePersistedAuthProfileStoreRaw(makeStore("openai:ops", "ops-key"), opsAgentDir);
  return { ...fixture, mainAgentDir, opsAgentDir };
}

function detectLegacy(env: NodeJS.ProcessEnv, config: OpenClawConfig) {
  return doctor.detectLegacyStateMigrations({
    cfg: { ...config, plugins: { enabled: false } },
    env,
    doctorOnlyStateMigrations: true,
    pluginSessionStoreAgentIds: [],
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });
}

function localAuthStore(agentDir: string) {
  return sqlite.readPersistedAuthProfileStoreRaw(agentDir);
}

it.each(["standard", "custom", "main override"] as const)(
  "relocates the configured inheritance owner through Doctor (%s)",
  async (layout) => {
    const fixture = createEmptyFixture();
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
    };
    if (layout === "main override") {
      fixture.env.OPENCLAW_AGENT_DIR = path.join(fixture.stateDir, "relocated-main");
    }
    const inherited = makeStore("openai:owner", "synthetic-owner-key");
    const privateStore = makeStore("openai:private", "synthetic-private-key");
    resolveAgentDir(config, "ops", fixture.env);
    sqlite.writePersistedAuthProfileStoreRaw(inherited, ownerDir);
    sqlite.writePersistedAuthProfileStoreRaw(privateStore, peerDir);
    const detected = await detectLegacy(fixture.env, config);

    expect(
      await migration.migrateSharedAuthStore({
        detected: detected.sharedAuthStore,
        stateDir: fixture.stateDir,
        env: fixture.env,
      }),
    ).toMatchObject({ warnings: [] });
    expect(sqlite.readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(inherited);
    expect(localAuthStore(ownerDir)).toBeNull();
    expect(localAuthStore(peerDir)).toEqual(privateStore);
    expect(loadAuthProfileStoreWithoutExternalProfiles(peerDir).profiles).toEqual({
      ...inherited.profiles,
      ...privateStore.profiles,
    });
    const db = stateDb.openOpenClawStateDatabase({ env: fixture.env }).db;
    expect(
      db
        .prepare(
          "SELECT DISTINCT source_path FROM migration_sources WHERE migration_kind = 'shared-auth-store-state-db'",
        )
        .all(),
    ).toEqual([{ source_path: path.join(ownerDir, "openclaw-agent.sqlite") }]);
    expect((await detectLegacy(fixture.env, config)).sharedAuthStore.hasLegacy).toBe(false);
  },
);

it("keeps both credential stores when the configured owner and main are populated", async () => {
  const fixture = createFixture();
  const detected = await detectLegacy(fixture.env, {
    agents: { defaults: { authInheritance: { agentId: "ops" } }, entries: { ops: {} } },
  });
  const before = [localAuthStore(fixture.mainAgentDir), localAuthStore(fixture.opsAgentDir)];

  expect(
    await migration.migrateSharedAuthStore({
      detected: detected.sharedAuthStore,
      stateDir: fixture.stateDir,
      env: fixture.env,
    }),
  ).toMatchObject({
    changes: [],
    outcome: "skipped",
    warningDisposition: "recoverable",
    warnings: [expect.stringContaining("also stores credentials")],
  });
  expect([localAuthStore(fixture.mainAgentDir), localAuthStore(fixture.opsAgentDir)]).toEqual(
    before,
  );
  expect(ownership.resolveSharedAuthStoreOwnership(fixture.env)).toEqual({
    location: "legacy-main",
  });
});

it.each(["empty owner", "directory alias"] as const)(
  "preserves main-source relocation with a configured %s",
  async (scenario) => {
    const fixture = createEmptyFixture();
    const mainDir = path.dirname(fixture.sourcePath);
    const ownerDir = path.join(fixture.stateDir, "ops-alias");
    const store = makeStore("openai:shared", "synthetic-main-key");
    sqlite.writePersistedAuthProfileStoreRaw(store, mainDir);
    if (scenario === "directory alias") {
      fs.symlinkSync(mainDir, ownerDir, process.platform === "win32" ? "junction" : "dir");
    }
    const detected = await detectLegacy(fixture.env, {
      agents: {
        defaults: { authInheritance: { agentId: "ops" } },
        entries: { ops: { agentDir: ownerDir } },
      },
    });

    expect(
      await migration.migrateSharedAuthStore({
        detected: detected.sharedAuthStore,
        stateDir: fixture.stateDir,
        env: fixture.env,
      }),
    ).toMatchObject({ warnings: [] });
    expect(sqlite.readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(store);
    expect(localAuthStore(mainDir)).toBeNull();
  },
);
