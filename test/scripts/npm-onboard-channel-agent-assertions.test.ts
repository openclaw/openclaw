// Npm Onboard Channel Agent Assertions tests cover npm onboard channel agent assertions script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const assertionsPath = path.resolve("scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs");
const disableExperimentalWarning = "--disable-warning=ExperimentalWarning";

function nodeOptionsWithoutExperimentalWarnings(): string {
  const current = process.env.NODE_OPTIONS ?? "";
  return current.includes(disableExperimentalWarning)
    ? current
    : [current, disableExperimentalWarning].filter(Boolean).join(" ");
}

function writeConfigPayload(home: string, payload: Record<string, unknown>): void {
  const configDir = path.join(home, ".openclaw");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "openclaw.json"), JSON.stringify(payload));
}

function writeConfig(home: string, channels: Record<string, unknown>): void {
  writeConfigPayload(home, { channels });
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

function writeAuthProfileStoreSqlite(agentDir: string, store: unknown): void {
  fs.mkdirSync(agentDir, { recursive: true });
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_profile_store (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `
        INSERT INTO auth_profile_store (store_key, store_json, updated_at)
        VALUES (?, ?, ?)
      `,
    ).run("primary", JSON.stringify(store), Date.now());
  } finally {
    db.close();
  }
}

function writePluginInstallIndex(home: string, installRecords: Record<string, unknown>): void {
  const dbPath = path.join(home, ".openclaw", "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS installed_plugin_index (
        index_key TEXT NOT NULL PRIMARY KEY,
        version INTEGER NOT NULL,
        host_contract_version TEXT NOT NULL,
        compat_registry_version TEXT NOT NULL,
        migration_version INTEGER NOT NULL,
        policy_hash TEXT NOT NULL,
        generated_at_ms INTEGER NOT NULL,
        refresh_reason TEXT,
        install_records_json TEXT NOT NULL,
        plugins_json TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL,
        warning TEXT,
        updated_at_ms INTEGER NOT NULL
      );
    `);
    db.prepare(
      `
        INSERT INTO installed_plugin_index (
          index_key, version, host_contract_version, compat_registry_version,
          migration_version, policy_hash, generated_at_ms, refresh_reason,
          install_records_json, plugins_json, diagnostics_json, warning, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "installed-plugin-index",
      1,
      "test",
      "test",
      1,
      "test",
      Date.now(),
      "test",
      JSON.stringify(installRecords),
      JSON.stringify([]),
      JSON.stringify([]),
      "test",
      Date.now(),
    );
  } finally {
    db.close();
  }
}

function writeLegacyPluginInstallIndex(
  home: string,
  installRecords: Record<string, unknown>,
): void {
  const legacyPath = path.join(home, ".openclaw", "plugins", "installs.json");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify({ installRecords }));
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

function runStatusAssert(channel: string, channelsStatus: unknown, statusText: string) {
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
      },
    );
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

function runExternalInstallRecordAssert(home: string, channel: string) {
  return spawnSync(
    process.execPath,
    [assertionsPath, "assert-external-channel-install-record", channel],
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

describe("npm onboard channel agent assertions", () => {
  it("validates OpenAI env refs from the SQLite auth profile store", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-assertions-"));
    const agentDir = path.join(tempDir, ".openclaw", "agents", "main", "agent");

    try {
      writeOnboardConfig(tempDir);
      writeAuthProfileStoreSqlite(agentDir, {
        version: 1,
        profiles: {
          "openai:api-key": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      });

      const result = runOnboardAssert(tempDir);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(fs.existsSync(path.join(agentDir, "auth-profiles.json"))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
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
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-assertions-"));
      const agentDir = path.join(tempDir, ".openclaw", "agents", "main", "agent");

      try {
        writeOnboardConfig(tempDir);
        writeAuthProfileStoreSqlite(agentDir, store);

        const result = runOnboardAssert(tempDir);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("auth profile did not persist OPENAI_API_KEY env ref");
      } finally {
        fs.rmSync(tempDir, { force: true, recursive: true });
      }
    }
  });

  it("rejects inline OpenAI keys in the SQLite auth profile store", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-assertions-"));
    const agentDir = path.join(tempDir, ".openclaw", "agents", "main", "agent");

    try {
      writeOnboardConfig(tempDir);
      writeAuthProfileStoreSqlite(agentDir, {
        version: 1,
        profiles: {
          "openai:api-key": {
            type: "api_key",
            provider: "openai",
            key: "sk-openclaw-npm-onboard-e2e",
          },
        },
      });

      const result = runOnboardAssert(tempDir);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("auth profile persisted the raw OpenAI test key");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("validates channel tokens in their canonical config fields", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-assertions-"));
    try {
      writeConfig(tempDir, {
        discord: { enabled: true, token: "discord-token" },
        slack: { enabled: true, appToken: "xapp-token", botToken: "xoxb-token" },
        telegram: { enabled: true, botToken: "telegram-token" },
      });

      expect(runAssert(tempDir, "telegram", "telegram-token").status).toBe(0);
      expect(runAssert(tempDir, "discord", "discord-token").status).toBe(0);
      expect(runAssert(tempDir, "slack", "xoxb-token", "xapp-token").status).toBe(0);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects tokens persisted on the wrong channel config field", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-assertions-"));
    try {
      writeConfig(tempDir, {
        telegram: { enabled: true, token: "telegram-token" },
      });

      const result = runAssert(tempDir, "telegram", "telegram-token");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("telegram config did not persist botToken");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("validates external channel install records in the installed index", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-assertions-"));
    const installPath = path.join(
      tempDir,
      ".openclaw",
      "npm",
      "projects",
      "discord-project",
      "node_modules",
      "@openclaw",
      "discord",
    );
    try {
      writeConfig(tempDir, {
        discord: { enabled: true, token: "discord-token" },
      });
      fs.mkdirSync(installPath, { recursive: true });
      fs.writeFileSync(
        path.join(installPath, "package.json"),
        JSON.stringify({ name: "@openclaw/discord" }),
      );
      writePluginInstallIndex(tempDir, {
        discord: {
          source: "npm",
          spec: "@openclaw/discord@2026.5.1",
          installPath,
        },
      });

      const result = runExternalInstallRecordAssert(tempDir, "discord");

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects external channel install records left in transient config", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-assertions-"));
    const installPath = path.join(
      tempDir,
      ".openclaw",
      "npm",
      "projects",
      "slack-project",
      "node_modules",
      "@openclaw",
      "slack",
    );
    try {
      writeConfigPayload(tempDir, {
        channels: {
          slack: { enabled: true, botToken: "xoxb-token", appToken: "xapp-token" },
        },
        plugins: {
          installs: {
            slack: { source: "npm", spec: "@openclaw/slack" },
          },
        },
      });
      fs.mkdirSync(installPath, { recursive: true });
      fs.writeFileSync(
        path.join(installPath, "package.json"),
        JSON.stringify({ name: "@openclaw/slack" }),
      );
      writePluginInstallIndex(tempDir, {
        slack: {
          source: "npm",
          spec: "@openclaw/slack@2026.5.1",
          installPath,
        },
      });

      const result = runExternalInstallRecordAssert(tempDir, "slack");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "slack transient plugin install record was not moved to installed index",
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects legacy external channel install records without the SQLite installed index", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-assertions-"));
    const installPath = path.join(
      tempDir,
      ".openclaw",
      "npm",
      "projects",
      "discord-project",
      "node_modules",
      "@openclaw",
      "discord",
    );
    try {
      writeConfig(tempDir, {
        discord: { enabled: true, token: "discord-token" },
      });
      fs.mkdirSync(installPath, { recursive: true });
      fs.writeFileSync(
        path.join(installPath, "package.json"),
        JSON.stringify({ name: "@openclaw/discord" }),
      );
      writeLegacyPluginInstallIndex(tempDir, {
        discord: {
          source: "npm",
          spec: "@openclaw/discord@2026.5.1",
          installPath,
        },
      });

      const result = runExternalInstallRecordAssert(tempDir, "discord");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("discord SQLite installed plugin index is missing");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
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
});
