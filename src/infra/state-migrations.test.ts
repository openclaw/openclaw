// Covers legacy state migration detection and repair behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveChannelAllowFromPath } from "../pairing/pairing-store.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  autoMigrateLegacyState,
  autoMigrateLegacyPluginDoctorState,
  detectLegacyStateMigrations,
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyStateForTest,
  runLegacyStateMigrations,
} from "./state-migrations.js";
import { loadVoiceWakeRoutingConfig, setVoiceWakeRoutingConfig } from "./voicewake-routing.js";
import { loadVoiceWakeConfig, setVoiceWakeTriggers } from "./voicewake.js";

const pluginDoctorStateMigrationEntries = vi.hoisted(
  () =>
    ({
      entries: [] as Array<{
        pluginId: string;
        migration: {
          id: string;
          label: string;
          detectLegacyState: (params: {
            config: OpenClawConfig;
            env: NodeJS.ProcessEnv;
            stateDir: string;
            oauthDir: string;
            context: unknown;
          }) => Promise<{ preview: string[] } | null> | { preview: string[] } | null;
          migrateLegacyState: (params: {
            config: OpenClawConfig;
            env: NodeJS.ProcessEnv;
            stateDir: string;
            oauthDir: string;
            context: unknown;
          }) =>
            | Promise<{ changes: string[]; warnings: string[] }>
            | {
                changes: string[];
                warnings: string[];
              };
        };
      }>,
    }) satisfies {
      entries: Array<{
        pluginId: string;
        migration: {
          id: string;
          label: string;
          detectLegacyState: (params: {
            config: OpenClawConfig;
            env: NodeJS.ProcessEnv;
            stateDir: string;
            oauthDir: string;
            context: unknown;
          }) => Promise<{ preview: string[] } | null> | { preview: string[] } | null;
          migrateLegacyState: (params: {
            config: OpenClawConfig;
            env: NodeJS.ProcessEnv;
            stateDir: string;
            oauthDir: string;
            context: unknown;
          }) =>
            | Promise<{ changes: string[]; warnings: string[] }>
            | {
                changes: string[];
                warnings: string[];
              };
        };
      }>;
    },
);

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
        let entries: fsSync.Dirent[];
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

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    listPluginDoctorStateMigrationEntries: vi.fn(() => pluginDoctorStateMigrationEntries.entries),
  };
});

const tempDirs = createTrackedTempDirs();

type UpdateCheckStateDatabase = Pick<OpenClawStateKyselyDatabase, "update_check_state">;
type ConfigHealthDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;
type PluginBindingApprovalsDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_binding_approvals">;
type CurrentConversationBindingsDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;

async function expectMissingPath(targetPath: string): Promise<void> {
  let statError: NodeJS.ErrnoException | undefined;
  try {
    await fs.stat(targetPath);
  } catch (error) {
    statError = error as NodeJS.ErrnoException;
  }
  expect(statError).toBeInstanceOf(Error);
  expect(statError?.code).toBe("ENOENT");
  expect(statError?.path).toBe(targetPath);
  expect(statError?.syscall).toBe("stat");
}
const createTempDir = () => tempDirs.make("openclaw-state-migrations-test-");

function readUpdateCheckState(env: NodeJS.ProcessEnv):
  | {
      last_checked_at: string | null;
      last_available_version: string | null;
      last_available_tag: string | null;
      auto_install_id: string | null;
    }
  | undefined {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<UpdateCheckStateDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("update_check_state")
      .select([
        "last_checked_at",
        "last_available_version",
        "last_available_tag",
        "auto_install_id",
      ])
      .where("state_key", "=", "default"),
  );
}

function readConfigHealthRows(env: NodeJS.ProcessEnv): Array<{
  config_path: string;
  last_known_good_json: string | null;
  last_promoted_good_json: string | null;
  last_observed_suspicious_signature: string | null;
}> {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<ConfigHealthDatabase>(db);
  return executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("config_health_entries")
      .select([
        "config_path",
        "last_known_good_json",
        "last_promoted_good_json",
        "last_observed_suspicious_signature",
      ])
      .orderBy("config_path", "asc"),
  ).rows;
}

function readCurrentConversationBindingRows(env: NodeJS.ProcessEnv): Array<{
  binding_key: string;
  binding_id: string;
  target_session_key: string;
  channel: string;
  account_id: string;
  conversation_id: string;
  record_json: string;
}> {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<CurrentConversationBindingsDatabase>(db);
  return executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("current_conversation_bindings")
      .select([
        "binding_key",
        "binding_id",
        "target_session_key",
        "channel",
        "account_id",
        "conversation_id",
        "record_json",
      ])
      .orderBy("binding_id", "asc"),
  ).rows;
}

function readPluginBindingApprovalRows(env: NodeJS.ProcessEnv): Array<{
  plugin_root: string;
  channel: string;
  account_id: string;
  plugin_id: string;
  plugin_name: string | null;
  approved_at: number;
}> {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<PluginBindingApprovalsDatabase>(db);
  return executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("plugin_binding_approvals")
      .select(["plugin_root", "channel", "account_id", "plugin_id", "plugin_name", "approved_at"])
      .orderBy("plugin_root", "asc"),
  ).rows;
}

function insertCurrentConversationBindingRow(
  env: NodeJS.ProcessEnv,
  params: {
    bindingKey: string;
    bindingId: string;
    targetSessionKey: string;
    channel: string;
    accountId: string;
    conversationId: string;
    recordJson: string;
  },
): void {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<CurrentConversationBindingsDatabase>(db);
  executeSqliteQuerySync(
    db,
    stateDb.insertInto("current_conversation_bindings").values({
      binding_key: params.bindingKey,
      binding_id: params.bindingId,
      target_agent_id: "codex",
      target_session_id: null,
      target_session_key: params.targetSessionKey,
      channel: params.channel,
      account_id: params.accountId,
      conversation_kind: "current",
      parent_conversation_id: null,
      conversation_id: params.conversationId,
      target_kind: "session",
      status: "active",
      bound_at: 1,
      expires_at: null,
      metadata_json: null,
      record_json: params.recordJson,
      updated_at: 1,
    }),
  );
}

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
    HOME: path.dirname(stateDir),
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
  await fs.writeFile(path.join(stateDir, "sessions", "trace.jsonl"), "{}\n", "utf8");
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
  vi.useRealTimers();
  pluginDoctorStateMigrationEntries.entries = [];
  resetAutoMigrateLegacyStateForTest();
  resetAutoMigrateLegacyStateDirForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("state migrations", () => {
  let detectionCase: Awaited<ReturnType<typeof detectLegacyStateMigrations>> & {
    stateDir: string;
    env: NodeJS.ProcessEnv;
  };

  beforeAll(async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    detectionCase = { ...detected, stateDir, env };
  });

  it("detects legacy sessions, agent files, channel auth, and allowFrom copies", () => {
    expect(detectionCase.targetAgentId).toBe("worker-1");
    expect(detectionCase.targetMainKey).toBe("desk");
    expect(detectionCase.sessions.hasLegacy).toBe(true);
    expect(detectionCase.sessions.legacyKeys).toEqual(["group:mobile-room", "group:legacy-room"]);
    expect(detectionCase.agentDir.hasLegacy).toBe(true);
    expect(detectionCase.channelPlans.hasLegacy).toBe(true);
    expect(detectionCase.channelPlans.plans.map((plan) => plan.targetPath)).toEqual([
      path.join(detectionCase.stateDir, "credentials", "mobileauth", "default", "creds.json"),
      resolveChannelAllowFromPath("chatapp", detectionCase.env, "alpha"),
    ]);
    expect(detectionCase.preview).toEqual([
      `- Sessions: ${path.join(detectionCase.stateDir, "sessions")} → ${path.join(detectionCase.stateDir, "agents", "worker-1", "sessions")}`,
      `- Sessions: canonicalize legacy keys in ${path.join(detectionCase.stateDir, "agents", "worker-1", "sessions", "sessions.json")}`,
      `- Agent dir: ${path.join(detectionCase.stateDir, "agent")} → ${path.join(detectionCase.stateDir, "agents", "worker-1", "agent")}`,
      `- MobileAuth auth creds.json: ${path.join(detectionCase.stateDir, "credentials", "creds.json")} → ${path.join(detectionCase.stateDir, "credentials", "mobileauth", "default", "creds.json")}`,
      `- ChatApp pairing allowFrom: ${resolveChannelAllowFromPath("chatapp", detectionCase.env)} → ${resolveChannelAllowFromPath("chatapp", detectionCase.env, "alpha")}`,
    ]);
  });

  it("runs legacy state migrations and canonicalizes the merged session store", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture({ includePreKey: true });
    cfg.session = { ...cfg.session, mainKey: "Desk" };
    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    const targetStore = JSON.parse(await fs.readFile(targetStorePath, "utf8")) as Record<
      string,
      unknown
    >;
    targetStore["agent:main:desk"] = { sessionId: "explicit-foreign", updatedAt: 30 };
    await fs.writeFile(targetStorePath, `${JSON.stringify(targetStore, null, 2)}\n`, "utf8");
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    const legacyStore = JSON.parse(await fs.readFile(legacyStorePath, "utf8")) as Record<
      string,
      unknown
    >;
    legacyStore["Agent:main:desk"] = { sessionId: "mixed-case-foreign", updatedAt: 40 };
    await fs.writeFile(legacyStorePath, `${JSON.stringify(legacyStore, null, 2)}\n`, "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      pluginSessionStoreAgentIds: ["worker-1"],
    });
    expect(detected.sessions.preserveForeignMainAliases).toBe(true);
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toEqual([
      `Migrated latest direct-chat session → agent:worker-1:desk`,
      `Merged sessions store → ${path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json")}`,
      "Canonicalized 2 legacy session key(s)",
      "Moved trace.jsonl → agents/worker-1/sessions",
      "Moved agent file settings.json → agents/worker-1/agent",
      `Moved MobileAuth auth creds.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "creds.json")}`,
      `Moved MobileAuth auth pre-key-1.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "pre-key-1.json")}`,
      `Copied ChatApp pairing allowFrom → ${resolveChannelAllowFromPath("chatapp", env, "alpha")}`,
    ]);

    const mergedStore = JSON.parse(
      await fs.readFile(
        path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json"),
        "utf8",
      ),
    ) as Record<string, { sessionId: string }>;
    expect(mergedStore["agent:worker-1:desk"]?.sessionId).toBe("legacy-direct");
    expect(mergedStore["agent:worker-1:mobileauth:group:mobile-room"]?.sessionId).toBe(
      "group-session",
    );
    expect(mergedStore["agent:worker-1:unknown:group:legacy-room"]?.sessionId).toBe(
      "generic-group-session",
    );
    expect(mergedStore["agent:main:desk"]?.sessionId).toBe("explicit-foreign");
    expect(mergedStore["Agent:main:desk"]?.sessionId).toBe("mixed-case-foreign");

    await expect(
      fs.readFile(path.join(stateDir, "agents", "worker-1", "sessions", "trace.jsonl"), "utf8"),
    ).resolves.toBe("{}\n");
    await expectMissingPath(path.join(stateDir, "sessions", "sessions.json"));
    await expectMissingPath(path.join(stateDir, "sessions", "trace.jsonl"));

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
    await expectMissingPath(resolveChannelAllowFromPath("chatapp", env, "default"));
    await expectMissingPath(resolveChannelAllowFromPath("chatapp", env, "beta"));
  });

  it("migrates legacy delivery queue files into shared SQLite state", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    await fs.mkdir(path.join(stateDir, "delivery-queue"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "delivery-queue", "failed"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "session-delivery-queue"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "session-delivery-queue", "failed"), { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "delivery-queue", "outbound-1.json"),
      JSON.stringify({
        id: "outbound-1",
        enqueuedAt: 10,
        retryCount: 2,
        channel: "telegram",
        to: "123",
        accountId: "main",
        payloads: [{ text: "hi" }],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(stateDir, "session-delivery-queue", "session-1.json"),
      JSON.stringify({
        id: "session-1",
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "resume",
        messageId: "m1",
        retryCount: 0,
        enqueuedAt: 20,
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(stateDir, "delivery-queue", "failed", "outbound-failed.json"),
      JSON.stringify({
        id: "outbound-failed",
        enqueuedAt: 30,
        retryCount: 3,
        channel: "telegram",
        to: "456",
        lastError: "permanent",
        payloads: [{ text: "nope" }],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(stateDir, "session-delivery-queue", "failed", "session-failed.json"),
      JSON.stringify({
        id: "session-failed",
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "failed resume",
        lastError: "expired",
        retryCount: 3,
        enqueuedAt: 40,
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.deliveryQueues.hasLegacy).toBe(true);

    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Migrated 2 outbound delivery queue entries → shared SQLite state",
    );
    expect(result.changes).toContain(
      "Migrated 2 session delivery queue entries → shared SQLite state",
    );
    const { db } = openOpenClawStateDatabase({ env });
    const rows = db
      .prepare(
        "SELECT queue_name, id, status, channel, target, retry_count FROM delivery_queue_entries ORDER BY queue_name, id",
      )
      .all();
    expect(rows).toEqual([
      {
        queue_name: "outbound",
        id: "outbound-1",
        status: "pending",
        channel: "telegram",
        target: "123",
        retry_count: 2,
      },
      {
        queue_name: "outbound",
        id: "outbound-failed",
        status: "failed",
        channel: "telegram",
        target: "456",
        retry_count: 3,
      },
      {
        queue_name: "session",
        id: "session-1",
        status: "pending",
        channel: null,
        target: null,
        retry_count: 0,
      },
      {
        queue_name: "session",
        id: "session-failed",
        status: "failed",
        channel: null,
        target: null,
        retry_count: 3,
      },
    ]);
    await expectMissingPath(path.join(stateDir, "delivery-queue"));
    await expectMissingPath(path.join(stateDir, "session-delivery-queue"));
  });

  it("migrates legacy voice wake JSON settings into shared SQLite state", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const settingsDir = path.join(stateDir, "settings");
    const triggersPath = path.join(settingsDir, "voicewake.json");
    const routingPath = path.join(settingsDir, "voicewake-routing.json");
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      triggersPath,
      JSON.stringify({ triggers: ["  wake ", "", "there"], updatedAtMs: -1 }),
      "utf8",
    );
    await fs.writeFile(
      routingPath,
      JSON.stringify({
        defaultTarget: { mode: "current" },
        routes: [
          { trigger: "  Robot   Wake ", target: { agentId: "Main Agent" } },
          { trigger: "", target: { sessionKey: "agent:main:voice" } },
        ],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.voiceWake.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Voice Wake settings: legacy JSON files → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 2 voice wake triggers → shared SQLite state");
    expect(result.changes).toContain(
      "Migrated voice wake routing config with 1 route → shared SQLite state",
    );
    await expect(loadVoiceWakeConfig(stateDir)).resolves.toMatchObject({
      triggers: ["wake", "there"],
    });
    await expect(loadVoiceWakeRoutingConfig(stateDir)).resolves.toMatchObject({
      defaultTarget: { mode: "current" },
      routes: [{ trigger: "robot wake", target: { agentId: "main-agent" } }],
    });
    await expectMissingPath(triggersPath);
    await expectMissingPath(routingPath);
    await expect(fs.readFile(`${triggersPath}.migrated`, "utf8")).resolves.toContain("wake");
    await expect(fs.readFile(`${routingPath}.migrated`, "utf8")).resolves.toContain("Robot");
  });

  it("archives legacy voice wake JSON when shared SQLite already matches", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const settingsDir = path.join(stateDir, "settings");
    const triggersPath = path.join(settingsDir, "voicewake.json");
    const routingPath = path.join(settingsDir, "voicewake-routing.json");
    await setVoiceWakeTriggers(["wake"], stateDir);
    await setVoiceWakeRoutingConfig(
      {
        defaultTarget: { mode: "current" },
        routes: [{ trigger: "robot wake", target: { agentId: "main" } }],
      },
      stateDir,
    );
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(triggersPath, JSON.stringify({ triggers: ["wake"] }), "utf8");
    await fs.writeFile(
      routingPath,
      JSON.stringify({
        defaultTarget: { mode: "current" },
        routes: [{ trigger: "robot wake", target: { agentId: "main" } }],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    await expectMissingPath(triggersPath);
    await expectMissingPath(routingPath);
    await expect(fs.readFile(`${triggersPath}.migrated`, "utf8")).resolves.toContain("wake");
    await expect(fs.readFile(`${routingPath}.migrated`, "utf8")).resolves.toContain("robot wake");
  });

  it("auto-migrates standalone legacy voice wake JSON settings", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const settingsDir = path.join(stateDir, "settings");
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      path.join(settingsDir, "voicewake.json"),
      JSON.stringify({ triggers: ["wake"] }),
      "utf8",
    );

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

    expect(result.skipped).toBe(false);
    expect(result.migrated).toBe(true);
    expect(result.warnings).toStrictEqual([]);
    await expect(loadVoiceWakeConfig(stateDir)).resolves.toMatchObject({ triggers: ["wake"] });
    await expectMissingPath(path.join(settingsDir, "voicewake.json"));
  });

  it("runs plugin doctor migrations after repairing shared state schema", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const stateDbPath = path.join(stateDir, "state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(stateDbPath), { recursive: true });
    const db = new DatabaseSync(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE agent_databases (
          agent_id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          size_bytes INTEGER
        );
        INSERT INTO agent_databases VALUES ('main', 'agent.sqlite', 1, 10, 20);
      `);
    } finally {
      db.close();
    }
    const migrateLegacyState = vi.fn(() => ({
      changes: ["plugin state migrated"],
      warnings: [],
    }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-test",
          label: "Memory Core test migration",
          detectLegacyState: () => ({ preview: ["plugin state"] }),
          migrateLegacyState,
        },
      },
    ];

    const result = await autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Migrated shared state agent database registry primary key → agent_id,path",
    );
    expect(result.changes).toContain("plugin state migrated");
    expect(migrateLegacyState).toHaveBeenCalledOnce();
  });

  it("does not run plugin doctor migrations after shared state schema repair fails", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const stateDbPath = path.join(stateDir, "state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(stateDbPath), { recursive: true });
    const db = new DatabaseSync(stateDbPath);
    try {
      db.exec("PRAGMA user_version = 2;");
    } finally {
      db.close();
    }
    const detectLegacyState = vi.fn(() => ({ preview: ["plugin state"] }));
    const migrateLegacyState = vi.fn(() => ({
      changes: ["plugin state migrated"],
      warnings: [],
    }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-schema-failure-test",
          label: "Memory Core schema failure test migration",
          detectLegacyState,
          migrateLegacyState,
        },
      },
    ];

    const result = await autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Failed migrating shared state database schema");
    expect(detectLegacyState).not.toHaveBeenCalled();
    expect(migrateLegacyState).not.toHaveBeenCalled();
  });

  it("reports plugin detector failures in read-only legacy state detection", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = { ...createConfig(), agents: { list: 42 } } as unknown as OpenClawConfig;
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "msteams",
        migration: {
          id: "msteams-readonly-malformed-config-test",
          label: "Microsoft Teams readonly malformed config test migration",
          detectLegacyState: () => {
            throw new TypeError("config.agents.list is not iterable");
          },
          migrateLegacyState: vi.fn(() => ({ changes: [], warnings: [] })),
        },
      },
    ];

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });

    expect(detected.pluginPlans?.hasLegacy).toBe(false);
    expect(detected.warnings).toStrictEqual([
      "Failed detecting Microsoft Teams readonly malformed config test migration: TypeError: config.agents.list is not iterable",
    ]);
  });

  it("continues plugin doctor migrations when one detector rejects malformed config", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = { ...createConfig(), agents: { list: 42 } } as unknown as OpenClawConfig;
    const migrateLegacyState = vi.fn(() => ({
      changes: ["healthy plugin state migrated"],
      warnings: [],
    }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "msteams",
        migration: {
          id: "msteams-malformed-config-test",
          label: "Microsoft Teams malformed config test migration",
          detectLegacyState: () => {
            throw new TypeError("config.agents.list is not iterable");
          },
          migrateLegacyState: vi.fn(() => ({ changes: [], warnings: [] })),
        },
      },
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-healthy-config-test",
          label: "Memory Core healthy config test migration",
          detectLegacyState: () => ({ preview: ["healthy plugin state"] }),
          migrateLegacyState,
        },
      },
    ];

    const result = await autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
    });

    expect(result.warnings).toStrictEqual([
      "Failed detecting Microsoft Teams malformed config test migration: TypeError: config.agents.list is not iterable",
    ]);
    expect(result.changes).toContain("healthy plugin state migrated");
    expect(migrateLegacyState).toHaveBeenCalledOnce();
  });

  it("skips stale plugin doctor plans when refresh detection fails", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const migrateLegacyState = vi.fn(() => ({
      changes: ["stale plugin state migrated"],
      warnings: [],
    }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-stale-plan-test",
          label: "Memory Core stale plan test migration",
          detectLegacyState: () => ({ preview: ["stale plugin state"] }),
          migrateLegacyState,
        },
      },
    ];
    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.pluginPlans?.hasLegacy).toBe(true);

    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-stale-plan-test",
          label: "Memory Core stale plan test migration",
          detectLegacyState: () => {
            throw new TypeError("config.agents.list is not iterable");
          },
          migrateLegacyState,
        },
      },
    ];

    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toContain(
      "Failed detecting Memory Core stale plan test migration: TypeError: config.agents.list is not iterable",
    );
    expect(result.changes).not.toContain("stale plugin state migrated");
    expect(migrateLegacyState).not.toHaveBeenCalled();
  });

  it("runs plugin doctor migrations against the canonical state dir after state-dir repair", async () => {
    const root = await createTempDir();
    const legacyStateDir = path.join(root, ".clawdbot");
    const canonicalStateDir = path.join(root, ".openclaw");
    await fs.mkdir(legacyStateDir, { recursive: true });
    await fs.writeFile(path.join(legacyStateDir, "legacy.txt"), "legacy", "utf8");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root };
    delete env.OPENCLAW_STATE_DIR;
    const cfg = createConfig();
    const detectedStateDirs: string[] = [];
    const migratedStateDirs: string[] = [];
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-state-dir-test",
          label: "Memory Core state dir test migration",
          detectLegacyState: ({ stateDir }) => {
            detectedStateDirs.push(stateDir);
            return { preview: ["plugin state"] };
          },
          migrateLegacyState: ({ stateDir }) => {
            migratedStateDirs.push(stateDir);
            return { changes: ["plugin state migrated"], warnings: [] };
          },
        },
      },
    ];

    const result = await autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("plugin state migrated");
    expect(detectedStateDirs).toStrictEqual([canonicalStateDir]);
    expect(migratedStateDirs).toStrictEqual([canonicalStateDir]);
    await expect(fs.access(path.join(canonicalStateDir, "legacy.txt"))).resolves.toBeUndefined();
  });

  it("migrates legacy update-check JSON into shared SQLite state", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const sourcePath = path.join(stateDir, "update-check.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        lastCheckedAt: "2026-01-17T09:30:00.000Z",
        lastAvailableVersion: "2.0.0",
        lastAvailableTag: "latest",
        autoInstallId: "install-1",
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.updateCheck.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Update-check state: legacy JSON file → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated update-check state → shared SQLite state");
    expect(readUpdateCheckState(env)).toMatchObject({
      last_checked_at: "2026-01-17T09:30:00.000Z",
      last_available_version: "2.0.0",
      last_available_tag: "latest",
      auto_install_id: "install-1",
    });
    await expectMissingPath(sourcePath);
    await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toContain("2.0.0");
  });

  it("migrates legacy config health JSON into shared SQLite state", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const configPath = path.join(stateDir, "openclaw.json");
    const logsDir = path.join(stateDir, "logs");
    const sourcePath = path.join(logsDir, "config-health.json");
    const fingerprint = {
      hash: "abc123",
      bytes: 42,
      mtimeMs: 1,
      ctimeMs: 2,
      dev: "3",
      ino: "4",
      mode: 384,
      nlink: 1,
      uid: 501,
      gid: 20,
      hasMeta: true,
      gatewayMode: "local",
      observedAt: "2026-01-17T09:30:00.000Z",
    };
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        entries: {
          [configPath]: {
            lastKnownGood: fingerprint,
            lastPromotedGood: fingerprint,
            lastObservedSuspiciousSignature: "abc123:size-drop",
          },
        },
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.configHealth.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Config health state: legacy JSON file → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 1 config health entry → shared SQLite state");
    expect(readConfigHealthRows(env)).toEqual([
      {
        config_path: configPath,
        last_known_good_json: JSON.stringify(fingerprint),
        last_promoted_good_json: JSON.stringify(fingerprint),
        last_observed_suspicious_signature: "abc123:size-drop",
      },
    ]);
    await expectMissingPath(sourcePath);
    await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toContain("abc123");
  });

  it("migrates legacy current-conversation bindings JSON into shared SQLite state", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const bindingsDir = path.join(stateDir, "bindings");
    const sourcePath = path.join(bindingsDir, "current-conversations.json");
    await fs.mkdir(bindingsDir, { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
            targetSessionKey: " agent:codex:acp:workspace-dm ",
            targetKind: "session",
            conversation: {
              channel: "workspace",
              accountId: "default",
              conversationId: "user:U123",
            },
            status: "active",
            boundAt: 1234,
            metadata: {
              label: "workspace-dm",
            },
          },
        ],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.currentConversationBindings.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Current-conversation bindings: legacy JSON file → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Migrated 1 current-conversation binding → shared SQLite state",
    );
    const rows = readCurrentConversationBindingRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      binding_id: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      target_session_key: "agent:codex:acp:workspace-dm",
      channel: "workspace",
      account_id: "default",
      conversation_id: "user:U123",
    });
    expect(JSON.parse(rows[0]?.record_json ?? "{}")).toMatchObject({
      metadata: { label: "workspace-dm" },
    });
    await expectMissingPath(sourcePath);
    await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toContain("workspace-dm");
  });

  it("migrates legacy plugin binding approvals JSON into shared SQLite state", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const sourcePath = path.join(stateDir, "plugin-binding-approvals.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        approvals: [
          {
            pluginRoot: "/plugins/codex-a",
            pluginId: "codex",
            pluginName: "Codex App Server",
            channel: "Discord",
            accountId: "default",
            approvedAt: 1234,
          },
        ],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.pluginBindingApprovals.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Plugin binding approvals: legacy JSON file → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 1 plugin binding approval → shared SQLite state");
    expect(readPluginBindingApprovalRows(env)).toEqual([
      {
        plugin_root: "/plugins/codex-a",
        channel: "discord",
        account_id: "default",
        plugin_id: "codex",
        plugin_name: "Codex App Server",
        approved_at: 1234,
      },
    ]);
    await expectMissingPath(sourcePath);
    await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toContain(
      "Codex App Server",
    );
  });

  it("migrates legacy plugin binding approvals from the home state dir when using a custom state dir", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, "custom-state");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const sourcePath = path.join(root, ".openclaw", "plugin-binding-approvals.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        approvals: [
          {
            pluginRoot: "/plugins/codex-a",
            pluginId: "codex",
            channel: "telegram",
            accountId: "default",
            approvedAt: 2345,
          },
        ],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.pluginBindingApprovals).toMatchObject({
      sourcePath,
      hasLegacy: true,
    });

    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 1 plugin binding approval → shared SQLite state");
    expect(readPluginBindingApprovalRows(env)).toEqual([
      {
        plugin_root: "/plugins/codex-a",
        channel: "telegram",
        account_id: "default",
        plugin_id: "codex",
        plugin_name: null,
        approved_at: 2345,
      },
    ]);
    await expectMissingPath(sourcePath);
  });

  it("imports non-conflicting legacy current-conversation bindings when SQLite has a conflict", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const bindingsDir = path.join(stateDir, "bindings");
    const sourcePath = path.join(bindingsDir, "current-conversations.json");
    const conflictingKey = "workspace\u241fdefault\u241f\u241fuser:U123";
    const missingKey = "workspace\u241fdefault\u241f\u241fuser:U456";
    await fs.mkdir(bindingsDir, { recursive: true });
    insertCurrentConversationBindingRow(env, {
      bindingKey: conflictingKey,
      bindingId: `generic:${conflictingKey}`,
      targetSessionKey: "agent:codex:acp:existing",
      channel: "workspace",
      accountId: "default",
      conversationId: "user:U123",
      recordJson: JSON.stringify({
        bindingId: `generic:${conflictingKey}`,
        targetSessionKey: "agent:codex:acp:existing",
        targetKind: "session",
        conversation: {
          channel: "workspace",
          accountId: "default",
          conversationId: "user:U123",
        },
        status: "active",
        boundAt: 1,
      }),
    });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            bindingId: `generic:${conflictingKey}`,
            targetSessionKey: "agent:codex:acp:legacy-conflict",
            targetKind: "session",
            conversation: {
              channel: "workspace",
              accountId: "default",
              conversationId: "user:U123",
            },
            status: "active",
            boundAt: 2,
          },
          {
            bindingId: `generic:${missingKey}`,
            targetSessionKey: "agent:codex:acp:legacy-missing",
            targetKind: "session",
            conversation: {
              channel: "workspace",
              accountId: "default",
              conversationId: "user:U456",
            },
            status: "active",
            boundAt: 3,
          },
        ],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.changes).toContain(
      "Migrated 1 current-conversation binding → shared SQLite state",
    );
    expect(result.warnings).toContain(
      `Left legacy current-conversation bindings in place because 1 binding conflicts with shared SQLite state: ${sourcePath}`,
    );
    expect(readCurrentConversationBindingRows(env)).toMatchObject([
      {
        binding_key: conflictingKey,
        target_session_key: "agent:codex:acp:existing",
      },
      {
        binding_key: missingKey,
        target_session_key: "agent:codex:acp:legacy-missing",
      },
    ]);
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toContain("legacy-conflict");
  });

  it("keeps legacy delivery queue files when shared SQLite already has a conflicting row", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const queueDir = path.join(stateDir, "delivery-queue");
    await fs.mkdir(path.join(queueDir, "failed"), { recursive: true });
    await fs.writeFile(
      path.join(queueDir, "outbound-1.json"),
      JSON.stringify({
        id: "outbound-1",
        enqueuedAt: 10,
        retryCount: 2,
        channel: "telegram",
        to: "123",
        payloads: [{ text: "hi" }],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(queueDir, "outbound-1.delivered"), '{"id":"done"}\n', "utf8");
    await fs.writeFile(
      path.join(queueDir, "outbound-2.json"),
      JSON.stringify({
        id: "outbound-2",
        enqueuedAt: 11,
        retryCount: 1,
        channel: "telegram",
        to: "456",
        payloads: [{ text: "still pending" }],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(queueDir, "failed", "outbound-failed.json"),
      JSON.stringify({
        id: "outbound-failed",
        enqueuedAt: 12,
        retryCount: 3,
        channel: "telegram",
        to: "789",
        lastError: "nope",
        payloads: [{ text: "failed once" }],
      }),
      "utf8",
    );

    const { db } = openOpenClawStateDatabase({ env });
    db.prepare(
      `
        INSERT INTO delivery_queue_entries (
          queue_name, id, status, channel, target, retry_count, entry_json,
          enqueued_at, updated_at
        ) VALUES (
          'outbound', 'outbound-1', 'pending', 'telegram', '123', 0,
          '{"id":"outbound-1","retryCount":0}', 10, 10
        )
      `,
    ).run();

    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.changes).toContain(
      "Migrated 2 outbound delivery queue entries → shared SQLite state",
    );
    expect(result.changes).toContain("Removed 1 outbound delivery queue delivered marker");
    expect(result.warnings).toStrictEqual([
      "Left outbound delivery queue in place because 1 entry already existed in shared state: outbound-1",
    ]);
    await expect(fs.readFile(path.join(queueDir, "outbound-1.json"), "utf8")).resolves.toContain(
      '"retryCount":2',
    );
    await expectMissingPath(path.join(queueDir, "outbound-1.delivered"));
    expect(
      db
        .prepare(
          "SELECT retry_count FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = 'outbound-1'",
        )
        .get(),
    ).toEqual({ retry_count: 0 });
    expect(
      db
        .prepare(
          "SELECT retry_count FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = 'outbound-2'",
        )
        .get(),
    ).toEqual({ retry_count: 1 });
    expect(
      db
        .prepare(
          "SELECT retry_count, failed_at FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = 'outbound-failed'",
        )
        .get(),
    ).toEqual({ retry_count: 3, failed_at: 12 });

    vi.setSystemTime(2_000);
    const rerunDetected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const rerunResult = await runLegacyStateMigrations({ detected: rerunDetected });
    expect(rerunResult.warnings).toStrictEqual([
      "Left outbound delivery queue in place because 1 entry already existed in shared state: outbound-1",
    ]);
  });

  it("preserves a corrupt target session store instead of overwriting it with legacy-only data", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    // target sessions.json is corrupt (trailing garbage → JSON5.parse fails) and
    // holds a target-only key that has no legacy counterpart.
    const corruptBytes = `${JSON.stringify({
      "agent:worker-1:desk:target-only": { sessionId: "target-only-session", updatedAt: 99 },
    })}\n<<<corrupt trailing garbage>>>`;
    await fs.writeFile(targetStorePath, corruptBytes, "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    // The corrupt bytes must survive on disk (parse still fails after migration).
    const afterRaw = await fs.readFile(targetStorePath, "utf8");
    expect(afterRaw).toContain("corrupt trailing garbage");
    expect(afterRaw).toBe(corruptBytes);

    // No "Merged sessions store" change was committed against the corrupt target.
    expect(result.changes.some((c) => c.startsWith("Merged sessions store"))).toBe(false);

    // And no direct-chat migration is reported either: the legacy direct entry was
    // not saved (the target was left untouched), so doctor/startup logs must not
    // claim a session migration happened on this skip path.
    expect(result.changes.some((c) => c.startsWith("Migrated latest direct-chat session"))).toBe(
      false,
    );

    // The user is warned that the target store was left untouched because it is unreadable.
    expect(result.warnings.some((w) => /unreadable|corrupt/i.test(w))).toBe(true);

    // Legacy store is NOT deleted or renamed, so a later explicit doctor --fix
    // can retry the migration from the detector's normal legacy path.
    await expect(
      fs.readFile(path.join(stateDir, "sessions", "sessions.json"), "utf8"),
    ).resolves.toContain("legacy-direct");
    await expect(fs.readFile(path.join(stateDir, "sessions", "trace.jsonl"), "utf8")).resolves.toBe(
      "{}\n",
    );
  });

  it("archives a corrupt target session store before explicit recovery", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    const corruptBytes = `${JSON.stringify({
      "agent:worker-1:desk:target-only": { sessionId: "target-only-session", updatedAt: 99 },
    })}\n<<<corrupt trailing garbage>>>`;
    await fs.writeFile(targetStorePath, corruptBytes, "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
      recoverCorruptTargetStore: true,
    });

    const archivedPath = `${targetStorePath}.corrupt-1234`;
    await expect(fs.readFile(archivedPath, "utf8")).resolves.toBe(corruptBytes);

    const recoveredStore = JSON.parse(await fs.readFile(targetStorePath, "utf8")) as Record<
      string,
      { sessionId?: string }
    >;
    expect(recoveredStore["agent:worker-1:desk"]?.sessionId).toBe("legacy-direct");
    expect(recoveredStore["agent:worker-1:desk:target-only"]).toBeUndefined();
    expect(result.changes).toContain(`Archived corrupt target sessions store → ${archivedPath}`);
    expect(result.changes).toContain(`Merged sessions store → ${targetStorePath}`);
    expect(result.warnings).toStrictEqual([]);
    await expectMissingPath(path.join(stateDir, "sessions", "sessions.json"));
  });
});
