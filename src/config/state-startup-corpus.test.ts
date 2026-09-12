import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles.js";
import { acquireReadOnlyPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { runDoctorConfigPreflight } from "../commands/doctor-config-preflight.js";
import { applyLegacyCompatibilityStep } from "../commands/doctor/shared/config-flow-steps.js";
import { normalizeCompatibilityConfigValues } from "../commands/doctor/shared/legacy-config-core-migrate.js";
import { loadCronJobsStore, resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { loadGatewayStartupConfigSnapshot } from "../gateway/server-startup-config-helpers.js";
import { runStartupSessionMigration } from "../gateway/server-startup-session-migration.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesAsync,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { getUserPreferences } from "../state/user-preferences.js";
import { createConfigIO } from "./io.js";
import {
  readRecentUserAssistantTextForSession,
  resolveDefaultSessionStorePath,
} from "./sessions.js";
import { loadSessionEntryReadOnly } from "./sessions/session-accessor.js";

type StateFixture = {
  release: string;
  sessions: Array<{
    agentId: string;
    sessionKey: string;
    sessionId: string;
    transcriptText: string;
  }>;
  profiles: Record<string, Record<string, unknown>>;
  cronJob: {
    id: string;
    name: string;
    enabled: false;
    schedule: { kind: "every"; everyMs: number };
    sessionTarget: "main";
    wakeMode: "next-heartbeat";
    payload: { kind: "systemEvent"; text: string };
  };
  cronStorePath: string;
  controlUi: { userId: string; settings: Record<string, unknown> };
};

const corpusDir = fileURLToPath(new URL("../../test/fixtures/state-corpus/", import.meta.url));
const configCorpusDir = fileURLToPath(
  new URL("../../test/fixtures/config-corpus/", import.meta.url),
);
const releases = fs
  .readdirSync(corpusDir)
  .filter((name) => fs.statSync(path.join(corpusDir, name)).isDirectory())
  .toSorted();
const configNames = fs
  .readdirSync(configCorpusDir)
  .filter((name) => name.endsWith(".json"))
  .toSorted();
const cases = releases.flatMap((release) =>
  configNames.map((configName) => [release, configName] as const),
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function prepareState(release: string, configName: string) {
  const home = tempDirs.make("openclaw-state-corpus-");
  const stateDir = path.join(home, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  fs.cpSync(path.join(corpusDir, release, "state"), stateDir, { recursive: true });
  const fixture: StateFixture = JSON.parse(
    fs.readFileSync(path.join(corpusDir, release, "manifest.json"), "utf8"),
  );
  for (const [key, value] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_TEST_HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../extensions/", import.meta.url)),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
  })) {
    vi.stubEnv(key, value);
  }
  const pluginDir = path.join(home, "external-plugin");
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture-extension",
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: { apiKey: { type: "string" } },
      },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.ts"),
    'export default { id: "fixture-extension", register() {} };\n',
  );
  const config: unknown = JSON.parse(
    fs.readFileSync(path.join(configCorpusDir, configName), "utf8"),
    (_key, value: unknown) =>
      typeof value === "string" && value.startsWith("/home/fixture/")
        ? path.join(home, value.slice("/home/fixture/".length))
        : value,
  );
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { home, stateDir, configPath, fixture };
}

function assertDatabaseIntegrity(stateDir: string, fixture: StateFixture) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const databases = [
    { path: resolveOpenClawStateSqlitePath(env), version: OPENCLAW_STATE_SCHEMA_VERSION },
    ...[...new Set(fixture.sessions.map((session) => session.agentId))].map((agentId) => ({
      path: resolveOpenClawAgentSqlitePath({ agentId, env }),
      version: OPENCLAW_AGENT_SCHEMA_VERSION,
    })),
  ];
  for (const target of databases) {
    const database = openNodeSqliteDatabase(target.path, { readOnly: true });
    try {
      expect(database.prepare("PRAGMA integrity_check").all(), target.path).toEqual([
        { integrity_check: "ok" },
      ]);
      expect(database.prepare("PRAGMA user_version").get(), target.path).toEqual({
        user_version: target.version,
      });
    } finally {
      database.close();
    }
  }
}

describe("prior-release state startup corpus", () => {
  it("retains the previous stable and frozen fleet releases", () => {
    expect(releases).toEqual(expect.arrayContaining(["2026.9.2", "2026.9.3-95f3ed9"]));
  });

  // These released snapshots retain POSIX cron partition keys, not Windows-native paths.
  it.skipIf(process.platform === "win32").each(cases)(
    "%s × %s preserves state through Doctor and Gateway startup",
    async (release, configName) => {
      const { home, stateDir, configPath, fixture } = prepareState(release, configName);
      const io = createConfigIO({
        configPath,
        env: process.env,
        homedir: () => home,
        observe: false,
      });
      try {
        const snapshot = await io.readConfigFileSnapshot();
        const migrated = applyLegacyCompatibilityStep({
          snapshot,
          state: {
            cfg: snapshot.sourceConfig,
            candidate: snapshot.sourceConfig,
            pendingChanges: false,
            fixHints: [],
          },
          shouldRepair: true,
          doctorFixCommand: "openclaw doctor --fix",
        });
        const normalized = normalizeCompatibilityConfigValues(migrated.state.candidate, {
          sourceRaw: snapshot.parsed,
          sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
        });
        fs.writeFileSync(configPath, JSON.stringify(normalized.config));
        // Repeat the real repair path: a second run must preserve the same records.
        for (let pass = 0; pass < 2; pass += 1) {
          await runDoctorConfigPreflight({
            observe: false,
            repairPrefixedConfig: true,
            doctorOnlyStateMigrations: true,
            preparePluginMetadataSnapshot: true,
          });
          await runDoctorConfigPreflight({
            observe: false,
            requireStartupMigrationCheckpoint: true,
          });
          const startup = await loadGatewayStartupConfigSnapshot({
            initialSnapshotRead: await io.readConfigFileSnapshotWithPluginMetadata(),
            minimalTestGateway: false,
            log: console,
          });
          const config = startup.snapshot.config;
          await runStartupSessionMigration({ cfg: config, log: console });
          for (const session of fixture.sessions) {
            const target = {
              agentId: session.agentId,
              sessionKey: session.sessionKey,
              storePath: resolveDefaultSessionStorePath(session.agentId),
            };
            expect(loadSessionEntryReadOnly(target), session.sessionKey).toMatchObject({
              sessionId: session.sessionId,
            });
            expect(
              await readRecentUserAssistantTextForSession(target),
              session.sessionKey,
            ).toContainEqual(expect.objectContaining({ text: session.transcriptText }));
          }
          const auth = loadAuthProfileStoreWithoutExternalProfiles(
            path.join(stateDir, "agents", "main", "agent"),
          );
          for (const [profileId, credential] of Object.entries(fixture.profiles)) {
            expect(auth.profiles[profileId], profileId).toMatchObject(credential);
          }
          const cronPath = resolveCronJobsStorePathFromConfig(config);
          expect(cronPath).toBe(fixture.cronStorePath);
          const cron = await loadCronJobsStore(cronPath);
          expect(cron.jobs.find((job) => job.id === fixture.cronJob.id)).toMatchObject(
            fixture.cronJob,
          );
          expect(getUserPreferences(fixture.controlUi.userId)).toMatchObject(
            fixture.controlUi.settings,
          );
          for (const agentId of listAgentIds(config)) {
            const lease = await acquireReadOnlyPreparedModelRuntime(
              {
                config,
                agentId,
                agentDir: path.join(stateDir, "agents", agentId, "agent"),
                workspaceDir: path.join(home, "workspaces", agentId),
                env: process.env,
                readOnly: true,
                skipCredentials: true,
              },
              { catalogMode: "static" },
            );
            try {
              if (configName === "generic-github-token.json") {
                expect(lease.snapshot.modelCatalog.entries).toEqual([]);
              } else {
                expect(lease.snapshot.modelCatalog.entries.length).toBeGreaterThan(0);
              }
            } finally {
              await lease[Symbol.asyncDispose]();
            }
          }
          await closeOpenClawAgentDatabasesAsync(stateDir);
          closeOpenClawStateDatabase();
          assertDatabaseIntegrity(stateDir, fixture);
        }
      } finally {
        await closeOpenClawAgentDatabasesAsync(stateDir);
        closeOpenClawStateDatabase();
      }
    },
    120_000,
  );
});
