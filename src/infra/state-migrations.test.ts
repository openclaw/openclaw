import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadSqliteSessionEntries } from "../config/sessions/store-backend.sqlite.js";
import { loadSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import { resolveChannelAllowFromPath } from "../pairing/pairing-store.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { detectLegacyStateMigrations, runLegacyStateMigrations } from "./state-migrations.js";

type DeliveryQueueTestDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;
type KvTestDatabase = Pick<OpenClawStateKyselyDatabase, "kv">;
type PluginStateTestDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_state_entries">;
type MigrationSourceRow = {
  migration_kind: string;
  source_path: string;
  target_table: string;
  status: string;
  source_sha256: string | null;
  removed_source: number;
};

vi.mock("../channels/plugins/bundled.js", () => {
  function fileExists(filePath: string): boolean {
    try {
      return fsSync.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  function resolveChatAppAccountId(cfg: OpenClawConfig): string {
    const channel = (cfg.channels as Record<string, { defaultAccount?: string }> | undefined)
      ?.chatapp;
    return channel?.defaultAccount ?? "default";
  }

  return {
    listBundledChannelLegacySessionSurfaces: vi.fn(() => [
      {
        isLegacyGroupSessionKey: (key: string) => /^group:mobile-/i.test(key.trim()),
        canonicalizeLegacySessionKey: ({ key, agentId }: { key: string; agentId: string }) =>
          /^group:mobile-/i.test(key.trim())
            ? `agent:${agentId}:mobileauth:${key.trim().toLowerCase()}`
            : null,
      },
    ]),
    listBundledChannelLegacyStateMigrationDetectors: vi.fn(() => [
      ({ oauthDir }: { oauthDir: string }) => {
        let entries: fsSync.Dirent[] = [];
        try {
          entries = fsSync.readdirSync(oauthDir, { withFileTypes: true });
        } catch {
          return [];
        }
        return entries.flatMap((entry) => {
          if (!entry.isFile() || !/^(creds|pre-key-1)\.json$/u.test(entry.name)) {
            return [];
          }
          const sourcePath = path.join(oauthDir, entry.name);
          const targetPath = path.join(oauthDir, "mobileauth", "default", entry.name);
          return fileExists(targetPath)
            ? []
            : [
                {
                  kind: "move" as const,
                  label: `MobileAuth auth ${entry.name}`,
                  sourcePath,
                  targetPath,
                },
              ];
        });
      },
      ({ cfg, env }: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv }) => {
        const root = env.OPENCLAW_STATE_DIR;
        if (!root) {
          return [];
        }
        const sourcePath = path.join(root, "credentials", "chatapp-allowFrom.json");
        const targetPath = path.join(
          root,
          "credentials",
          `chatapp-${resolveChatAppAccountId(cfg)}-allowFrom.json`,
        );
        return fileExists(sourcePath) && !fileExists(targetPath)
          ? [{ kind: "copy" as const, label: "ChatApp pairing allowFrom", sourcePath, targetPath }]
          : [];
      },
    ]),
  };
});

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-state-migrations-test-");

function createConfig(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "worker-1", default: true }],
    },
    session: {
      mainKey: "desk",
    },
    channels: {
      chatapp: {
        defaultAccount: "alpha",
        accounts: {
          beta: {},
          alpha: {},
        },
      },
    },
  } as OpenClawConfig;
}

function createEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  };
}

async function createLegacyStateFixture(params?: { includePreKey?: boolean }) {
  const root = await createTempDir();
  const stateDir = path.join(root, ".openclaw");
  const env = createEnv(stateDir);
  const cfg = createConfig();

  await fs.mkdir(path.join(stateDir, "sessions"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "agents", "worker-1", "sessions"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "agent"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true });

  await fs.writeFile(
    path.join(stateDir, "sessions", "sessions.json"),
    `${JSON.stringify({ legacyDirect: { sessionId: "legacy-direct", updatedAt: 10 } }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(stateDir, "sessions", "trace.jsonl"),
    `${JSON.stringify({ type: "session", id: "legacy-trace" })}\n${JSON.stringify({ type: "message", role: "user", text: "hello" })}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json"),
    `${JSON.stringify(
      {
        "group:mobile-room": { sessionId: "group-session", updatedAt: 5 },
        "group:legacy-room": { sessionId: "generic-group-session", updatedAt: 4 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(stateDir, "agent", "settings.json"), '{"ok":true}\n', "utf8");
  await fs.writeFile(path.join(stateDir, "credentials", "creds.json"), '{"auth":true}\n', "utf8");
  if (params?.includePreKey) {
    await fs.writeFile(
      path.join(stateDir, "credentials", "pre-key-1.json"),
      '{"preKey":true}\n',
      "utf8",
    );
  }
  await fs.writeFile(path.join(stateDir, "credentials", "oauth.json"), '{"oauth":true}\n', "utf8");
  await fs.writeFile(resolveChannelAllowFromPath("chatapp", env), '["123","456"]\n', "utf8");

  return {
    root,
    stateDir,
    env,
    cfg,
  };
}

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("state migrations", () => {
  it("detects legacy sessions, agent files, channel auth, and allowFrom copies", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });

    expect(detected.targetAgentId).toBe("worker-1");
    expect(detected.targetMainKey).toBe("desk");
    expect(detected.sessions.hasLegacy).toBe(true);
    expect(detected.sessions.legacyKeys).toEqual(["group:mobile-room", "group:legacy-room"]);
    expect(detected.agentDir.hasLegacy).toBe(true);
    expect(detected.channelPlans.hasLegacy).toBe(true);
    expect(detected.channelPlans.plans.map((plan) => plan.targetPath)).toEqual([
      path.join(stateDir, "credentials", "mobileauth", "default", "creds.json"),
      resolveChannelAllowFromPath("chatapp", env, "alpha"),
    ]);
    expect(detected.preview).toEqual([
      `- Sessions: ${path.join(stateDir, "sessions")} → ${path.join(stateDir, "agents", "worker-1", "sessions")}`,
      `- Sessions: canonicalize legacy keys in ${path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json")}`,
      `- Sessions: import ${path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json")} into SQLite`,
      `- Agent dir: ${path.join(stateDir, "agent")} → ${path.join(stateDir, "agents", "worker-1", "agent")}`,
      `- MobileAuth auth creds.json: ${path.join(stateDir, "credentials", "creds.json")} → ${path.join(stateDir, "credentials", "mobileauth", "default", "creds.json")}`,
      `- ChatApp pairing allowFrom: ${resolveChannelAllowFromPath("chatapp", env)} → ${resolveChannelAllowFromPath("chatapp", env, "alpha")}`,
    ]);
  });

  it("runs legacy state migrations and canonicalizes the merged session store", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture({ includePreKey: true });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toEqual([
      `Migrated latest direct-chat session → agent:worker-1:desk`,
      "Imported 4 session index row(s) into SQLite for agent worker-1",
      "Canonicalized 2 legacy session key(s)",
      "Imported trace.jsonl transcript (2 event(s)) into SQLite for agent worker-1",
      "Moved agent file settings.json → agents/worker-1/agent",
      `Moved MobileAuth auth creds.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "creds.json")}`,
      `Moved MobileAuth auth pre-key-1.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "pre-key-1.json")}`,
      `Copied ChatApp pairing allowFrom → ${resolveChannelAllowFromPath("chatapp", env, "alpha")}`,
    ]);

    await expect(
      fs.stat(path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const mergedStore = loadSqliteSessionEntries({
      agentId: "worker-1",
      env,
    }) as Record<string, { sessionId: string }>;
    expect(mergedStore["agent:worker-1:desk"]?.sessionId).toBe("legacy-direct");
    expect(mergedStore["agent:worker-1:mobileauth:group:mobile-room"]?.sessionId).toBe(
      "group-session",
    );
    expect(mergedStore["agent:worker-1:unknown:group:legacy-room"]?.sessionId).toBe(
      "generic-group-session",
    );

    await expect(
      fs.stat(path.join(stateDir, "agents", "worker-1", "sessions", "trace.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(stateDir, "sessions", "sessions.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(stateDir, "sessions", "trace.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      fs.readFile(path.join(stateDir, "agents", "worker-1", "agent", "settings.json"), "utf8"),
    ).resolves.toContain('"ok":true');
    await expect(
      fs.readFile(
        path.join(stateDir, "credentials", "mobileauth", "default", "creds.json"),
        "utf8",
      ),
    ).resolves.toContain('"auth":true');
    await expect(
      fs.readFile(
        path.join(stateDir, "credentials", "mobileauth", "default", "pre-key-1.json"),
        "utf8",
      ),
    ).resolves.toContain('"preKey":true');
    await expect(
      fs.readFile(path.join(stateDir, "credentials", "oauth.json"), "utf8"),
    ).resolves.toContain('"oauth":true');
    await expect(
      fs.readFile(resolveChannelAllowFromPath("chatapp", env, "alpha"), "utf8"),
    ).resolves.toBe('["123","456"]\n');
    await expect(
      fs.stat(resolveChannelAllowFromPath("chatapp", env, "default")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(resolveChannelAllowFromPath("chatapp", env, "beta")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const database = openOpenClawStateDatabase({ env });
    expect(
      loadSqliteSessionTranscriptEvents({
        agentId: "worker-1",
        sessionId: "legacy-trace",
        env,
      }),
    ).toHaveLength(2);
    const migrationRows = database.db
      .prepare(
        `
          SELECT status, report_json
          FROM migration_runs
          ORDER BY started_at DESC
        `,
      )
      .all() as Array<{ status: string; report_json: string }>;
    expect(migrationRows).toHaveLength(1);
    expect(migrationRows[0]?.status).toBe("completed");
    const report = JSON.parse(migrationRows[0]?.report_json ?? "{}") as {
      sources?: Array<Record<string, unknown>>;
    };
    expect(report).toMatchObject({
      kind: "legacy-state",
      targetAgentId: "worker-1",
      changes: result.changes,
      warnings: [],
    });
    expect(report.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "session-index",
          sourcePath: path.join(stateDir, "sessions", "sessions.json"),
          targetTable: "agent.session_entries",
          recordCount: 1,
          sizeBytes: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        expect.objectContaining({
          kind: "session-index",
          sourcePath: path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json"),
          targetTable: "agent.session_entries",
          recordCount: 2,
          sizeBytes: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        expect.objectContaining({
          kind: "transcript-jsonl",
          sourcePath: path.join(stateDir, "sessions", "trace.jsonl"),
          targetTable: "agent.transcript_events",
          recordCount: 2,
          sizeBytes: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ]),
    );
    const sourceRows = database.db
      .prepare(
        `
          SELECT migration_kind, source_path, target_table, source_sha256, removed_source
          FROM migration_sources
          ORDER BY source_path ASC
        `,
      )
      .all() as MigrationSourceRow[];
    expect(sourceRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          migration_kind: "legacy-state",
          source_path: path.join(stateDir, "sessions", "sessions.json"),
          target_table: "agent.session_entries",
          source_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          removed_source: 1,
        }),
        expect.objectContaining({
          migration_kind: "legacy-state",
          source_path: path.join(stateDir, "sessions", "trace.jsonl"),
          target_table: "agent.transcript_events",
          source_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          removed_source: 1,
        }),
      ]),
    );
  });

  it("imports legacy delivery queue JSON files into SQLite", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();
    const outboundQueueDir = path.join(stateDir, "delivery-queue");
    const outboundFailedDir = path.join(outboundQueueDir, "failed");
    const sessionQueueDir = path.join(stateDir, "session-delivery-queue");
    await fs.mkdir(outboundFailedDir, { recursive: true });
    await fs.mkdir(sessionQueueDir, { recursive: true });
    await fs.writeFile(
      path.join(outboundQueueDir, "out-1.json"),
      JSON.stringify({
        id: "out-1",
        enqueuedAt: 100,
        channel: "directchat",
        to: "+1555",
        payloads: [{ text: "hello" }],
        retryCount: 0,
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(outboundFailedDir, "out-failed.json"),
      JSON.stringify({
        id: "out-failed",
        enqueuedAt: 90,
        channel: "forum",
        to: "room",
        payloads: [{ text: "failed" }],
        retryCount: 5,
      }),
      "utf8",
    );
    await fs.writeFile(path.join(outboundQueueDir, "out-delivered.delivered"), "", "utf8");
    await fs.writeFile(
      path.join(sessionQueueDir, "session-1.json"),
      JSON.stringify({
        id: "session-1",
        enqueuedAt: 80,
        kind: "systemEvent",
        sessionKey: "agent:worker-1:desk",
        text: "done",
        retryCount: 0,
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });

    expect(detected.preview).toEqual(
      expect.arrayContaining([
        `- Outbound delivery queue: ${outboundQueueDir} → SQLite`,
        `- Session delivery queue: ${sessionQueueDir} → SQLite`,
      ]),
    );

    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Imported 2 outbound delivery queue row(s) into SQLite",
        "Removed 1 delivered outbound delivery queue marker(s)",
        "Imported 1 session delivery queue row(s) into SQLite",
      ]),
    );

    const stateDatabase = openOpenClawStateDatabase({ env });
    const db = getNodeSqliteKysely<DeliveryQueueTestDatabase>(stateDatabase.db);
    const rows = executeSqliteQuerySync<{
      queue_name: string;
      id: string;
      status: string;
      entry_json: string;
    }>(
      stateDatabase.db,
      db
        .selectFrom("delivery_queue_entries")
        .select(["queue_name", "id", "status", "entry_json"])
        .orderBy("queue_name", "asc")
        .orderBy("id", "asc"),
    ).rows;

    expect(rows.map((row) => [row.queue_name, row.id, row.status])).toEqual([
      ["outbound-delivery", "out-1", "pending"],
      ["outbound-delivery", "out-failed", "failed"],
      ["session-delivery", "session-1", "pending"],
    ]);
    expect(JSON.parse(rows[0]?.entry_json ?? "{}")).toMatchObject({
      id: "out-1",
      channel: "directchat",
    });
    await expect(fs.stat(path.join(outboundQueueDir, "out-1.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(outboundFailedDir, "out-failed.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.stat(path.join(outboundQueueDir, "out-delivered.delivered")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(sessionQueueDir, "session-1.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps failed legacy transcript imports in place for rerun", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();
    const sourcePath = path.join(stateDir, "sessions", "trace.jsonl");
    await fs.writeFile(sourcePath, '{"type":"message","text":"missing session header"}\n', "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });

    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`Failed importing transcript ${sourcePath}`),
        `Left legacy sessions in place at ${path.join(stateDir, "sessions")}: trace.jsonl`,
      ]),
    );
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toContain("missing session header");
    await expect(fs.stat(path.join(stateDir, "sessions.legacy-1234"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const database = openOpenClawStateDatabase({ env });
    const rows = database.db
      .prepare(
        `
          SELECT source_path, target_table, status, removed_source
          FROM migration_sources
          WHERE source_path = ?
        `,
      )
      .all(sourcePath) as MigrationSourceRow[];

    expect(rows).toEqual([
      expect.objectContaining({
        source_path: sourcePath,
        target_table: "agent.transcript_events",
        status: "warning",
        removed_source: 0,
      }),
    ]);
  });

  it("imports the legacy ACPX gateway instance id into SQLite plugin state", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();
    const sourcePath = path.join(stateDir, "gateway-instance-id");
    await fs.writeFile(sourcePath, "gw-test\n", "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });

    expect(detected.preview).toEqual(
      expect.arrayContaining([`- ACPX gateway instance id: ${sourcePath} → SQLite`]),
    );

    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(
      expect.arrayContaining(["Imported ACPX gateway instance id into SQLite plugin state"]),
    );

    const stateDatabase = openOpenClawStateDatabase({ env });
    const db = getNodeSqliteKysely<PluginStateTestDatabase>(stateDatabase.db);
    const row = executeSqliteQuerySync<{ value_json: string }>(
      stateDatabase.db,
      db
        .selectFrom("plugin_state_entries")
        .select("value_json")
        .where("plugin_id", "=", "acpx")
        .where("namespace", "=", "gateway-instance")
        .where("entry_key", "=", "current"),
    ).rows[0];

    expect(JSON.parse(row?.value_json ?? "{}")).toMatchObject({
      version: 1,
      id: "gw-test",
    });
    await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("imports legacy current conversation bindings into SQLite KV", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();
    const sourcePath = path.join(stateDir, "bindings", "current-conversations.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            bindingId: "generic:forum\u241fdefault\u241f6098642967\u241f6098642967",
            targetSessionKey: " agent:worker-1:acp:forum-dm ",
            targetKind: "session",
            conversation: {
              channel: "forum",
              accountId: "default",
              conversationId: "6098642967",
              parentConversationId: "6098642967",
            },
            status: "active",
            boundAt: 1234,
            metadata: { label: "forum-dm" },
          },
        ],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });

    expect(detected.preview).toEqual(
      expect.arrayContaining([`- Current conversation bindings: ${sourcePath} → SQLite`]),
    );

    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(
      expect.arrayContaining(["Imported 1 current conversation binding(s) into SQLite state"]),
    );

    const stateDatabase = openOpenClawStateDatabase({ env });
    const db = getNodeSqliteKysely<KvTestDatabase>(stateDatabase.db);
    const row = executeSqliteQuerySync<{ key: string; value_json: string }>(
      stateDatabase.db,
      db
        .selectFrom("kv")
        .select(["key", "value_json"])
        .where("scope", "=", "current-conversation-bindings"),
    ).rows[0];

    expect(row?.key).toBe("forum\u241fdefault\u241f\u241f6098642967");
    expect(JSON.parse(row?.value_json ?? "{}")).toMatchObject({
      version: 1,
      binding: {
        bindingId: "generic:forum\u241fdefault\u241f\u241f6098642967",
        targetSessionKey: "agent:worker-1:acp:forum-dm",
        conversation: {
          channel: "forum",
          accountId: "default",
          conversationId: "6098642967",
        },
      },
    });
    await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("moves old global agent-owned SQLite rows into per-agent databases", async () => {
    const { root, env, cfg } = await createLegacyStateFixture();
    const stateDatabase = openOpenClawStateDatabase({ env });
    stateDatabase.db.exec(`
      CREATE TABLE session_entries (
        agent_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, session_key)
      );
      CREATE TABLE transcript_events (
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, session_id, seq)
      );
      CREATE TABLE vfs_entries (
        agent_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        content_blob BLOB,
        metadata_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, namespace, path)
      );
      CREATE TABLE tool_artifacts (
        agent_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        blob BLOB,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, run_id, artifact_id)
      );
    `);
    stateDatabase.db
      .prepare("INSERT INTO session_entries VALUES (?, ?, ?, ?)")
      .run("worker-1", "agent:worker-1:legacy", '{"sessionId":"global-session"}', 10);
    stateDatabase.db
      .prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)")
      .run("worker-1", "global-transcript", 0, '{"type":"session","id":"global-transcript"}', 11);
    stateDatabase.db
      .prepare("INSERT INTO vfs_entries VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("worker-1", "workspace", "/note.txt", "file", Buffer.from("hello"), "{}", 12);
    stateDatabase.db
      .prepare("INSERT INTO tool_artifacts VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("worker-1", "run-1", "artifact-1", "blob", "{}", Buffer.from("artifact"), 13);

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      includeSessions: false,
      includeChannelPlans: false,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Migrated 1 global session row(s) into per-agent SQLite databases.",
        "Migrated 1 global transcript event row(s) into per-agent SQLite databases.",
        "Migrated 1 global VFS row(s) into per-agent SQLite databases.",
        "Migrated 1 global tool artifact row(s) into per-agent SQLite databases.",
      ]),
    );
    const agentDatabase = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(
      agentDatabase.db
        .prepare("SELECT entry_json FROM session_entries WHERE session_key = ?")
        .get("agent:worker-1:legacy"),
    ).toMatchObject({ entry_json: '{"sessionId":"global-session"}' });
    expect(
      agentDatabase.db
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ?")
        .get("global-transcript"),
    ).toMatchObject({ event_json: '{"type":"session","id":"global-transcript"}' });
    expect(
      agentDatabase.db
        .prepare("SELECT kind FROM vfs_entries WHERE namespace = ? AND path = ?")
        .get("workspace", "/note.txt"),
    ).toMatchObject({ kind: "file" });
    expect(
      agentDatabase.db
        .prepare("SELECT kind FROM tool_artifacts WHERE run_id = ? AND artifact_id = ?")
        .get("run-1", "artifact-1"),
    ).toMatchObject({ kind: "blob" });
    for (const table of ["session_entries", "transcript_events", "vfs_entries", "tool_artifacts"]) {
      expect(
        stateDatabase.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table),
      ).toBeUndefined();
    }
  });
});
