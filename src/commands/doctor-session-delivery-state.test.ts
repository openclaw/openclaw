import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.sqlite-exact-read.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
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

describe("doctor canonical session delivery state", () => {
  it("warns and skips an unmigrated agent database", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-delivery-legacy-schema-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db.exec("PRAGMA user_version = 8;");
    closeOpenClawAgentDatabasesForTest();

    expect(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env })).toEqual({
      found: 0,
      repaired: 0,
      scannedStores: 1,
    });
  });

  it("publishes repaired delivery accounts to the existing SQLite connection without aging sessions", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-delivery-warm-cache-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:delivery-warm-cache";
    insertSessionRow(env, sessionKey, {
      sessionId: "delivery-warm-cache-session",
      updatedAt: 10,
      channel: "slack",
      deliveryContext: { channel: "telegram", to: "recipient", accountId: "current-bot" },
      lastAccountId: "stale-slack-bot",
    });

    expect(listSessionEntriesCore({ agentId: "main", env })[0]?.entry).toMatchObject({
      updatedAt: 10,
      lastAccountId: "stale-slack-bot",
    });
    expect(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env })).toEqual({
      found: 1,
      repaired: 1,
      scannedStores: 1,
    });
    expect(JSON.parse(readEntryJson(env, sessionKey))).toMatchObject({
      updatedAt: 10,
      delivery: { context: { accountId: "current-bot" } },
    });

    const repaired = listSessionEntriesCore({ agentId: "main", env })[0]?.entry;
    expect(repaired).toMatchObject({
      updatedAt: 10,
      delivery: { context: { accountId: "current-bot" } },
    });
    expect(repaired).not.toHaveProperty("lastAccountId");
  });

  it("publishes cross-agent incognito parent rewrites to each existing SQLite connection", async () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-incognito-warm-cache-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
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

    expect(listSessionEntriesCore({ agentId: "work", env })[0]?.entry).toMatchObject({
      updatedAt: 20,
      parentSessionKey: oldParentKey,
    });
    expect(await repairReservedIncognitoSessionKeys({ apply: true, cfg: {}, env })).toEqual({
      found: 1,
      repaired: 1,
    });

    expect(listSessionEntriesCore({ agentId: "work", env })[0]?.entry).toMatchObject({
      updatedAt: 20,
      parentSessionKey: newParentKey,
      spawnedBy: newParentKey,
    });
  });

  it("migrates a copied realistic store without touching the source or canonical row bytes", () => {
    const sourceStateDir = fs.realpathSync(tempDirs.make("openclaw-delivery-source-"));
    const sourceEnv = { ...process.env, OPENCLAW_STATE_DIR: sourceStateDir };
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

    const copiedStateDir = fs.realpathSync(tempDirs.make("openclaw-delivery-copy-"));
    const copiedEnv = { ...process.env, OPENCLAW_STATE_DIR: copiedStateDir };
    openOpenClawStateDatabase({ env: copiedEnv });
    const copiedPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: copiedEnv });
    fs.mkdirSync(path.dirname(copiedPath), { recursive: true });
    fs.copyFileSync(sourcePath, copiedPath);

    expect(repairCanonicalSessionDeliveryStates({ apply: false, cfg: {}, env: copiedEnv })).toEqual(
      {
        found: 3,
        repaired: 0,
        scannedStores: 1,
      },
    );
    expect(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env: copiedEnv })).toEqual({
      found: 3,
      repaired: 3,
      scannedStores: 1,
    });
    closeOpenClawAgentDatabasesForTest();
    expect(listSessionEntriesCore({ agentId: "main", env: copiedEnv })).toHaveLength(4);
    expect(repairCanonicalSessionDeliveryStates({ apply: true, cfg: {}, env: copiedEnv })).toEqual({
      found: 0,
      repaired: 0,
      scannedStores: 1,
    });

    const migrated = JSON.parse(readEntryJson(copiedEnv, "agent:main:legacy")) as Record<
      string,
      unknown
    >;
    expect(migrated.delivery).toEqual({
      kind: "external",
      route: {
        channel: "telegram",
        accountId: "work",
        target: { to: "-1001" },
        thread: { id: "thread-1" },
      },
      context: {
        channel: "telegram",
        to: "-1001",
        accountId: "work",
        threadId: "thread-1",
      },
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
    expect(JSON.parse(readEntryJson(copiedEnv, "agent:main:internal")).delivery).toEqual({
      kind: "internal",
    });
    expect(
      JSON.parse(readEntryJson(copiedEnv, "agent:main:origin-stale")).delivery.context,
    ).toMatchObject({
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
  it("repairs all agents without mutating dry-run rows or losing compact snapshots", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-skills-all-agents-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
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
        listSessionEntriesCore({ agentId, clone: false, env })[0]?.entry.skillsSnapshot
          ?.resolvedSkills,
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

    expect(repairCanonicalSessionResolvedSkills({ apply: false, cfg: {}, env })).toEqual({
      found: 2,
      repaired: 0,
      scannedStores: 2,
    });
    expect(
      JSON.parse(readEntryJson(env, "agent:main:runtime-skills")).skillsSnapshot.resolvedSkills,
    ).toBeDefined();

    expect(repairCanonicalSessionResolvedSkills({ apply: true, cfg: {}, env })).toEqual({
      found: 2,
      repaired: 2,
      scannedStores: 2,
    });
    for (const agentId of ["main", "work"]) {
      const sessionKey = `agent:${agentId}:runtime-skills`;
      expect(
        loadExactSessionEntryReadOnly({ agentId, env, sessionKey })?.entry.skillsSnapshot,
      ).toEqual(compactSnapshot);
      expect(JSON.parse(readEntryJson(env, sessionKey, agentId))).not.toHaveProperty(
        "skillsSnapshot",
      );
      expect(
        listSessionEntriesCore({ agentId, clone: false, env })[0]?.entry.skillsSnapshot,
      ).toEqual(compactSnapshot);
    }

    closeOpenClawAgentDatabasesForTest();
    for (const agentId of ["main", "work"]) {
      expect(
        listSessionEntriesCore({ agentId, clone: false, env })[0]?.entry.skillsSnapshot,
      ).toEqual(compactSnapshot);
    }
    expect(repairCanonicalSessionResolvedSkills({ apply: true, cfg: {}, env })).toEqual({
      found: 0,
      repaired: 0,
      scannedStores: 2,
    });
  });
});
