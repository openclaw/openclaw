import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import {
  getCoreSettingFromDb,
  resetCoreSettingsDbForTest,
  setCoreSettingsDbForTest,
} from "./core-settings-sqlite.js";
import { migratePhase5cToSqlite } from "./migrate-phase5c.js";
import { runMigrations } from "./schema.js";

describe("migratePhase5cToSqlite", () => {
  let db: ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
  let tmpDir: string;

  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    setCoreSettingsDbForTest(db);
  });

  afterEach(() => {
    resetCoreSettingsDbForTest();
    try {
      db.close();
    } catch {
      // ignore
    }
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function makeStateDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-migrate-5c-"));
    return tmpDir;
  }

  function writeJsonFile(dir: string, relPath: string, data: unknown) {
    const filePath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
  }

  function makeEnv(stateDir: string): NodeJS.ProcessEnv {
    return { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
  }

  it("migrates node.json to core_settings", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "node.json", {
      version: 1,
      nodeId: "node-abc",
      token: "tok-xyz",
      displayName: "My Node",
      gateway: { host: "gw.example.com", port: 443, tls: true },
    });

    const results = migratePhase5cToSqlite(makeEnv(stateDir));
    const r = results.find((r) => r.store === "node-host-config");

    expect(r?.migrated).toBe(true);
    expect(r?.count).toBe(1);

    const stored = getCoreSettingFromDb<{ nodeId: string; token: string }>("node-host", "config");
    expect(stored?.nodeId).toBe("node-abc");
    expect(stored?.token).toBe("tok-xyz");

    expect(fs.existsSync(path.join(stateDir, "node.json"))).toBe(false);
  });

  it("skips migration if DB already has data", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "node.json", {
      version: 1,
      nodeId: "node-original",
      token: "tok-original",
    });

    // First run populates DB
    migratePhase5cToSqlite(makeEnv(stateDir));

    // Write file back with different data
    writeJsonFile(stateDir, "node.json", {
      version: 1,
      nodeId: "node-new",
      token: "tok-new",
    });

    const results = migratePhase5cToSqlite(makeEnv(stateDir));
    const r = results.find((r) => r.store === "node-host-config");
    expect(r?.migrated).toBe(false);

    // Original data preserved
    const stored = getCoreSettingFromDb<{ nodeId: string }>("node-host", "config");
    expect(stored?.nodeId).toBe("node-original");

    // File cleaned up
    expect(fs.existsSync(path.join(stateDir, "node.json"))).toBe(false);
  });

  it("skips missing node.json without error", () => {
    const stateDir = makeStateDir();
    const results = migratePhase5cToSqlite(makeEnv(stateDir));
    const r = results.find((r) => r.store === "node-host-config");
    expect(r?.migrated).toBe(false);
    expect(r?.error).toBeUndefined();
  });

  it("returns non-migrated result when no file exists", () => {
    const stateDir = makeStateDir();
    const results = migratePhase5cToSqlite(makeEnv(stateDir));
    expect(results.every((r) => !r.migrated && !r.error)).toBe(true);
  });
});
