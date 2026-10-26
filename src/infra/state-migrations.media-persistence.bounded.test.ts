import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import { prepareDoctorDatabaseMigrations } from "../commands/doctor-schema-migrations.js";
import { withDoctorSqliteMaintenanceLock } from "../commands/doctor-sqlite-maintenance-lock.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_V25_SQL } from "../state/openclaw-agent-schema-v25.test-support.js";
import {
  readPersistedQuarantineRow,
  seedOpenClawDatabaseQuarantine,
} from "../state/openclaw-quarantine-store.test-support.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { corruptSqliteIndexKey } from "./sqlite-index-corruption.test-support.js";
import { prepareAgentDatabaseMigrationDiscovery } from "./state-migrations.media-persistence-targets.js";
import {
  cleanupMediaPersistenceFixtures,
  createEvent,
  createLegacyDatabaseFixture,
} from "./state-migrations.media-persistence.test-support.js";
import { buildLegacyStateMigrationPreludeSteps } from "./state-migrations.prelude.js";
import { runLegacyStateMigrationSteps } from "./state-migrations.steps.js";

const tempDirs: string[] = [];
afterEach(() => cleanupMediaPersistenceFixtures(tempDirs));
const content = (event: unknown) => JSON.parse(String(event)).message.content;
const legacyEntry = '{"sessionId":"retained","updatedAt":1,"memoryFlushCompactionCount":3}';
const makeEvent = (id: string, extra: Record<string, unknown> = {}, text = id) =>
  createEvent({
    id,
    parentId: null,
    timestamp: 1,
    message: {
      role: "assistant",
      content: [{ type: "text", text: `[[reply_to_current]] ${text}` }],
      ...extra,
    },
  });

function retainedDatabase(version: 25 | 26) {
  const stateDir = makeTempDir(tempDirs, `media-bounded-v${version}-`);
  const env = { OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  const pathname = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  using database = openNodeSqliteDatabase(pathname);
  database.exec(
    version === 25
      ? OPENCLAW_AGENT_SCHEMA_V25_SQL
      : fs.readFileSync(
          new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v26.sql", import.meta.url),
          "utf8",
        ),
  );
  database.exec(`PRAGMA user_version = ${version}`);
  database
    .prepare(`INSERT INTO schema_meta
    (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
    VALUES ('primary', 'agent', ?, 'main', ?, 1, 1)`)
    .run(version, version === 25 ? "2026.9.9" : null);
  database
    .prepare(`INSERT INTO session_nodes
    (session_key, current_session_id, entry_json, entry_valid, updated_at)
    VALUES ('agent:main:retained', 'retained', ?, 1, 1)`)
    .run(legacyEntry);
  database.exec(`INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
    VALUES ('retained', 'agent:main:retained', 1, 1)`);
  if (version === 26) {
    fs.chmodSync(pathname, 0o600);
  }
  return { stateDir, env, pathname };
}

function withMaintenance<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>) {
  return withDoctorSqliteMaintenanceLock({
    env,
    operation: "bounded agent migration",
    run: async (authority) => {
      const scope = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: () => authority.assertCurrent(),
      });
      try {
        return await scope.run(run);
      } finally {
        await scope.close();
      }
    },
  });
}

function runPrelude(
  stateDir: string,
  agentDatabaseTargets: { agentId: string; path: string }[],
  extra: Partial<Parameters<typeof buildLegacyStateMigrationPreludeSteps>[0]> = {},
  includeDirectives = false,
) {
  return runLegacyStateMigrationSteps(
    buildLegacyStateMigrationPreludeSteps({
      mode: "doctor",
      invocationPurpose: "doctor",
      config: {
        agents: {
          ownership: "explicit",
          entries: Object.fromEntries(agentDatabaseTargets.map(({ agentId }) => [agentId, {}])),
        },
      },
      configPath: path.join(stateDir, "openclaw.json"),
      configIncludedPaths: [],
      stateDir,
      env: { OPENCLAW_STATE_DIR: stateDir },
      homedir: () => stateDir,
      agentDatabaseTargets,
      pluginSessionStoreAgentIds: [],
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      ...extra,
    }).filter(({ id }) =>
      [
        "session-entry-state-preparation",
        "media-persistence",
        "session-entry-state",
        ...(includeDirectives ? ["transcript-directives"] : []),
      ].includes(id),
    ),
  );
}

function readState(file: string) {
  using db = openNodeSqliteDatabase(file, { readOnly: true });
  const row = (sql: string) => db.prepare(sql).get();
  return {
    version: row("PRAGMA user_version")?.user_version,
    event: row("SELECT event_json FROM transcript_events")?.event_json,
    trajectory: row("SELECT event_json FROM trajectory_runtime_events")?.event_json,
    stat: row("SELECT stat FROM sqlite_stat1 WHERE idx = 'idx_agent_cache_updated'")?.stat,
    archive: row("SELECT archive_blob, published_at FROM session_transcript_archives"),
    media: row("SELECT 1 FROM schema_meta WHERE meta_key = 'media-persistence-rows-v1'"),
    directives: row(
      "SELECT 1 FROM schema_meta WHERE meta_key = 'historical-transcript-directives-v1'",
    ),
    entry: row("SELECT entry_json FROM session_nodes")?.entry_json,
  };
}

it("keeps entry state outside a precommitted version-only migration", async () => {
  const { stateDir, env, pathname } = retainedDatabase(26);
  const target = { agentId: "main", path: pathname };
  const preparedDiscovery = prepareAgentDatabaseMigrationDiscovery({
    env,
    configuredAgentDatabaseTargets: [target],
  });
  const result = await withMaintenance(env, async () => {
    const prepared = await prepareDoctorDatabaseMigrations({
      env,
      check: "quick",
      pendingDatabasePaths: [pathname],
      pendingMigrations: [
        {
          kind: "agent",
          ...target,
          foundVersion: 26,
          supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      ],
      databasePaths: [pathname],
      agentDatabaseTargets: [
        { ...target, realPath: fs.realpathSync.native(pathname), source: "configured" },
      ],
    });
    preparedDiscovery.versionMigrations = prepared.versionMigrations;
    const execution = await runPrelude(stateDir, [target], {
      agentDatabaseMigrationDiscovery: preparedDiscovery,
    });
    return { prepared, execution };
  });

  expect(result.prepared.versionMigrations).toEqual([
    expect.objectContaining({ kind: "agent", path: pathname, foundVersion: 26 }),
  ]);
  expect(result.execution.receipts.map((receipt) => [receipt.id, receipt.outcome])).toEqual([
    ["session-entry-state-preparation", "skipped"],
    ["media-persistence", "skipped"],
    ["session-entry-state", "skipped"],
  ]);
  expect(result.execution.sources.flatMap((source) => source.warnings)).toEqual([]);
  using database = openNodeSqliteDatabase(pathname, { readOnly: true });
  const row = (sql: string) => database.prepare(sql).get();
  expect(row("PRAGMA user_version")?.user_version).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  expect(row("SELECT entry_json FROM session_nodes")?.entry_json).toBe(legacyEntry);
  expect(
    row("SELECT 1 FROM schema_meta WHERE meta_key = 'media-persistence-rows-v1'"),
  ).toBeUndefined();
});

it.each([
  { name: "completes entry and media repair after quarantine recovery", malformedMedia: false },
  { name: "reports committed entry repair when resumed media refuses", malformedMedia: true },
])("$name", async ({ malformedMedia }) => {
  const stateDir = makeTempDir(
    tempDirs,
    `media-bounded-quarantine-${malformedMedia ? "refusal" : "success"}-`,
  );
  const env = { OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  const pathname = createLegacyDatabaseFixture({
    agentId: "main",
    env,
    schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    eventsBySession: {
      "index-original": [
        makeEvent("index-original", { MediaPath: "/media/recovered.png" }, "recovered"),
      ],
    },
  });
  const sessionKey = "agent:main:index-original";
  {
    using database = openNodeSqliteDatabase(pathname);
    database
      .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
      .run(
        '{"sessionId":"index-original","updatedAt":1,"memoryFlushCompactionCount":2}',
        sessionKey,
      );
    if (malformedMedia) {
      database.prepare("UPDATE transcript_events SET event_json = 'not json'").run();
    }
  }
  const index = "sqlite_autoindex_session_nodes_1";
  corruptSqliteIndexKey(pathname, index, "index-original", "index-damaged!");
  seedOpenClawDatabaseQuarantine({
    env,
    kind: "agent",
    path: pathname,
    reason: `row 1 missing from index ${index}`,
  });

  const result = await withMaintenance(env, () =>
    runPrelude(stateDir, [{ agentId: "main", path: pathname }]),
  );

  const mediaReceipt = result.receipts.find((receipt) => receipt.id === "media-persistence");
  const entryReceipt = result.receipts.find((receipt) => receipt.id === "session-entry-state");
  expect(result.receipts).toMatchObject([
    { id: "session-entry-state-preparation", outcome: "skipped" },
    { id: "media-persistence", outcome: malformedMedia ? "refused" : "completed" },
    { id: "session-entry-state", outcome: malformedMedia ? "refused" : "skipped" },
  ]);
  expect(mediaReceipt?.changes).toContain(
    `Warning: Rebuilt corrupt agent main SQLite indexes: ${index}. No table rows were removed.`,
  );
  expect(mediaReceipt?.changes).toContain(
    "Canonicalized entry state for 1 durable session row(s).",
  );
  expect(entryReceipt?.changes).toEqual([]);
  expect(readPersistedQuarantineRow(pathname, { env })).toBeUndefined();
  using database = openNodeSqliteDatabase(pathname, { readOnly: true });
  const row = (sql: string) => database.prepare(sql).get();
  expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(JSON.parse(String(row("SELECT entry_json FROM session_nodes")?.entry_json))).toMatchObject(
    {
      sessionId: "index-original",
      memoryFlush: { kind: "succeeded", compactionCount: 2 },
    },
  );
  if (malformedMedia) {
    expect(mediaReceipt?.warnings).not.toEqual([]);
    expect(entryReceipt).toMatchObject({ originatingRefusal: { stepId: "media-persistence" } });
    return;
  }
  expect(result.sources.flatMap((source) => source.warnings)).toEqual([]);
  expect(
    row("SELECT 1 FROM schema_meta WHERE meta_key = 'media-persistence-rows-v1'"),
  ).toBeDefined();
  const migratedEvent = row("SELECT event_json FROM transcript_events")?.event_json;
  expect(content(migratedEvent)).toEqual([
    { type: "text", text: "[[reply_to_current]] recovered" },
  ]);
  const message = JSON.parse(String(migratedEvent)).message;
  expect(message).not.toHaveProperty("MediaPath");
  expect(message["__openclaw"]).toMatchObject({
    media: [expect.objectContaining({ path: "/media/recovered.png" })],
  });
});

it("keeps unrelated legacy content and planner maintenance outside a version migration", async () => {
  const { stateDir, env, pathname } = retainedDatabase(25);
  const event = JSON.stringify(makeEvent("retained", { MediaPath: "/media/retained.png" }));
  const trajectory = JSON.stringify({
    data: { messagesSnapshot: [{ role: "user", MediaPath: "/media/retained.png" }] },
  });
  const archive = Buffer.from(`${event}\n`);
  const archiveName = "retained.jsonl.deleted.2026-07-24T01-02-03.000Z";
  const archivePath = path.join(
    resolveSqliteTranscriptArchiveDirectory({ agentId: "main", path: pathname }),
    archiveName,
  );
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, archive);
  {
    using source = openNodeSqliteDatabase(pathname);
    source.exec(`
      INSERT INTO cache_entries (scope, key, value_json, updated_at)
        VALUES ('planner-proof', 'retained', '{}', 1);
    `);
    for (const [table, json] of [
      ["transcript_events", event],
      ["trajectory_runtime_events", trajectory],
    ] as const) {
      source
        .prepare(
          `INSERT INTO ${table} (session_id, seq, event_json, created_at) VALUES ('retained', 0, ?, 1)`,
        )
        .run(json);
    }
    source
      .prepare(`INSERT INTO session_transcript_archives
        (session_id, generation, session_key, reason, encoding, archive_blob, archive_sha256, archive_name, created_at)
        VALUES ('retained', 'generation', 'agent:main:retained', 'deleted', 'identity', ?, ?, ?, 1)`)
      .run(archive, createHash("sha256").update(archive).digest("hex"), archiveName);
    source.exec(`
      ANALYZE;
      UPDATE sqlite_stat1 SET stat = '7 1 1 1' WHERE idx = 'idx_agent_cache_updated';
    `);
  }
  registerOpenClawAgentDatabase({ agentId: "main", env, path: pathname, schemaVersion: 25 });
  const currentPath = createLegacyDatabaseFixture({
    agentId: "current",
    env,
    schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    eventsBySession: { current: [makeEvent("current")] },
  });
  const migrate = () =>
    withMaintenance(env, async () => {
      const { sources } = await runPrelude(
        stateDir,
        [
          { agentId: "main", path: pathname },
          { agentId: "current", path: currentPath },
        ],
        {},
        true,
      );
      return {
        changes: sources.flatMap((source) => source.changes),
        warnings: sources.flatMap((source) => source.warnings),
      };
    });

  const result = await migrate();
  expect(result).toEqual({
    changes: [
      `Upgraded agent database schema in ${pathname}: v25 -> v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
      expect.stringMatching(/^Saved pre-repair SQLite backup: /),
      `Repaired historical transcripts in ${currentPath}: 1 active session(s), 0 archived transcript(s).`,
    ],
    warnings: [],
  });
  expect(fs.readFileSync(archivePath)).toEqual(archive);
  expect(readState(pathname)).toEqual({
    version: OPENCLAW_AGENT_SCHEMA_VERSION,
    event,
    trajectory,
    stat: "7 1 1 1",
    archive: { archive_blob: new Uint8Array(archive), published_at: null },
    media: undefined,
    directives: undefined,
    entry: legacyEntry,
  });
  {
    using current = openNodeSqliteDatabase(currentPath, { readOnly: true });
    expect(
      content(current.prepare("SELECT event_json FROM transcript_events").get()?.event_json),
    ).toEqual([{ type: "text", text: "current" }]);
  }

  // An explicit same-version Doctor invocation still owns outstanding repair.
  const repaired = await migrate();
  expect(repaired.warnings).toEqual([]);
  expect(repaired.changes).toContain(
    `Migrated media persistence in ${pathname}: 1 transcript session(s), 1 trajectory row(s), schema v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
  );
  expect(repaired.changes).toContain(
    `Migrated canonical transcript archive media in ${pathname}: 1 archive(s).`,
  );
  const sameVersion = readState(pathname);
  expect(sameVersion.archive?.archive_blob).toEqual(new Uint8Array(fs.readFileSync(archivePath)));
  expect(JSON.parse(String(sameVersion.entry))).toEqual({
    sessionId: "retained",
    updatedAt: 1,
    memoryFlush: { kind: "succeeded", compactionCount: 3 },
  });
  expect(content(sameVersion.event)).toEqual([{ type: "text", text: "retained" }]);
});
