import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveChannelAllowFromPath } from "../pairing/pairing-store.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { detectLegacyStateMigrations, runLegacyStateMigrations } from "./state-migrations.js";

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
      telegram: {
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
    `${JSON.stringify({ "group:123@g.us": { sessionId: "group-session", updatedAt: 5 } }, null, 2)}\n`,
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
  await fs.writeFile(resolveChannelAllowFromPath("telegram", env), '["123","456"]\n', "utf8");

  return {
    root,
    stateDir,
    env,
    cfg,
  };
}

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("state migrations", () => {
  it("detects legacy sessions, agent files, whatsapp auth, and telegram allowFrom copies", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });

    expect(detected.targetAgentId).toBe("worker-1");
    expect(detected.targetMainKey).toBe("desk");
    expect(detected.sessions.hasLegacy).toBe(true);
    expect(detected.sessions.legacyKeys).toEqual(["group:123@g.us"]);
    expect(detected.agentDir.hasLegacy).toBe(true);
    expect(detected.channelPlans.hasLegacy).toBe(true);
    expect(detected.channelPlans.plans.map((plan) => plan.targetPath)).toEqual([
      path.join(stateDir, "credentials", "whatsapp", "default", "creds.json"),
      path.join(stateDir, "credentials", "whatsapp", "default", "pre-key-1.json"),
      resolveChannelAllowFromPath("telegram", env, "alpha"),
    ]);
    expect(detected.preview).toEqual([
      `- Sessions: ${path.join(stateDir, "sessions")} → ${path.join(stateDir, "agents", "worker-1", "sessions")}`,
      `- Sessions: canonicalize legacy keys in ${path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json")}`,
      `- Agent dir: ${path.join(stateDir, "agent")} → ${path.join(stateDir, "agents", "worker-1", "agent")}`,
      `- WhatsApp auth creds.json: ${path.join(stateDir, "credentials", "creds.json")} → ${path.join(stateDir, "credentials", "whatsapp", "default", "creds.json")}`,
      `- WhatsApp auth pre-key-1.json: ${path.join(stateDir, "credentials", "pre-key-1.json")} → ${path.join(stateDir, "credentials", "whatsapp", "default", "pre-key-1.json")}`,
      `- Telegram pairing allowFrom: ${resolveChannelAllowFromPath("telegram", env)} → ${resolveChannelAllowFromPath("telegram", env, "alpha")}`,
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

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      `Migrated latest direct-chat session → agent:worker-1:desk`,
      `Merged sessions store → ${path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json")}`,
      "Canonicalized 1 legacy session key(s)",
      "Moved trace.jsonl → agents/worker-1/sessions",
      "Moved agent file settings.json → agents/worker-1/agent",
      `Moved WhatsApp auth creds.json → ${path.join(stateDir, "credentials", "whatsapp", "default", "creds.json")}`,
      `Moved WhatsApp auth pre-key-1.json → ${path.join(stateDir, "credentials", "whatsapp", "default", "pre-key-1.json")}`,
      `Copied Telegram pairing allowFrom → ${resolveChannelAllowFromPath("telegram", env, "alpha")}`,
    ]);

    const mergedStore = JSON.parse(
      await fs.readFile(
        path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json"),
        "utf8",
      ),
    ) as Record<string, { sessionId: string }>;
    expect(mergedStore["agent:worker-1:desk"]?.sessionId).toBe("legacy-direct");
    expect(mergedStore["agent:worker-1:whatsapp:group:123@g.us"]?.sessionId).toBe("group-session");

    await expect(
      fs.readFile(path.join(stateDir, "agents", "worker-1", "sessions", "trace.jsonl"), "utf8"),
    ).resolves.toBe("{}\n");
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
      fs.readFile(path.join(stateDir, "credentials", "whatsapp", "default", "creds.json"), "utf8"),
    ).resolves.toContain('"auth":true');
    await expect(
      fs.readFile(
        path.join(stateDir, "credentials", "whatsapp", "default", "pre-key-1.json"),
        "utf8",
      ),
    ).resolves.toContain('"preKey":true');
    await expect(
      fs.readFile(path.join(stateDir, "credentials", "oauth.json"), "utf8"),
    ).resolves.toContain('"oauth":true');
    await expect(
      fs.readFile(resolveChannelAllowFromPath("telegram", env, "alpha"), "utf8"),
    ).resolves.toBe('["123","456"]\n');
    await expect(
      fs.stat(resolveChannelAllowFromPath("telegram", env, "default")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(resolveChannelAllowFromPath("telegram", env, "beta")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
