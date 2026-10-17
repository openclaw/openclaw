import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const assertionsPath = path.resolve("scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs");
const disableExperimentalWarning = "--disable-warning=ExperimentalWarning";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let tempDir: string;
beforeEach(() => {
  tempDir = tempDirs.make("openclaw-onboard-assertions-");
});

function authStore(fields: Record<string, unknown>) {
  return {
    version: 1,
    profiles: { "openai:api-key": { type: "api_key", provider: "openai", ...fields } },
  };
}
const envStore = () =>
  authStore({ keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" } });

function nodeOptionsWithoutExperimentalWarnings(): string {
  const current = process.env.NODE_OPTIONS ?? "";
  return current.includes(disableExperimentalWarning)
    ? current
    : [current, disableExperimentalWarning].filter(Boolean).join(" ");
}

function writeConfig(home: string, channels: Record<string, unknown>): void {
  const configDir = path.join(home, ".openclaw");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "openclaw.json"), JSON.stringify({ channels }));
}

function storeRef(fill: string) {
  return { source: "store", provider: "default", id: `CHANNEL_SETUP_${fill.repeat(32)}` };
}

function withDatabase(file: string, write: (db: DatabaseSync) => void): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    write(db);
  } finally {
    db.close();
  }
}

function writeTeamSecrets(home: string, values: Record<string, string>): void {
  withDatabase(path.join(home, ".openclaw/state/openclaw.sqlite"), (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS secret_store_entries (
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        deleted_at_ms INTEGER,
        PRIMARY KEY (scope_kind, scope_id, name)
      ) STRICT;
    `);
    const insert = db.prepare(
      "INSERT OR REPLACE INTO secret_store_entries (scope_kind, scope_id, name, value) VALUES ('team', '', ?, ?)",
    );
    for (const [fill, value] of Object.entries(values)) {
      insert.run(storeRef(fill).id, value);
    }
  });
}

function writeOnboardConfig(home: string): void {
  const configDir = path.join(home, ".openclaw");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "openclaw.json"),
    JSON.stringify({
      auth: {
        profiles: {
          "openai:api-key": { provider: "openai", mode: "api_key" },
        },
      },
    }),
  );
}

function writeSharedAuthProfileStoreSqlite(home: string, store: unknown): void {
  withDatabase(path.join(home, ".openclaw/state/openclaw.sqlite"), (db) => {
    db.exec(`
      PRAGMA user_version = 13;
      CREATE TABLE IF NOT EXISTS config_machine_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
    db.prepare(
      `
        INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
        VALUES (?, ?, ?)
      `,
    ).run("authProfiles.store", JSON.stringify(store), Date.now());
  });
}

function writeLegacyPrimaryAuthProfileStoreSqlite(home: string, store: unknown): void {
  withDatabase(path.join(home, ".openclaw/agents/main/agent/openclaw-agent.sqlite"), (db) => {
    db.exec(`
      CREATE TABLE auth_profile_store (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    db.prepare(
      "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
    ).run("primary", JSON.stringify(store), Date.now());
  });
}

function runAssert(home: string, channel: string, ...tokens: string[]) {
  return spawnSync(
    process.execPath,
    [assertionsPath, "assert-channel-config", channel, ...tokens],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
      },
    },
  );
}

function runOnboardAssert(home: string) {
  return spawnSync(process.execPath, [assertionsPath, "assert-onboard-state", home], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
    },
  });
}

function runMockModelAssert(home: string, command: string, port: string) {
  return spawnSync(process.execPath, [assertionsPath, command, port], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
    },
  });
}

function runStatusAssert(
  channel: string,
  channelsStatus: unknown,
  statusText: string,
  env: NodeJS.ProcessEnv = {},
) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-assertions-"));
  try {
    const channelsStatusPath = path.join(tempDir, "channels-status.json");
    const statusTextPath = path.join(tempDir, "status.txt");
    fs.writeFileSync(channelsStatusPath, JSON.stringify(channelsStatus));
    fs.writeFileSync(statusTextPath, statusText);
    return spawnSync(
      process.execPath,
      [assertionsPath, "assert-status-surfaces", channel, channelsStatusPath, statusTextPath],
      {
        encoding: "utf8",
        env: { ...process.env, ...env },
      },
    );
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

describe("npm onboard channel agent assertions", () => {
  it("rejects loose mock OpenAI port args", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-assertions-"));

    try {
      for (const command of ["configure-mock-model", "assert-mock-model-config"]) {
        const result = runMockModelAssert(tempDir, command, "1e3");

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("mock OpenAI port must be a TCP port from 1 to 65535");
        expect(result.stderr).toContain('"1e3"');
      }
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("configures and validates the canonical main agent's mock model", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-mock-agent-"));
    const configPath = path.join(home, ".openclaw", "openclaw.json");

    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          agents: {
            defaults: { models: {} },
            entries: { main: { model: "openai/gpt-5.6" } },
          },
          models: { providers: {} },
        }),
      );

      expect(runMockModelAssert(home, "configure-mock-model", "18181").status).toBe(0);
      expect(runMockModelAssert(home, "assert-mock-model-config", "18181").status).toBe(0);

      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        agents: {
          entries: Record<
            string,
            {
              model?: { primary?: string };
              models?: Record<string, { agentRuntime?: { id?: string } }>;
            }
          >;
        };
      };
      expect(cfg.agents.entries.main).toMatchObject({
        model: { primary: "openai/gpt-5.6-luna" },
        models: {
          "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } },
        },
      });
    } finally {
      fs.rmSync(home, { force: true, recursive: true });
    }
  });

  it("rejects a canonical main agent that does not use the configured mock model", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-mock-agent-"));
    const configPath = path.join(home, ".openclaw", "openclaw.json");

    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          agents: {
            defaults: { models: {} },
            entries: { main: { model: "openai/gpt-5.6" } },
          },
          models: { providers: {} },
        }),
      );
      expect(runMockModelAssert(home, "configure-mock-model", "18181").status).toBe(0);

      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        agents: { entries: Record<string, { model?: { primary?: string } }> };
      };
      const mainAgent = cfg.agents.entries.main;
      if (!mainAgent) {
        throw new Error("mock configuration did not contain the main agent");
      }
      mainAgent.model = { primary: "openai/gpt-5.6" };
      fs.writeFileSync(configPath, JSON.stringify(cfg));

      const result = runMockModelAssert(home, "assert-mock-model-config", "18181");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("mock agent model was not preserved");
    } finally {
      fs.rmSync(home, { force: true, recursive: true });
    }
  });

  it("validates OpenAI env refs from the shared SQLite auth profile store", () => {
    const agentDir = path.join(tempDir, ".openclaw", "agents", "main", "agent");
    writeOnboardConfig(tempDir);
    writeSharedAuthProfileStoreSqlite(tempDir, envStore());

    const result = runOnboardAssert(tempDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.existsSync(agentDir)).toBe(false);
    expect(fs.existsSync(path.join(agentDir, "auth-profiles.json"))).toBe(false);
  });

  it("validates OpenAI env refs from a frozen release's primary agent store", () => {
    writeOnboardConfig(tempDir);
    writeLegacyPrimaryAuthProfileStoreSqlite(tempDir, envStore());

    const result = runOnboardAssert(tempDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects auth profile stores without a usable OpenAI env ref", () => {
    const cases: unknown[] = [
      "OPENAI_API_KEY",
      {
        version: 1,
        profiles: {
          "openai:api-key": { note: "OPENAI_API_KEY" },
        },
      },
    ];

    for (const store of cases) {
      const home = tempDirs.make("openclaw-invalid-profile-");
      writeOnboardConfig(home);
      writeSharedAuthProfileStoreSqlite(home, store);

      const result = runOnboardAssert(home);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("auth profile did not persist OPENAI_API_KEY env ref");
    }
  });

  it("rejects inline OpenAI keys in the SQLite auth profile store", () => {
    writeOnboardConfig(tempDir);
    writeSharedAuthProfileStoreSqlite(tempDir, authStore({ key: "sk-openclaw-npm-onboard-e2e" }));

    const result = runOnboardAssert(tempDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("auth profile persisted the raw OpenAI test key");
  });

  it("permits an unrelated main-agent database", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-assertions-"));
    const legacyAgentDir = path.join(tempDir, ".openclaw", "agents", "main", "agent");

    try {
      writeOnboardConfig(tempDir);
      writeSharedAuthProfileStoreSqlite(tempDir, {
        version: 1,
        profiles: {
          "openai:api-key": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      });
      fs.mkdirSync(legacyAgentDir, { recursive: true });
      new DatabaseSync(path.join(legacyAgentDir, "openclaw-agent.sqlite")).close();

      const result = runOnboardAssert(tempDir);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("validates channel tokens in their canonical config fields", () => {
    writeConfig(tempDir, {
      discord: { enabled: true, token: storeRef("A") },
      slack: { enabled: true, appToken: storeRef("B"), botToken: storeRef("C") },
      telegram: { enabled: true, botToken: storeRef("D") },
    });
    writeTeamSecrets(tempDir, {
      A: "discord-token",
      B: "xapp-token",
      C: "xoxb-token",
      D: "telegram-token",
    });

    expect(runAssert(tempDir, "telegram", "telegram-token").status).toBe(0);
    expect(runAssert(tempDir, "discord", "discord-token").status).toBe(0);
    expect(runAssert(tempDir, "slack", "xoxb-token", "xapp-token").status).toBe(0);
    expect(runAssert(tempDir, "discord", "wrong-discord-token").stderr).toContain(
      `discord token SecretRef ${storeRef("A").id} did not store the expected token`,
    );
    // Swapped Slack credentials must not pass.
    expect(runAssert(tempDir, "slack", "xapp-token", "xoxb-token").stderr).toContain(
      "did not store the expected token",
    );
  });

  it("rejects tokens persisted on the wrong channel config field", () => {
    writeConfig(tempDir, {
      telegram: { enabled: true, token: storeRef("A") },
    });

    const result = runAssert(tempDir, "telegram", "telegram-token");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("telegram config did not persist botToken");
  });

  it("rejects plaintext channel tokens in config", () => {
    writeConfig(tempDir, {
      telegram: { enabled: true, botToken: "telegram-token" },
    });
    const result = runAssert(tempDir, "telegram", "telegram-token");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not persist botToken as a store SecretRef");

    writeConfig(tempDir, {
      telegram: { enabled: true, botToken: storeRef("A"), note: "telegram-token" },
    });
    const leaked = runAssert(tempDir, "telegram", "telegram-token");
    expect(leaked.status).not.toBe(0);
    expect(leaked.stderr).toContain("telegram config persisted the plaintext botToken");
  });

  it("validates configured channels in the plain status Channels section", () => {
    const result = runStatusAssert(
      "telegram",
      { configuredChannels: ["telegram"] },
      [
        "# OpenClaw status",
        "",
        "# Overview",
        "OS macOS",
        "",
        "# Channels",
        "Channel State Detail",
        "telegram ok configured",
        "",
        "# Sessions",
        "No sessions",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
  });

  it("rejects plain status output that mentions the channel outside the Channels section", () => {
    const result = runStatusAssert(
      "telegram",
      { configuredChannels: ["telegram"] },
      [
        "# OpenClaw status",
        "",
        "# Overview",
        "OS macOS",
        "",
        "# Channels",
        "No channels configured",
        "",
        "# Sessions",
        "telegram appeared in an unrelated session note",
      ].join("\n"),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "plain status output did not mention telegram in the Channels section",
    );
  });

  it("rejects oversized plain status output before parsing it", () => {
    const result = runStatusAssert(
      "telegram",
      { configuredChannels: ["telegram"] },
      `# OpenClaw status\n${"x".repeat(128)}`,
      { OPENCLAW_NPM_ONBOARD_STATUS_TEXT_MAX_BYTES: "64" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("plain status output exceeded 64 bytes");
  });

  it("rejects oversized channels status JSON before parsing it", () => {
    const result = runStatusAssert(
      "telegram",
      { configuredChannels: ["telegram"], filler: "x".repeat(128) },
      "# Channels\ntelegram ok configured",
      { OPENCLAW_NPM_ONBOARD_JSON_ARTIFACT_MAX_BYTES: "64" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("JSON artifact exceeded 64 bytes");
  });
});
