import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SESSION_VERSION } from "../../agents/transcript/session-transcript-contract.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSqliteSessionEntries } from "../../config/sessions/session-entries.sqlite.js";
import { loadSqliteSessionTranscriptEvents } from "../../config/sessions/transcript-store.sqlite.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { resolveLegacyChannelAllowFromPath } from "./legacy/channel-pairing-files.js";
import { detectLegacyStateMigrations, runLegacyStateMigrations } from "./state-migrations.js";

type DeliveryQueueTestDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;
type CurrentConversationBindingsTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;
type PluginStateTestDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_state_entries">;
type MigrationMetadataTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "migration_runs" | "migration_sources"
>;

vi.mock("../../channels/plugins/bundled.js", () => {
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
    listBundledChannelDoctorSessionMigrationSurfaces: vi.fn(() => [
      {
        isLegacyGroupSessionKey: (key: string) => /^group:mobile-/i.test(key.trim()),
        canonicalizeLegacySessionKey: ({ key, agentId }: { key: string; agentId: string }) =>
          /^group:mobile-/i.test(key.trim())
            ? `agent:${agentId}:mobileauth:${key.trim().toLowerCase()}`
            : null,
      },
    ]),
    listBundledChannelDoctorLegacyStateDetectors: vi.fn(() => [
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
    [
      JSON.stringify({
        type: "session",
        id: "legacy-trace",
        timestamp: "2026-05-06T00:00:00.000Z",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-05-06T00:00:01.000Z",
        message: { role: "user", content: "hello", timestamp: 1 },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-05-06T00:00:02.000Z",
        message: { role: "hookMessage", content: "legacy hook", timestamp: 2 },
      }),
      JSON.stringify({
        type: "compaction",
        timestamp: "2026-05-06T00:00:03.000Z",
        summary: "legacy compaction",
        firstKeptEntryIndex: 1,
        tokensBefore: 100,
      }),
    ].join("\n") + "\n",
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
  await fs.writeFile(resolveLegacyChannelAllowFromPath("chatapp", env), '["123","456"]\n', "utf8");

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
      resolveLegacyChannelAllowFromPath("chatapp", env, "alpha"),
    ]);
    expect(detected.preview).toEqual([
      `- Sessions: import ${path.join(stateDir, "sessions")} into SQLite`,
      `- Sessions: canonicalize legacy keys in ${path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json")}`,
      `- Sessions: import ${path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json")} into SQLite`,
      `- Agent dir: ${path.join(stateDir, "agent")} → ${path.join(stateDir, "agents", "worker-1", "agent")}`,
      `- MobileAuth auth creds.json: ${path.join(stateDir, "credentials", "creds.json")} → ${path.join(stateDir, "credentials", "mobileauth", "default", "creds.json")}`,
      `- ChatApp pairing allowFrom: ${resolveLegacyChannelAllowFromPath("chatapp", env)} → ${resolveLegacyChannelAllowFromPath("chatapp", env, "alpha")}`,
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
      "Imported trace.jsonl transcript (4 event(s)) into SQLite for agent worker-1",
      "Moved agent file settings.json → agents/worker-1/agent",
      `Moved MobileAuth auth creds.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "creds.json")}`,
      `Moved MobileAuth auth pre-key-1.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "pre-key-1.json")}`,
      `Copied ChatApp pairing allowFrom → ${resolveLegacyChannelAllowFromPath("chatapp", env, "alpha")}`,
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

    const importedTranscriptEvents = loadSqliteSessionTranscriptEvents({
      agentId: "worker-1",
      sessionId: "legacy-trace",
      env,
    });
    expect(importedTranscriptEvents).toHaveLength(4);
    await expectMissingPath(path.join(stateDir, "agents", "worker-1", "sessions", "trace.jsonl"));
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
      fs.readFile(resolveLegacyChannelAllowFromPath("chatapp", env, "alpha"), "utf8"),
    ).resolves.toBe('["123","456"]\n');
    await expectMissingPath(resolveLegacyChannelAllowFromPath("chatapp", env, "default"));
    await expectMissingPath(resolveLegacyChannelAllowFromPath("chatapp", env, "beta"));
  });
});
