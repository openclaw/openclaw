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
  const stateDir = path.join(home, ".openclaw", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(path.join(stateDir, "openclaw.sqlite"));
  try {
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
  } finally {
    db.close();
  }
}

function writeLegacyPrimaryAuthProfileStoreSqlite(home: string, store: unknown): void {
  const agentDir = path.join(home, ".openclaw", "agents", "main", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  try {
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
  } finally {
    db.close();
  }
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

describe("npm onboard channel agent assertions", () => {
  it("validates OpenAI env refs from the shared SQLite auth profile store", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-assertions-"));
    const agentDir = path.join(tempDir, ".openclaw", "agents", "main", "agent");

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

      const result = runOnboardAssert(tempDir);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(fs.existsSync(agentDir)).toBe(false);
      expect(fs.existsSync(path.join(agentDir, "auth-profiles.json"))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("validates OpenAI env refs from a frozen release's primary agent store", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-assertions-"));
    try {
      writeOnboardConfig(tempDir);
      writeLegacyPrimaryAuthProfileStoreSqlite(tempDir, {
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

      try {
        writeOnboardConfig(tempDir);
        writeSharedAuthProfileStoreSqlite(tempDir, store);

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
    try {
      writeOnboardConfig(tempDir);
      writeSharedAuthProfileStoreSqlite(tempDir, {
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
});
