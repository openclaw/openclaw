import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTextAtomic } from "../../infra/json-files.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveStorePath } from "./paths.js";
import {
  exportSqliteSessionStore,
  importJsonSessionStoreToSqlite,
  loadSqliteSessionStore,
  saveSqliteSessionStore,
} from "./store-backend.sqlite.js";
import { loadSessionStore } from "./store-load.js";
import { saveSessionStore, updateSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

const ORIGINAL_SESSION_STORE_BACKEND = process.env.OPENCLAW_SESSION_STORE_BACKEND;
const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-session-store-"));
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  if (ORIGINAL_SESSION_STORE_BACKEND === undefined) {
    delete process.env.OPENCLAW_SESSION_STORE_BACKEND;
  } else {
    process.env.OPENCLAW_SESSION_STORE_BACKEND = ORIGINAL_SESSION_STORE_BACKEND;
  }
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
});

describe("SQLite session store backend", () => {
  it("round-trips session entries by agent id", () => {
    const stateDir = createTempDir();
    const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
    const mainEntry: SessionEntry = {
      sessionId: "main-session",
      sessionFile: "/tmp/main.jsonl",
      updatedAt: 123,
    };
    const opsEntry: SessionEntry = {
      sessionId: "ops-session",
      sessionFile: "/tmp/ops.jsonl",
      updatedAt: 456,
    };

    saveSqliteSessionStore(
      { agentId: "main", path: dbPath, now: () => 1000 },
      { "discord:u1": mainEntry },
    );
    saveSqliteSessionStore(
      { agentId: "ops", path: dbPath, now: () => 1000 },
      { "discord:u1": opsEntry },
    );

    expect(loadSqliteSessionStore({ agentId: "main", path: dbPath })).toEqual({
      "discord:u1": mainEntry,
    });
    expect(loadSqliteSessionStore({ agentId: "ops", path: dbPath })).toEqual({
      "discord:u1": opsEntry,
    });
  });

  it("imports legacy sessions.json and exports the SQLite snapshot", async () => {
    const stateDir = createTempDir();
    const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
    const legacyStorePath = path.join(stateDir, "sessions.json");
    const entry: SessionEntry = {
      sessionId: "legacy-session",
      sessionFile: "/tmp/legacy.jsonl",
      updatedAt: 999,
      lastChannel: "discord",
      lastTo: "user-1",
    };
    await writeTextAtomic(
      legacyStorePath,
      JSON.stringify(
        {
          "discord:user-1": entry,
        },
        null,
        2,
      ),
    );

    expect(
      importJsonSessionStoreToSqlite({
        agentId: "main",
        sourcePath: legacyStorePath,
        dbPath,
      }),
    ).toEqual({ imported: 1, sourcePath: legacyStorePath });

    expect(exportSqliteSessionStore({ agentId: "main", path: dbPath })).toEqual({
      "discord:user-1": {
        ...entry,
        deliveryContext: {
          channel: "discord",
          to: "user-1",
        },
      },
    });
  });

  it("routes the production session store API through SQLite behind the opt-in flag", async () => {
    const stateDir = createTempDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_SESSION_STORE_BACKEND = "sqlite";
    const storePath = resolveStorePath(undefined, { agentId: "ops", env: process.env });
    const entry: SessionEntry = {
      sessionId: "sqlite-primary",
      sessionFile: "sqlite-primary.jsonl",
      updatedAt: 100,
    };

    await saveSessionStore(storePath, { "discord:ops": entry }, { skipMaintenance: true });
    await updateSessionStore(
      storePath,
      (store) => {
        store["discord:ops"] = {
          ...store["discord:ops"],
          updatedAt: 200,
          modelOverride: "gpt-5.5",
        };
      },
      { skipMaintenance: true },
    );

    expect(fs.existsSync(storePath)).toBe(false);
    expect(loadSessionStore(storePath, { skipCache: true })).toEqual({
      "discord:ops": {
        ...entry,
        updatedAt: 200,
        modelOverride: "gpt-5.5",
      },
    });
  });

  it("uses SQLite by default for canonical per-agent session stores", async () => {
    const stateDir = createTempDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    delete process.env.OPENCLAW_SESSION_STORE_BACKEND;
    const storePath = resolveStorePath(undefined, { agentId: "ops", env: process.env });
    const entry: SessionEntry = {
      sessionId: "sqlite-default",
      sessionFile: "sqlite-default.jsonl",
      updatedAt: 100,
    };

    await saveSessionStore(storePath, { "discord:ops": entry }, { skipMaintenance: true });

    expect(fs.existsSync(storePath)).toBe(false);
    expect(loadSessionStore(storePath, { skipCache: true })).toEqual({
      "discord:ops": entry,
    });
  });

  it("keeps canonical per-agent session stores file-backed when the JSON backend is forced", async () => {
    const stateDir = createTempDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_SESSION_STORE_BACKEND = "json";
    const storePath = resolveStorePath(undefined, { agentId: "ops", env: process.env });
    const entry: SessionEntry = {
      sessionId: "json-forced",
      sessionFile: "json-forced.jsonl",
      updatedAt: 100,
    };

    await saveSessionStore(storePath, { "discord:ops": entry }, { skipMaintenance: true });

    expect(fs.existsSync(storePath)).toBe(true);
    expect(loadSessionStore(storePath, { skipCache: true })).toEqual({
      "discord:ops": entry,
    });
  });

  it("imports a legacy canonical sessions.json once on first SQLite open", async () => {
    const stateDir = createTempDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_SESSION_STORE_BACKEND = "sqlite";
    const storePath = resolveStorePath(undefined, { agentId: "ops", env: process.env });
    const legacyEntry: SessionEntry = {
      sessionId: "legacy-session",
      sessionFile: "legacy-session.jsonl",
      updatedAt: 100,
    };
    await writeTextAtomic(
      storePath,
      JSON.stringify(
        {
          "discord:ops": legacyEntry,
        },
        null,
        2,
      ),
    );

    expect(loadSessionStore(storePath, { skipCache: true })).toEqual({
      "discord:ops": legacyEntry,
    });

    await saveSessionStore(
      storePath,
      {
        "discord:ops": {
          ...legacyEntry,
          sessionId: "sqlite-session",
          updatedAt: 200,
        },
      },
      { skipMaintenance: true },
    );
    await writeTextAtomic(
      storePath,
      JSON.stringify(
        {
          "discord:ops": {
            ...legacyEntry,
            sessionId: "stale-json-session",
            updatedAt: 300,
          },
        },
        null,
        2,
      ),
    );

    expect(loadSessionStore(storePath, { skipCache: true })).toEqual({
      "discord:ops": {
        ...legacyEntry,
        sessionId: "sqlite-session",
        updatedAt: 200,
      },
    });
  });
});
