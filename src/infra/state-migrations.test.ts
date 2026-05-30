import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRestartRecoveryDeliveryContext } from "../agents/restart-recovery-delivery-state.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveChannelAllowFromPath } from "../pairing/pairing-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { detectLegacyStateMigrations, runLegacyStateMigrations } from "./state-migrations.js";

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

  it("migrates legacy restart recovery delivery fields into SQLite", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const storePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      `${JSON.stringify(
        {
          "agent:worker-1:desk": {
            sessionId: "session-1",
            updatedAt: 123,
            restartRecoveryDeliveryContext: {
              channel: "Discord",
              to: " discord:dm:123 ",
              accountId: "Main",
              threadId: 42.5,
            },
            restartRecoveryDeliveryRunId: "run-1",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    expect(detected.restartRecoveryDeliveryContexts).toMatchObject({
      hasLegacy: true,
      count: 1,
    });
    expect(detected.preview).toEqual([
      "- Restart recovery delivery contexts: migrate 1 session JSON route → shared SQLite state",
    ]);

    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toEqual([
      "Migrated 1 restart recovery delivery context → shared SQLite state",
    ]);
    expect(
      readRestartRecoveryDeliveryContext({
        sessionId: "session-1",
        sessionKey: "agent:worker-1:desk",
        storePath,
      }),
    ).toMatchObject({
      runId: "run-1",
      sessionId: "session-1",
      context: {
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        threadId: 42,
      },
      updatedAtMs: 123,
    });
    const migratedStore = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(migratedStore["agent:worker-1:desk"]?.restartRecoveryDeliveryContext).toBeUndefined();
    expect(migratedStore["agent:worker-1:desk"]?.restartRecoveryDeliveryRunId).toBeUndefined();
  });

  it("migrates restart recovery delivery fields while merging legacy sessions", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await fs.writeFile(
      legacyStorePath,
      `${JSON.stringify(
        {
          legacyDirect: {
            sessionId: "legacy-session",
            updatedAt: 456,
            restartRecoveryDeliveryContext: {
              channel: "discord",
              to: "discord:dm:456",
            },
            restartRecoveryDeliveryRunId: "legacy-run",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });

    expect(detected.sessions.hasLegacy).toBe(true);
    expect(detected.restartRecoveryDeliveryContexts.count).toBe(1);
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toEqual([
      "Migrated latest direct-chat session → agent:worker-1:desk",
      "Migrated 2 restart recovery delivery contexts → shared SQLite state",
      `Merged sessions store → ${targetStorePath}`,
    ]);
    expect(
      readRestartRecoveryDeliveryContext({
        sessionId: "legacy-session",
        sessionKey: "agent:worker-1:desk",
        storePath: targetStorePath,
      }),
    ).toMatchObject({
      runId: "legacy-run",
      context: {
        channel: "discord",
        to: "discord:dm:456",
      },
      updatedAtMs: 456,
    });
    const migratedStore = JSON.parse(await fs.readFile(targetStorePath, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(migratedStore["agent:worker-1:desk"]?.restartRecoveryDeliveryContext).toBeUndefined();
    expect(migratedStore["agent:worker-1:desk"]?.restartRecoveryDeliveryRunId).toBeUndefined();
    await expectMissingPath(legacyStorePath);
  });

  it("migrates restart recovery delivery fields from discovered agent stores", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const storePath = path.join(stateDir, "agents", "sidekick", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      `${JSON.stringify(
        {
          "agent:sidekick:main": {
            sessionId: "side-session",
            updatedAt: 789,
            restartRecoveryDeliveryContext: {
              channel: "discord",
              to: "discord:dm:789",
            },
            restartRecoveryDeliveryRunId: "side-run",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });

    expect(detected.restartRecoveryDeliveryContexts).toMatchObject({
      hasLegacy: true,
      count: 1,
    });
    expect(
      detected.restartRecoveryDeliveryContexts.storePaths.some((candidate) =>
        candidate.endsWith(path.join("agents", "sidekick", "sessions", "sessions.json")),
      ),
    ).toBe(true);
    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toEqual([
      "Migrated 1 restart recovery delivery context → shared SQLite state",
    ]);
    expect(
      readRestartRecoveryDeliveryContext({
        sessionId: "side-session",
        sessionKey: "agent:sidekick:main",
        stateDir,
        storePath,
      }),
    ).toMatchObject({
      runId: "side-run",
      context: {
        channel: "discord",
        to: "discord:dm:789",
      },
      updatedAtMs: 789,
    });
    const migratedStore = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(migratedStore["agent:sidekick:main"]?.restartRecoveryDeliveryContext).toBeUndefined();
    expect(migratedStore["agent:sidekick:main"]?.restartRecoveryDeliveryRunId).toBeUndefined();
  });
});
