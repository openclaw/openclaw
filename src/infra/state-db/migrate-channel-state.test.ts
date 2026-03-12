import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beforeEach } from "vitest";
import {
  getAuthCredentialsFromDb,
  resetAuthCredentialsDbForTest,
  setAuthCredentialsDbForTest,
} from "./auth-credentials-sqlite.js";
import { getDcStateFromDb } from "./channel-dc-state-sqlite.js";
import { getTgStateFromDb, setTgStateInDb } from "./channel-tg-state-sqlite.js";
import { migrateChannelStateToSqlite } from "./migrate-channel-state.js";
import { useChannelStateTestDb } from "./test-helpers.channel-state.js";

describe("migrateChannelStateToSqlite", () => {
  // Use channel state test db for tg/dc adapters
  const ctx = useChannelStateTestDb();

  // Also wire auth credentials to the same in-memory DB
  beforeEach(() => {
    setAuthCredentialsDbForTest(ctx.getDb());
  });
  afterEach(() => {
    resetAuthCredentialsDbForTest();
  });

  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function makeStateDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-migrate-cs-"));
    return tmpDir;
  }

  function writeJsonFile(dir: string, relPath: string, data: unknown) {
    const filePath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
  }

  it("migrates telegram update-offset files", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "telegram/update-offset-default.json", {
      version: 2,
      lastUpdateId: 42000,
      botId: "12345",
    });

    const env = { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
    const results = migrateChannelStateToSqlite(env);
    const r = results.find((r) => r.store === "telegram-update-offsets");

    expect(r?.migrated).toBe(true);
    expect(r?.count).toBe(1);

    const stored = getTgStateFromDb<{ lastUpdateId: number; botId: string }>(
      "default",
      "update_offset",
    );
    expect(stored?.lastUpdateId).toBe(42000);
    expect(stored?.botId).toBe("12345");

    expect(fs.existsSync(path.join(stateDir, "telegram/update-offset-default.json"))).toBe(false);
  });

  it("migrates telegram sticker-cache.json", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "telegram/sticker-cache.json", {
      version: 1,
      stickers: {
        "unique-1": {
          fileId: "f1",
          fileUniqueId: "unique-1",
          description: "test sticker",
          cachedAt: "2026-01-01T00:00:00Z",
        },
      },
    });

    const env = { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
    const results = migrateChannelStateToSqlite(env);
    const r = results.find((r) => r.store === "telegram-sticker-cache");

    expect(r?.migrated).toBe(true);
    expect(r?.count).toBe(1);

    const stored = getTgStateFromDb<Record<string, unknown>>("global", "sticker_cache");
    expect(stored).not.toBeNull();
    expect((stored as Record<string, { fileId: string }>)["unique-1"]?.fileId).toBe("f1");
  });

  it("migrates discord model-picker-preferences.json", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "discord/model-picker-preferences.json", {
      version: 1,
      entries: {
        "discord:default:dm:user:u1": {
          recent: ["openai/gpt-4o"],
          updatedAt: "2026-01-01",
        },
      },
    });

    const env = { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
    const results = migrateChannelStateToSqlite(env);
    const r = results.find((r) => r.store === "discord-model-picker-preferences");

    expect(r?.migrated).toBe(true);
    expect(r?.count).toBe(1);

    const stored = getDcStateFromDb<{ recent: string[] }>(
      "model_picker_preferences",
      "discord:default:dm:user:u1",
    );
    expect(stored?.recent).toEqual(["openai/gpt-4o"]);
  });

  it("migrates github-copilot.token.json", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "credentials/github-copilot.token.json", {
      token: "ghu_test;proxy-ep=proxy.example.com;",
      expiresAt: 9999999999999,
      updatedAt: 1000,
    });

    const env = { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
    const results = migrateChannelStateToSqlite(env);
    const r = results.find((r) => r.store === "github-copilot-token");

    expect(r?.migrated).toBe(true);
    expect(r?.count).toBe(1);

    const stored = getAuthCredentialsFromDb<{ token: string }>("github-copilot");
    expect(stored?.token).toContain("ghu_test");
  });

  it("handles missing state directory gracefully", () => {
    const env = { OPENCLAW_STATE_DIR: "/nonexistent/path" } as unknown as NodeJS.ProcessEnv;
    const results = migrateChannelStateToSqlite(env);

    for (const r of results) {
      expect(r.migrated).toBe(false);
      expect(r.error).toBeUndefined();
    }
  });

  it("skips telegram offset when DB already has data", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "telegram/update-offset-default.json", {
      version: 2,
      lastUpdateId: 999,
      botId: "111",
    });

    // Pre-populate DB
    setTgStateInDb("default", "update_offset", { lastUpdateId: 1, botId: "old" });

    const env = { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
    const results = migrateChannelStateToSqlite(env);
    const r = results.find((r) => r.store === "telegram-update-offsets");

    // Should not migrate (DB already has data)
    expect(r?.count).toBe(0);

    // Old data preserved
    const stored = getTgStateFromDb<{ lastUpdateId: number }>("default", "update_offset");
    expect(stored?.lastUpdateId).toBe(1);

    // File should still be cleaned up
    expect(fs.existsSync(path.join(stateDir, "telegram/update-offset-default.json"))).toBe(false);
  });
});
