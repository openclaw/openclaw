import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.sqlite-exact-read.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  repairCanonicalSessionDeliveryStates,
  repairCanonicalSessionResolvedSkills,
} from "./doctor-session-delivery-state.js";
import { repairReservedIncognitoSessionKeys } from "./doctor-session-incognito-key-repair.js";
import { rewriteDoctorSessionEntries } from "./doctor/shared/session-entry-rewrite.js";

const tempDirs = createTempDirTracker();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

function insertSessionRow(
  env: NodeJS.ProcessEnv,
  sessionKey: string,
  entry: Record<string, unknown>,
  agentId = "main",
): void {
  const database = openOpenClawAgentDatabase({ agentId, env });
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, parent_session_key, spawned_by) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      sessionKey,
      String(entry.sessionId),
      JSON.stringify(entry),
      Number(entry.updatedAt),
      typeof entry.parentSessionKey === "string" ? entry.parentSessionKey : null,
      typeof entry.spawnedBy === "string" ? entry.spawnedBy : null,
    );
  database.db
    .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
    .run(sessionKey);
  const legacyContext = entry.deliveryContext as Record<string, unknown> | undefined;
  database.db
    .prepare(
      "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at, channel, account_id) VALUES (?, ?, 'conversation', ?, ?, ?, ?)",
    )
    .run(
      String(entry.sessionId),
      sessionKey,
      Number(entry.updatedAt),
      Number(entry.updatedAt),
      typeof entry.channel === "string"
        ? entry.channel
        : typeof legacyContext?.channel === "string"
          ? legacyContext.channel
          : null,
      typeof entry.lastAccountId === "string"
        ? entry.lastAccountId
        : typeof legacyContext?.accountId === "string"
          ? legacyContext.accountId
          : null,
    );
}

function readEntryJson(env: NodeJS.ProcessEnv, sessionKey: string, agentId = "main"): string {
  const database = openOpenClawAgentDatabase({ agentId, env });
  const row = database.db
    .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
    .get(sessionKey) as { entry_json: string };
  return row.entry_json;
}

function makeEnv(prefix: string) {
  return { ...process.env, OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make(prefix)) };
}

function expectReport(
  actual: { found: number; repaired: number; scannedStores: number },
  found: number,
  repaired = found,
  scannedStores = 1,
) {
  expect(actual).toEqual({ found, repaired, scannedStores });
}

function readEntry(env: NodeJS.ProcessEnv, sessionKey: string) {
  return JSON.parse(readEntryJson(env, sessionKey));
}

function listEntries(env: NodeJS.ProcessEnv, agentId = "main", clone?: boolean) {
  return listSessionEntriesCore({ agentId, env, clone });
}

describe("doctor canonical session delivery state", () => {
  it.each([undefined, "full"] as const)(
    "uses requested integrity coverage for delivery repairs (%s)",
    (integrityCheck) => {
      const env = makeEnv("openclaw-delivery-integrity-");
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
      const sessionKey = "agent:main:delivery-integrity";
      const entry = {
        sessionId: "delivery-integrity-session",
        updatedAt: 10,
        displayName: "Retained title",
        channel: "slack",
        deliveryContext: { channel: "telegram", to: "recipient", accountId: "current-bot" },
        lastAccountId: "stale-slack-bot",
      };
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      {
        using database = new DatabaseSync(databasePath);
        database.exec(OPENCLAW_AGENT_SCHEMA_SQL);
        database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
        database
          .prepare(
            `INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
             VALUES ('primary', 'agent', ?, 'main', 1, 1)`,
          )
          .run(OPENCLAW_AGENT_SCHEMA_VERSION);
        database
          .prepare(
            "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, entry_valid) VALUES (?, ?, ?, ?, 1)",
          )
          .run(sessionKey, entry.sessionId, JSON.stringify(entry), entry.updatedAt);
        database
          .prepare(
            "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at, channel, account_id) VALUES (?, ?, 'conversation', 10, 10, 'slack', 'stale-slack-bot')",
          )
          .run(entry.sessionId, sessionKey);
        database.exec(`
          DROP INDEX idx_agent_cache_updated;
          CREATE INDEX idx_agent_cache_updated ON cache_entries(scope, key, updated_at);
          INSERT INTO cache_entries (scope, key, value_json, updated_at)
          VALUES ('retained', 'history', '"untouched"', 1);
        `);
        // An untouched index defect distinguishes QUICK from whole-database FULL.
        database.enableDefensive?.(false);
        database.exec("PRAGMA writable_schema = ON");
        database
          .prepare("UPDATE sqlite_schema SET sql = ? WHERE name = 'idx_agent_cache_updated'")
          .run(
            "CREATE INDEX idx_agent_cache_updated ON cache_entries(scope, updated_at DESC, key)",
          );
        database.exec("PRAGMA writable_schema = OFF");
      }

      const repair = () =>
        repairCanonicalSessionDeliveryStates({
          apply: true,
          cfg: {},
          env,
          integrityCheck,
          targets: [{ agentId: "main", storePath: databasePath, sqlitePath: databasePath }],
        });
      if (integrityCheck === "full") {
        expect(repair).toThrow(/integrity_check.*idx_agent_cache_updated/su);
      } else {
        expectReport(repair(), 1);
      }
      {
        using database = new DatabaseSync(databasePath, { readOnly: true });
        const repairedEntry = JSON.parse(
          database
            .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
            .get(sessionKey)?.entry_json as string,
        );
        if (integrityCheck === "full") {
          expect(repairedEntry).toEqual(entry);
        } else {
          expect(repairedEntry).toMatchObject({
            sessionId: entry.sessionId,
            updatedAt: 10,
            displayName: "Retained title",
            delivery: {
              context: { channel: "telegram", to: "recipient", accountId: "current-bot" },
            },
          });
          expect(repairedEntry).not.toHaveProperty("lastAccountId");
          expect(
            database.prepare("SELECT updated_at, account_id FROM session_windows").get(),
          ).toEqual({ updated_at: 10, account_id: "current-bot" });
        }
        expect(database.prepare("SELECT value_json FROM cache_entries").get()?.value_json).toBe(
          '"untouched"',
        );
      }
      if (integrityCheck !== "full") {
        expect(() => openOpenClawAgentDatabase({ agentId: "main", env })).toThrow(
          /integrity_check.*idx_agent_cache_updated/su,
        );
      }
    },
  );

  it("warns and skips an unmigrated agent database", () => {
    const env = makeEnv("openclaw-delivery-legacy-schema-");
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db.exec("PRAGMA user_version = 8;");
    closeOpenClawAgentDatabasesForTest();

    expectReport(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env }), 0);
  });

  it("publishes repaired delivery accounts to the existing SQLite connection without aging sessions", () => {
    const env = makeEnv("openclaw-delivery-warm-cache-");
    const sessionKey = "agent:main:delivery-warm-cache";
    insertSessionRow(env, sessionKey, {
      sessionId: "delivery-warm-cache-session",
      updatedAt: 10,
      channel: "slack",
      deliveryContext: { channel: "telegram", to: "recipient", accountId: "current-bot" },
      lastAccountId: "stale-slack-bot",
    });

    expect(listEntries(env)[0]?.entry).toMatchObject({
      updatedAt: 10,
      lastAccountId: "stale-slack-bot",
    });
    expectReport(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env }), 1);
    expect(readEntry(env, sessionKey)).toMatchObject({
      updatedAt: 10,
      delivery: { context: { accountId: "current-bot" } },
    });

    const repaired = listEntries(env)[0]?.entry;
    expect(repaired).toMatchObject({
      updatedAt: 10,
      delivery: { context: { accountId: "current-bot" } },
    });
    expect(repaired).not.toHaveProperty("lastAccountId");
  });

  it("publishes cross-agent incognito parent rewrites to each existing SQLite connection", async () => {
    const env = makeEnv("openclaw-incognito-warm-cache-");
    const oldParentKey = "agent:main:dashboard:incognito-warm-cache";
    const newParentKey = "agent:main:dashboard:legacy-incognito-warm-cache";
    const childKey = "agent:work:dashboard:child";
    insertSessionRow(env, oldParentKey, {
      sessionId: "incognito-parent-session",
      updatedAt: 10,
    });
    insertSessionRow(
      env,
      childKey,
      {
        sessionId: "incognito-child-session",
        updatedAt: 20,
        parentSessionKey: oldParentKey,
        spawnedBy: oldParentKey,
      },
      "work",
    );

    expect(listEntries(env, "work")[0]?.entry).toMatchObject({
      updatedAt: 20,
      parentSessionKey: oldParentKey,
    });
    expect(await repairReservedIncognitoSessionKeys({ apply: true, cfg: {}, env })).toEqual({
      found: 1,
      repaired: 1,
    });

    expect(listEntries(env, "work")[0]?.entry).toMatchObject({
      updatedAt: 20,
      parentSessionKey: newParentKey,
      spawnedBy: newParentKey,
    });
  });

  it("migrates a copied realistic store without touching the source or canonical row bytes", () => {
    const sourceEnv = makeEnv("openclaw-delivery-source-");
    const canonicalEntry = {
      sessionId: "canonical-session",
      updatedAt: 30,
      delivery: {
        kind: "external",
        route: { channel: "telegram", target: { to: "-1002" } },
        context: { channel: "telegram", to: "-1002" },
        origin: { provider: "telegram", to: "-1002" },
      },
    };
    insertSessionRow(sourceEnv, "agent:main:legacy", {
      sessionId: "legacy-session",
      updatedAt: 10,
      route: {
        channel: "webchat",
        accountId: "work",
        target: { to: "session:dashboard" },
        thread: { id: "thread-1" },
      },
      deliveryContext: { channel: "telegram", to: "-1001" },
      origin: {
        provider: "telegram",
        to: "-1001",
        chatType: "group",
        accountId: "work",
        threadId: "thread-1",
      },
      channel: "webchat",
      lastChannel: "webchat",
      lastTo: "session:dashboard",
      lastAccountId: "work",
      lastThreadId: "thread-1",
    });
    insertSessionRow(sourceEnv, "agent:main:internal", {
      sessionId: "internal-session",
      updatedAt: 20,
      channel: "webchat",
      lastChannel: "webchat",
      lastTo: "session:control",
    });
    insertSessionRow(sourceEnv, "agent:main:origin-stale", {
      sessionId: "origin-stale-session",
      updatedAt: 25,
      deliveryContext: { channel: "telegram", to: "current-recipient" },
      origin: { provider: "telegram", to: "stale-recipient", accountId: "bot" },
      lastChannel: "webchat",
      lastAccountId: "bot",
      lastThreadId: "topic-1",
    });
    insertSessionRow(sourceEnv, "agent:main:canonical", canonicalEntry);
    const canonicalJson = JSON.stringify(canonicalEntry);
    const sourceLegacyJson = readEntryJson(sourceEnv, "agent:main:legacy");
    const sourcePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: sourceEnv });
    closeOpenClawAgentDatabasesForTest();

    const copiedEnv = makeEnv("openclaw-delivery-copy-");
    openOpenClawStateDatabase({ env: copiedEnv });
    const copiedPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: copiedEnv });
    fs.mkdirSync(path.dirname(copiedPath), { recursive: true });
    fs.copyFileSync(sourcePath, copiedPath);

    expectReport(
      repairCanonicalSessionDeliveryStates({ apply: false, cfg: {}, env: copiedEnv }),
      3,
      0,
    );
    expectReport(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env: copiedEnv }), 3);
    closeOpenClawAgentDatabasesForTest();
    expect(listEntries(copiedEnv)).toHaveLength(4);
    expectReport(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env: copiedEnv }), 0);

    const migrated: Record<string, unknown> = readEntry(copiedEnv, "agent:main:legacy");
    expect(migrated.delivery).toEqual({
      kind: "external",
      route: {
        channel: "telegram",
        accountId: "work",
        target: { to: "-1001" },
        thread: { id: "thread-1" },
      },
      context: { channel: "telegram", to: "-1001", accountId: "work", threadId: "thread-1" },
      origin: {
        provider: "telegram",
        to: "-1001",
        chatType: "group",
        accountId: "work",
        threadId: "thread-1",
      },
    });
    for (const key of [
      "route",
      "deliveryContext",
      "origin",
      "channel",
      "lastChannel",
      "lastTo",
      "lastAccountId",
      "lastThreadId",
    ]) {
      expect(migrated).not.toHaveProperty(key);
    }
    expect(readEntry(copiedEnv, "agent:main:internal").delivery).toEqual({ kind: "internal" });
    expect(readEntry(copiedEnv, "agent:main:origin-stale").delivery.context).toMatchObject({
      channel: "telegram",
      to: "current-recipient",
      accountId: "bot",
      threadId: "topic-1",
    });
    expect(readEntryJson(copiedEnv, "agent:main:canonical")).toBe(canonicalJson);
    expect(
      openOpenClawAgentDatabase({ agentId: "main", env: copiedEnv })
        .db.prepare("SELECT channel, account_id FROM session_windows WHERE session_id = ?")
        .get("legacy-session"),
    ).toEqual({ channel: "telegram", account_id: "work" });

    closeOpenClawAgentDatabasesForTest();
    expect(readEntryJson(sourceEnv, "agent:main:legacy")).toBe(sourceLegacyJson);
  });
});

describe("doctor canonical session resolved skills", () => {
  it("refuses prepared repairs on a malformed excluded snapshot and retries in-process", () => {
    const env = makeEnv("openclaw-skills-malformed-snapshot-");
    const sessionKey = "agent:main:a-skills";
    const tombstoneKey = "agent:main:z-tombstone";
    insertSessionRow(env, sessionKey, { sessionId: "skills-session", updatedAt: 42 });
    insertSessionRow(env, tombstoneKey, { sessionId: "tombstone-session", updatedAt: 43 });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db
      .prepare("UPDATE session_nodes SET entry_json = '{}', entry_valid = 0 WHERE session_key = ?")
      .run(tombstoneKey);
    const compactSkills = { prompt: "compact prompt", skills: [{ name: "demo" }], version: 7 };
    const snapshots = {
      skillsSnapshot: {
        ...compactSkills,
        resolvedSkills: [{ name: "demo", description: "runtime" }],
      },
      sessionDiffBaseline: {
        version: 1,
        sessionId: "skills-session",
        root: "/synthetic",
        files: [],
      },
      systemPromptReport: { source: "run", generatedAt: 1, sessionKey },
    };
    for (const [field, value] of Object.entries(snapshots)) {
      database.db
        .prepare(
          "INSERT INTO session_entry_snapshots (session_key, field, value_json) VALUES (?, ?, ?)",
        )
        .run(sessionKey, field, JSON.stringify(value));
    }
    database.db
      .prepare(
        "INSERT INTO session_entry_snapshots (session_key, field, value_json) VALUES (?, 'skillsSnapshot', '{')",
      )
      .run(tombstoneKey);
    const originalEntry = readEntryJson(env, sessionKey);
    const readSnapshots = () =>
      database.db
        .prepare(
          "SELECT session_key, field, value_json FROM session_entry_snapshots ORDER BY session_key, field",
        )
        .all();
    const originalSnapshots = readSnapshots();

    expectReport(repairCanonicalSessionResolvedSkills({ apply: true, cfg: {}, env }), 0);
    expect(readEntryJson(env, sessionKey)).toBe(originalEntry);
    expect(readEntryJson(env, tombstoneKey)).toBe("{}");
    expect(readSnapshots()).toEqual(originalSnapshots);

    database.db
      .prepare("UPDATE session_entry_snapshots SET value_json = '{}' WHERE session_key = ?")
      .run(tombstoneKey);
    expectReport(repairCanonicalSessionResolvedSkills({ apply: true, cfg: {}, env }), 1);
    const repaired = loadExactSessionEntryReadOnly({ agentId: "main", env, sessionKey })?.entry;
    expect(repaired).toMatchObject({
      sessionId: "skills-session",
      updatedAt: 42,
      sessionDiffBaseline: snapshots.sessionDiffBaseline,
      systemPromptReport: snapshots.systemPromptReport,
    });
    expect(repaired?.skillsSnapshot).toEqual(compactSkills);
    expect(readEntryJson(env, tombstoneKey)).toBe("{}");
    expectReport(repairCanonicalSessionResolvedSkills({ apply: true, cfg: {}, env }), 0);
  });

  it("repairs all agents without mutating dry-run rows or losing compact snapshots", () => {
    const env = makeEnv("openclaw-skills-all-agents-");
    const compactSnapshot = {
      prompt: "compact skill prompt",
      skills: [{ name: "demo" }],
      skillFilter: ["demo"],
      version: 7,
    };
    for (const agentId of ["main", "work"]) {
      const sessionKey = `agent:${agentId}:runtime-skills`;
      const skillsSnapshot = {
        ...compactSnapshot,
        resolvedSkills: [{ name: "demo", description: "x".repeat(20_000) }],
      };
      insertSessionRow(
        env,
        sessionKey,
        {
          sessionId: `${agentId}-runtime-skills`,
          updatedAt: 42,
          ...(agentId === "main" ? { skillsSnapshot } : {}),
        },
        agentId,
      );
      if (agentId === "work") {
        openOpenClawAgentDatabase({ agentId, env })
          .db.prepare(
            "INSERT INTO session_entry_snapshots (session_key, field, value_json) VALUES (?, 'skillsSnapshot', ?)",
          )
          .run(sessionKey, JSON.stringify(skillsSnapshot));
      }
      expect(
        listEntries(env, agentId, false)[0]?.entry.skillsSnapshot?.resolvedSkills,
      ).toBeDefined();
      expect(
        rewriteDoctorSessionEntries({
          scope: {
            agentId,
            env,
            storePath: resolveSessionStorePathCore(undefined, { agentId, env }),
          },
          sessionKeys: [sessionKey],
          transform: (entry) => entry,
        }),
      ).toBe(0);
    }

    expectReport(repairCanonicalSessionResolvedSkills({ apply: false, cfg: {}, env }), 2, 0, 2);
    expect(readEntry(env, "agent:main:runtime-skills").skillsSnapshot.resolvedSkills).toBeDefined();

    expectReport(repairCanonicalSessionResolvedSkills({ apply: true, cfg: {}, env }), 2, 2, 2);
    for (const agentId of ["main", "work"]) {
      const sessionKey = `agent:${agentId}:runtime-skills`;
      expect(
        loadExactSessionEntryReadOnly({ agentId, env, sessionKey })?.entry.skillsSnapshot,
      ).toEqual(compactSnapshot);
      expect(JSON.parse(readEntryJson(env, sessionKey, agentId))).not.toHaveProperty(
        "skillsSnapshot",
      );
      expect(listEntries(env, agentId, false)[0]?.entry.skillsSnapshot).toEqual(compactSnapshot);
    }

    closeOpenClawAgentDatabasesForTest();
    for (const agentId of ["main", "work"]) {
      expect(listEntries(env, agentId, false)[0]?.entry.skillsSnapshot).toEqual(compactSnapshot);
    }
    expectReport(repairCanonicalSessionResolvedSkills({ apply: true, cfg: {}, env }), 0, 0, 2);
  });
});
