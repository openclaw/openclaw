// Session SQLite downgrade rescue tests cover beta-to-JSON recovery.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withTempDirSync } from "../../test-helpers/temp-dir.js";
import { clearSessionStoreCacheForTest, loadSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

afterEach(() => {
  clearSessionStoreCacheForTest();
});

function seedBetaSqliteSessionStore(params: {
  sqlitePath: string;
  entries: Record<string, SessionEntry>;
}): void {
  fs.mkdirSync(path.dirname(params.sqlitePath), { recursive: true });
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(params.sqlitePath);
  try {
    database.exec(`
      CREATE TABLE cache_entries (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT,
        blob BLOB,
        expires_at INTEGER,
        updated_at INTEGER,
        PRIMARY KEY (scope, key)
      );
    `);
    const insert = database.prepare(
      "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)",
    );
    for (const [key, entry] of Object.entries(params.entries)) {
      insert.run("session_entries", key, JSON.stringify(entry), entry.updatedAt ?? 0);
    }
  } finally {
    database.close();
  }
}

function resolveCustomBetaSqlitePath(storePath: string): string {
  const resolvedStorePath = path.resolve(storePath);
  const storeHash = crypto.createHash("sha256").update(resolvedStorePath).digest("hex");
  return path.join(
    path.dirname(resolvedStorePath),
    `openclaw-session-store-${storeHash.slice(0, 16)}.sqlite`,
  );
}

describe("beta SQLite session downgrade rescue", () => {
  it("restores missing sessions.json from beta agent SQLite rows", () => {
    withTempDirSync({ prefix: "openclaw-session-sqlite-rescue-" }, (stateDir) => {
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const sqlitePath = resolveOpenClawAgentSqlitePath({
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      seedBetaSqliteSessionStore({
        sqlitePath,
        entries: {
          "agent:main:main": {
            sessionId: "sess-main",
            updatedAt: 123,
            lastChannel: "telegram",
          },
        },
      });

      const store = loadSessionStore(storePath, { skipCache: true });

      expect(store["agent:main:main"]?.sessionId).toBe("sess-main");
      expect(JSON.parse(fs.readFileSync(storePath, "utf8"))).toMatchObject({
        "agent:main:main": { sessionId: "sess-main" },
      });
    });
  });

  it("restores a missing custom session store from beta hashed SQLite rows", () => {
    withTempDirSync({ prefix: "openclaw-session-sqlite-rescue-custom-" }, (rootDir) => {
      const storePath = path.join(rootDir, "custom", "sessions.json");
      const sqlitePath = resolveCustomBetaSqlitePath(storePath);
      seedBetaSqliteSessionStore({
        sqlitePath,
        entries: {
          custom: { sessionId: "custom-session", updatedAt: 10 },
        },
      });

      const store = loadSessionStore(storePath, { skipCache: true });

      expect(store.custom?.sessionId).toBe("custom-session");
      expect(JSON.parse(fs.readFileSync(storePath, "utf8"))).toEqual({
        custom: { sessionId: "custom-session", updatedAt: 10 },
      });
    });
  });

  it("does not overwrite an existing JSON session store", () => {
    withTempDirSync({ prefix: "openclaw-session-sqlite-rescue-existing-" }, (stateDir) => {
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(
        storePath,
        `${JSON.stringify({ json: { sessionId: "json-session", updatedAt: 2 } }, null, 2)}\n`,
      );
      const sqlitePath = resolveOpenClawAgentSqlitePath({
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      seedBetaSqliteSessionStore({
        sqlitePath,
        entries: {
          sqlite: { sessionId: "sqlite-session", updatedAt: 1 },
        },
      });

      const store = loadSessionStore(storePath, { skipCache: true });

      expect(store.json?.sessionId).toBe("json-session");
      expect(store.sqlite).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(storePath, "utf8"))).toEqual({
        json: { sessionId: "json-session", updatedAt: 2 },
      });
    });
  });

  it("does not pre-read existing non-empty JSON session stores during rescue checks", () => {
    withTempDirSync({ prefix: "openclaw-session-sqlite-rescue-existing-read-" }, (stateDir) => {
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(
        storePath,
        `${JSON.stringify({ json: { sessionId: "json-session", updatedAt: 2 } }, null, 2)}\n`,
      );
      const originalReadFileSync = fs.readFileSync.bind(fs);
      let storeReads = 0;
      const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((file, ...args) => {
        if (file === storePath) {
          storeReads += 1;
        }
        return originalReadFileSync(file, ...(args as [Parameters<typeof fs.readFileSync>[1]]));
      });

      try {
        const store = loadSessionStore(storePath, { skipCache: true });

        expect(store.json?.sessionId).toBe("json-session");
        expect(storeReads).toBe(1);
      } finally {
        readSpy.mockRestore();
      }
    });
  });
});
