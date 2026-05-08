import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTextAtomic } from "../../infra/json-files.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveSessionTranscriptsDirForAgent } from "./paths.js";
import {
  importJsonSessionStoreToSqlite,
  loadSqliteSessionEntries,
  replaceSqliteSessionEntries,
} from "./store-backend.sqlite.js";
import {
  deleteSessionEntry,
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  upsertSessionEntry,
} from "./store.js";
import type { SessionEntry } from "./types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-session-store-"));
}

function resolveLegacySessionJsonFixturePath(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
}): string {
  return path.join(
    resolveSessionTranscriptsDirForAgent(params.agentId, params.env),
    "sessions.json",
  );
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
});

describe("SQLite session store backend", () => {
  it("round-trips session entries by agent id", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
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

    replaceSqliteSessionEntries(
      { agentId: "main", env, now: () => 1000 },
      { "discord:u1": mainEntry },
    );
    replaceSqliteSessionEntries(
      { agentId: "ops", env, now: () => 1000 },
      { "discord:u1": opsEntry },
    );

    expect(loadSqliteSessionEntries({ agentId: "main", env })).toEqual({
      "discord:u1": mainEntry,
    });
    expect(loadSqliteSessionEntries({ agentId: "ops", env })).toEqual({
      "discord:u1": opsEntry,
    });
  });

  it("imports legacy sessions.json into SQLite and removes the JSON source", async () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
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
        env,
      }),
    ).toEqual({ imported: 1, sourcePath: legacyStorePath, removedSource: true });

    expect(fs.existsSync(legacyStorePath)).toBe(false);
    expect(loadSqliteSessionEntries({ agentId: "main", env })).toEqual({
      "discord:user-1": {
        ...entry,
        deliveryContext: {
          channel: "discord",
          to: "user-1",
        },
      },
    });
  });

  it("routes the production session row API through SQLite", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const storePath = resolveLegacySessionJsonFixturePath({
      agentId: "ops",
      env,
    });
    const entry: SessionEntry = {
      sessionId: "sqlite-primary",
      sessionFile: "sqlite-primary.jsonl",
      updatedAt: 100,
    };

    upsertSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops", entry });
    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:ops",
      entry: {
        ...entry,
        updatedAt: 200,
        modelOverride: "gpt-5.5",
      },
    });

    expect(fs.existsSync(storePath)).toBe(false);
    expect(loadSqliteSessionEntries({ agentId: "ops", env })).toEqual({
      "discord:ops": {
        ...entry,
        updatedAt: 200,
        modelOverride: "gpt-5.5",
      },
    });
  });

  it("updates one session entry without replacing the whole SQLite store", async () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    replaceSqliteSessionEntries(
      { agentId: "ops", env },
      {
        "discord:ops": {
          sessionId: "ops-session",
          sessionFile: "ops.jsonl",
          updatedAt: 100,
        },
        "discord:other": {
          sessionId: "other-session",
          sessionFile: "other.jsonl",
          updatedAt: 50,
        },
      },
    );

    const updated = await patchSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:ops",
      update: async () => ({ modelOverride: "gpt-5.5", updatedAt: 200 }),
    });

    expect(updated?.modelOverride).toBe("gpt-5.5");
    expect(loadSqliteSessionEntries({ agentId: "ops", env })).toEqual({
      "discord:ops": expect.objectContaining({
        sessionId: "ops-session",
        sessionFile: "ops.jsonl",
        modelOverride: "gpt-5.5",
      }),
      "discord:other": {
        sessionId: "other-session",
        sessionFile: "other.jsonl",
        updatedAt: 50,
      },
    });
  });

  it("exposes row-level session entry APIs by agent id", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:ops",
      entry: {
        sessionId: "ops-session",
        sessionFile: "ops.jsonl",
        updatedAt: 100,
      },
    });
    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:other",
      entry: {
        sessionId: "other-session",
        sessionFile: "other.jsonl",
        updatedAt: 50,
      },
    });

    expect(getSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops" })).toMatchObject({
      sessionId: "ops-session",
    });
    expect(listSessionEntries({ agentId: "ops", env }).map((row) => row.sessionKey)).toEqual([
      "discord:ops",
      "discord:other",
    ]);
    expect(deleteSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops" })).toBe(true);
    expect(getSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops" })).toBeUndefined();
    expect(getSessionEntry({ agentId: "main", env, sessionKey: "discord:other" })).toBeUndefined();
  });

  it("uses SQLite by default for canonical per-agent session rows", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const storePath = resolveLegacySessionJsonFixturePath({
      agentId: "ops",
      env,
    });
    const entry: SessionEntry = {
      sessionId: "sqlite-default",
      sessionFile: "sqlite-default.jsonl",
      updatedAt: 100,
    };

    upsertSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops", entry });

    expect(fs.existsSync(storePath)).toBe(false);
    expect(loadSqliteSessionEntries({ agentId: "ops", env })).toEqual({
      "discord:ops": entry,
    });
  });

  it("does not import a legacy canonical sessions.json on first SQLite open", async () => {
    const stateDir = createTempDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const storePath = resolveLegacySessionJsonFixturePath({
      agentId: "ops",
      env: process.env,
    });
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

    expect(loadSqliteSessionEntries({ agentId: "ops", env: process.env })).toEqual({});

    upsertSessionEntry({
      agentId: "ops",
      sessionKey: "discord:ops",
      entry: {
        ...legacyEntry,
        sessionId: "sqlite-session",
        updatedAt: 200,
      },
    });
    expect(loadSqliteSessionEntries({ agentId: "ops", env: process.env })).toEqual({
      "discord:ops": {
        ...legacyEntry,
        sessionId: "sqlite-session",
        updatedAt: 200,
      },
    });
  });
});
