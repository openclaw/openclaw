import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listSessionEntriesCore as listEntries } from "../config/sessions/session-accessor.js";
import { loadExactSessionEntryReadOnly as loadEntry } from "../config/sessions/session-accessor.sqlite-exact-read.js";
import { deriveSessionPredicateColumns } from "../config/sessions/session-predicate-columns.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawAgentDatabasesAsync as closeAgentDatabases,
  closeOpenClawAgentDatabasesForTest as closeAgentHandles,
  openOpenClawAgentDatabase as openAgentDatabase,
  resolveOpenClawAgentSqlitePath as resolveAgentPath,
} from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase as openStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { repairReservedIncognitoSessionKeys as repairKeys } from "./doctor-session-incognito-key-repair.js";
import { sessionSqlFixture } from "./doctor-session-sqlite.sql.test-support.js";

const tempDirs = createTempDirTracker();
function createState(label: string) {
  const stateDir = fs.realpathSync(tempDirs.make(label));
  return { stateDir, env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}
afterEach(async () => {
  await closeAgentDatabases();
  closeAgentHandles();
  await closeStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("doctor reserved incognito session key repair", () => {
  it("renames durable collisions and every key-bearing linkage idempotently", async () => {
    const { stateDir, env } = createState("openclaw-doctor-incognito-key-");
    const database = openAgentDatabase({ agentId: "main", env });
    const sql = sessionSqlFixture(database.db);
    const secondaryDatabase = openAgentDatabase({ agentId: "work", env });
    const secondarySql = sessionSqlFixture(secondaryDatabase.db);
    const workKey = "agent:work:dashboard:regular";
    const stateDatabase = openStateDatabase({ env });
    const stateSql = sessionSqlFixture(stateDatabase.db);
    const oldKey = "agent:main:dashboard:incognito-collision";
    const baseLegacyKey = "agent:main:dashboard:legacy-incognito-collision";
    const coldOccupiedKey = `${baseLegacyKey}-1`;
    const newKey = `${baseLegacyKey}-2`;
    const skillsSnapshot = { prompt: "Retained skill prompt", skills: [{ name: "demo" }] };
    const entryJson = JSON.stringify({
      sessionId: "session-old",
      updatedAt: 1,
      parentSessionKey: oldKey,
      spawnedBy: oldKey,
      completionOwnerSessionKey: oldKey,
      forkSource: { sessionKey: oldKey, sessionId: "source" },
      compactionCheckpoints: [{ checkpointId: "checkpoint", sessionKey: oldKey }],
      systemPromptReport: { source: "run", generatedAt: 1, sessionKey: oldKey },
      pluginExtensions: { test: { label: oldKey } },
    });
    const predicates = deriveSessionPredicateColumns(entryJson);
    sql`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, parent_session_key, spawned_by, fork_source_session_key, session_started_at, has_optional_references) VALUES (${oldKey}, ${"session-old"}, ${entryJson}, 1, ${oldKey}, ${oldKey}, ${oldKey}, ${predicates.session_started_at}, ${predicates.has_optional_references})`.run();
    sql`INSERT INTO session_entry_snapshots (session_key, field, value_json) VALUES (${oldKey}, 'skillsSnapshot', ${JSON.stringify(skillsSnapshot)})`.run();
    sql`INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at, parent_session_key, spawned_by) VALUES (${"session-old"}, ${oldKey}, 'conversation', 1, 1, ${oldKey}, ${oldKey})`.run();
    sql`INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, metadata_json, created_at, updated_at) VALUES ('conversation-1', 'webchat', 'default', 'direct', 'peer', 'peer', '{}', 1, 1)`.run();
    sql`INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at) VALUES ('operation-1', 'turn', 'conversation-1', ${oldKey}, 'hash', 'sent', 1, 1)`.run();
    stateSql`INSERT INTO session_state_heads (session_key, agent_id, last_sequence, updated_at) VALUES (${oldKey}, 'main', 1, 1)`.run();
    stateSql`INSERT INTO operator_approvals (cursor_id, approval_id, resolution_ref, kind, status, presentation_json, reviewer_device_ids_json, source_session_key, audience_session_keys_json, runtime_epoch, created_at_ms, expires_at_ms, updated_at_ms) VALUES (1, 'approval-1', ${"a".repeat(43)}, 'exec', 'pending', '{}', '[]', ${oldKey}, ${JSON.stringify([baseLegacyKey])}, 'epoch', 1, 2, 1)`.run();
    secondarySql`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, parent_session_key, spawned_by) VALUES (${workKey}, 'session-work', ${JSON.stringify(
      {
        sessionId: "session-work",
        updatedAt: 1,
        parentSessionKey: oldKey,
        spawnedBy: oldKey,
        completionOwnerSessionKey: oldKey,
      },
    )}, 1, ${oldKey}, ${oldKey})`.run();
    sql`UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ${oldKey}`.run();
    secondarySql`INSERT INTO session_entry_snapshots (session_key, field, value_json) VALUES (${workKey}, 'systemPromptReport', ${JSON.stringify({ source: "run", generatedAt: 1, sessionKey: coldOccupiedKey })})`.run();
    secondarySql`UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ${workKey}`.run();
    secondarySql`INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at, parent_session_key, spawned_by) VALUES ('session-work', ${workKey}, 'conversation', 1, 1, ${oldKey}, ${oldKey})`.run();
    stateSql`INSERT INTO session_watch_cursors (watcher_session_key, target_session_key, updated_at) VALUES (${oldKey}, ${oldKey}, 1)`.run();
    writeConfigMachineState("tui.lastSession.main", oldKey, { env });
    writeConfigMachineState("unrelated.sessionReference", oldKey, { env });
    sql`INSERT INTO heartbeat_outcomes (session_key, run_session_key, outcome, summary, occurred_at, updated_at) VALUES (${oldKey}, ${oldKey}, 'done', 'done', 1, 1)`.run();
    sql`INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (${oldKey}, 'tab-1', 'Tab', 0, 'user', 0)`.run();
    sql`INSERT INTO board_widgets (session_key, name, tab_id, content_kind, html, sha256, view_generation, revision, size_w, size_h, position, created_by, created_at, updated_at) VALUES (${oldKey}, 'widget-1', 'tab-1', 'html', X'00', 'sha', 'view-1', 1, 1, 1, 0, 'user', 1, 1)`.run();
    sql`INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (${oldKey}, 'member-1', 'owner-1', 1)`.run();
    expect(listEntries({ agentId: "main", clone: false, env })[0]?.sessionKey).toBe(oldKey);

    expect(await repairKeys({ apply: false, cfg: {}, env })).toEqual({ found: 1, repaired: 0 });
    expect(await repairKeys({ apply: true, cfg: {}, env })).toEqual({ found: 1, repaired: 1 });
    expect(listEntries({ agentId: "main", clone: false, env })[0]?.sessionKey).toBe(newKey);

    for (const [owner, table, columns] of [
      [
        database,
        "session_nodes",
        "session_key, parent_session_key, spawned_by, fork_source_session_key",
      ],
      [database, "session_windows", "session_key, parent_session_key, spawned_by"],
      [database, "conversation_deliveries", "source_session_key"],
      [database, "heartbeat_outcomes", "session_key, run_session_key"],
      [database, "board_tabs", "session_key"],
      [database, "board_widgets", "session_key"],
      [database, "session_members", "session_key"],
      [stateDatabase, "session_state_heads", "session_key"],
      [stateDatabase, "session_watch_cursors", "watcher_session_key, target_session_key"],
      [secondaryDatabase, "session_windows", "parent_session_key, spawned_by"],
    ] as const) {
      expect(owner.db.prepare(`SELECT ${columns} FROM ${table}`).get()).toEqual(
        Object.fromEntries(columns.split(", ").map((column) => [column, newKey])),
      );
    }
    expect(readConfigMachineState<string>("tui.lastSession.main", { env })).toBe(newKey);
    expect(readConfigMachineState<string>("unrelated.sessionReference", { env })).toBe(oldKey);
    expect(
      stateSql`SELECT source_session_key, audience_session_keys_json FROM operator_approvals`.get(),
    ).toEqual({
      source_session_key: newKey,
      audience_session_keys_json: JSON.stringify([baseLegacyKey]),
    });

    const secondaryEntry = secondarySql`SELECT entry_json FROM session_nodes`.get() as {
      entry_json: string;
    };
    expect(JSON.parse(secondaryEntry.entry_json)).toMatchObject({
      completionOwnerSessionKey: newKey,
    });
    const entry = sql`SELECT session_key, entry_json FROM session_nodes`.get() as {
      session_key: string;
      entry_json: string;
    };
    expect(entry.session_key).toBe(newKey);
    expect(loadEntry({ agentId: "main", env, sessionKey: newKey })?.entry).toMatchObject({
      parentSessionKey: newKey,
      completionOwnerSessionKey: newKey,
      forkSource: { sessionKey: newKey },
      compactionCheckpoints: [{ sessionKey: newKey }],
      systemPromptReport: { sessionKey: newKey },
      skillsSnapshot,
      pluginExtensions: { test: { label: oldKey } },
    });
    expect(JSON.parse(entry.entry_json)).not.toHaveProperty("systemPromptReport");
    expect(JSON.parse(entry.entry_json)).not.toHaveProperty("skillsSnapshot");
    expect(loadEntry({ agentId: "work", env, sessionKey: workKey })?.entry).toMatchObject({
      systemPromptReport: { sessionKey: coldOccupiedKey },
    });
    expect(sql`SELECT entry_valid FROM session_nodes WHERE session_key = ${newKey}`.get()).toEqual({
      entry_valid: 1,
    });
    expect(
      secondarySql`SELECT entry_valid FROM session_nodes WHERE session_key = ${workKey}`.get(),
    ).toEqual({ entry_valid: 1 });
    await closeAgentDatabases(stateDir);
    closeAgentHandles(stateDir);
    expect(listEntries({ agentId: "main", env })).toMatchObject([
      { sessionKey: newKey, entry: { sessionId: "session-old", updatedAt: 1 } },
    ]);
    expect(listEntries({ agentId: "work", env })).toMatchObject([
      {
        sessionKey: workKey,
        entry: { sessionId: "session-work", updatedAt: 1 },
      },
    ]);
    expect(await repairKeys({ apply: true, cfg: {}, env })).toEqual({ found: 0, repaired: 0 });
    expect(
      stateSql`SELECT scope FROM state_leases WHERE owner = 'openclaw-doctor'`.get(),
    ).toBeUndefined();
  });

  it("settles readers before returning a repair of a previously closed database", async () => {
    const { stateDir, env } = createState("openclaw-doctor-incognito-closed-");
    const database = openAgentDatabase({ agentId: "main", env });
    const sql = sessionSqlFixture(database.db);
    const oldKey = "agent:main:dashboard:incognito-closed";
    const newKey = "agent:main:dashboard:legacy-incognito-closed";
    sql`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (${oldKey}, 'closed-session', ${JSON.stringify({ sessionId: "closed-session", updatedAt: 1 })}, 1)`.run();
    sql`UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ${oldKey}`.run();
    sql`INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at) VALUES ('closed-session', ${oldKey}, 'conversation', 1, 1)`.run();
    await closeAgentDatabases(stateDir);
    closeAgentHandles(stateDir);

    expect(await repairKeys({ apply: true, cfg: {}, env })).toEqual({ found: 1, repaired: 1 });
    expect(listEntries({ agentId: "main", env })).toMatchObject([
      { sessionKey: newKey, entry: { sessionId: "closed-session", updatedAt: 1 } },
    ]);
  });

  it.each([false, true])(
    "resumes an interrupted repair from its journal (shared owner: %s)",
    async (shared) => {
      const { stateDir, env } = createState("openclaw-doctor-incognito-resume-");
      const sqlitePath = shared
        ? path.join(stateDir, "shared.sqlite")
        : resolveAgentPath({ agentId: "main", env });
      const cfg: OpenClawConfig = shared
        ? { agents: { entries: { beta: {} } }, session: { store: sqlitePath } }
        : {};
      const database = openAgentDatabase({
        agentId: shared ? "alpha" : "main",
        env,
        path: sqlitePath,
      });
      const sql = sessionSqlFixture(database.db);
      const stateDatabase = openStateDatabase({ env });
      const stateSql = sessionSqlFixture(stateDatabase.db);
      const oldKey = "agent:main:dashboard:incognito-interrupted";
      const newCollisionKey = "agent:main:dashboard:incognito-new";
      const resumedKey = "agent:main:dashboard:legacy-incognito-interrupted-resumed";
      sql`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (${oldKey}, 'session-old', ${JSON.stringify({ sessionId: "session-old" })}, 1)`.run();
      sql`INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at) VALUES ('session-old', ${oldKey}, 'conversation', 1, 1)`.run();
      sql`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (${newCollisionKey}, 'session-new', ${JSON.stringify({ sessionId: "session-new" })}, 1)`.run();
      sql`INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at) VALUES ('session-new', ${newCollisionKey}, 'conversation', 1, 1)`.run();
      stateSql`INSERT INTO state_leases (scope, lease_key, owner, payload_json, created_at, updated_at) VALUES ('doctor-session-key-migration', 'reserved-incognito-v1', 'openclaw-doctor', ${JSON.stringify(
        {
          version: 1,
          renames: [{ from: oldKey, to: resumedKey }],
        },
      )}, 1, 1)`.run();
      stateSql`INSERT INTO session_state_heads (session_key, agent_id, last_sequence, updated_at) VALUES (${resumedKey}, 'main', 1, 1)`.run();

      expect(await repairKeys({ apply: false, cfg, env })).toEqual({ found: 2, repaired: 0 });
      expect(await repairKeys({ apply: true, cfg, env })).toEqual({ found: 2, repaired: 2 });
      expect(
        sql`SELECT session_key FROM session_nodes ORDER BY session_key`
          .all()
          .map((row) => (row as { session_key: string }).session_key),
      ).toEqual([resumedKey, "agent:main:dashboard:legacy-incognito-new"].toSorted());
      expect(
        stateSql`SELECT scope FROM state_leases WHERE owner = 'openclaw-doctor'`.get(),
      ).toBeUndefined();
    },
  );

  it("rewrites dense incognito references in bounded batches without changing payloads", async () => {
    const { env } = createState("openclaw-doctor-incognito-density-");
    const database = openAgentDatabase({ agentId: "main", env });
    const sql = sessionSqlFixture(database.db);
    const oldKey = "agent:main:dashboard:incognito-density";
    const newKey = "agent:main:dashboard:legacy-incognito-density";
    const payload = "incognito-payload-".repeat(128);
    sql`INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at) VALUES (${oldKey}, 'incognito-density-owner', ${JSON.stringify({ sessionId: "incognito-density-owner", updatedAt: 1 })}, 1, 1)`.run();
    sql`UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ${oldKey}`.run();
    sql`INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at) VALUES ('incognito-density-owner', ${oldKey}, 'conversation', 1, 1)`.run();
    const insertNode = sql`INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at, parent_session_key) VALUES (?, ?, ?, 1, ?, ?)`;
    const insertWindow = sql`INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at, parent_session_key) VALUES (?, ?, 'conversation', ?, ?, ?)`;
    for (let index = 0; index < 130; index += 1) {
      const sessionKey = `agent:main:incognito-density-${String(index).padStart(3, "0")}`;
      const sessionId = `incognito-density-session-${index}`;
      insertNode.run(
        sessionKey,
        sessionId,
        JSON.stringify({
          parentSessionKey: oldKey,
          payload,
          sessionId,
          updatedAt: index + 2,
        }),
        index + 2,
        oldKey,
      );
      insertWindow.run(sessionId, sessionKey, index + 2, index + 2, oldKey);
    }
    const originalExec = database.db.exec.bind(database.db);
    let writeTransactions = 0;
    vi.spyOn(database.db, "exec").mockImplementation((query) => {
      if (query === "BEGIN IMMEDIATE") {
        writeTransactions += 1;
      }
      return originalExec(query);
    });

    expect(await repairKeys({ apply: true, cfg: {}, env })).toEqual({ found: 1, repaired: 1 });
    expect(writeTransactions).toBeGreaterThanOrEqual(4);
    expect(sql`SELECT count(*) AS count FROM session_nodes WHERE entry_valid <> 1`.get()).toEqual({
      count: 0,
    });
    expect(sql`SELECT session_key FROM session_nodes WHERE session_key = ${newKey}`.get()).toEqual({
      session_key: newKey,
    });
    for (const index of [0, 65, 129]) {
      const sessionKey = `agent:main:incognito-density-${String(index).padStart(3, "0")}`;
      const row =
        sql`SELECT entry_json FROM session_nodes WHERE session_key = ${sessionKey}`.get() as {
          entry_json: string;
        };
      expect(JSON.parse(row.entry_json)).toMatchObject({ parentSessionKey: newKey, payload });
    }
  });
});
