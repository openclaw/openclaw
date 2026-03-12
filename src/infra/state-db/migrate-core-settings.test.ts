import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCoreSettingFromDb, setCoreSettingInDb } from "./core-settings-sqlite.js";
import { migrateCoreSettingsToSqlite } from "./migrate-core-settings.js";
import { useCoreSettingsTestDb } from "./test-helpers.core-settings.js";

describe("migrateCoreSettingsToSqlite", () => {
  useCoreSettingsTestDb();

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

  it("migrates voicewake.json to core_settings", () => {
    const stateDir = makeStateDir();
    const data = { triggers: ["hey", "wake"], updatedAtMs: 12345 };
    writeJsonFile(stateDir, "settings/voicewake.json", data);

    const env = { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
    const results = migrateCoreSettingsToSqlite(env);
    const r = results.find((r) => r.store === "voicewake");

    expect(r?.migrated).toBe(true);
    expect(r?.count).toBe(1);

    const stored = getCoreSettingFromDb<typeof data>("voicewake");
    expect(stored?.triggers).toEqual(["hey", "wake"]);

    expect(fs.existsSync(path.join(stateDir, "settings/voicewake.json"))).toBe(false);
  });

  it("migrates tts.json to core_settings", () => {
    const stateDir = makeStateDir();
    const data = { tts: { auto: "off", provider: "apple" } };
    writeJsonFile(stateDir, "settings/tts.json", data);

    const env = { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
    const results = migrateCoreSettingsToSqlite(env);
    const r = results.find((r) => r.store === "tts");

    expect(r?.migrated).toBe(true);
    const stored = getCoreSettingFromDb<typeof data>("tts");
    expect(stored?.tts?.provider).toBe("apple");
  });

  it("migrates device.json to core_settings", () => {
    const stateDir = makeStateDir();
    const data = {
      version: 1,
      deviceId: "dev-123",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
      createdAtMs: 9999,
    };
    writeJsonFile(stateDir, "identity/device.json", data);

    const env = { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
    const results = migrateCoreSettingsToSqlite(env);
    const r = results.find((r) => r.store === "device-identity");

    expect(r?.migrated).toBe(true);
    const stored = getCoreSettingFromDb<typeof data>("device");
    expect(stored?.deviceId).toBe("dev-123");
    expect(stored?.privateKeyPem).toContain("PRIVATE KEY");

    expect(fs.existsSync(path.join(stateDir, "identity/device.json"))).toBe(false);
  });

  it("migrates device-auth.json to core_settings", () => {
    const stateDir = makeStateDir();
    const data = {
      version: 1,
      deviceId: "dev-123",
      tokens: { admin: { token: "tok-abc", scopes: ["*"], obtainedAtMs: 1000 } },
    };
    writeJsonFile(stateDir, "identity/device-auth.json", data);

    const env = { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
    const results = migrateCoreSettingsToSqlite(env);
    const r = results.find((r) => r.store === "device-auth");

    expect(r?.migrated).toBe(true);
    const stored = getCoreSettingFromDb<typeof data>("device-auth");
    expect(stored?.tokens?.admin?.token).toBe("tok-abc");
  });

  it("migrates restart-sentinel.json to core_settings", () => {
    const stateDir = makeStateDir();
    const data = { version: 1, payload: { kind: "restart", status: "ok", ts: 5000 } };
    writeJsonFile(stateDir, "restart-sentinel.json", data);

    const env = { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
    const results = migrateCoreSettingsToSqlite(env);
    const r = results.find((r) => r.store === "restart-sentinel");

    expect(r?.migrated).toBe(true);
    const stored = getCoreSettingFromDb<typeof data>("gateway", "restart-sentinel");
    expect(stored?.payload?.kind).toBe("restart");
  });

  it("migrates update-check.json to core_settings", () => {
    const stateDir = makeStateDir();
    const data = { lastCheckedAt: "2026-01-01T00:00:00Z", lastNotifiedVersion: "2026.1.1" };
    writeJsonFile(stateDir, "update-check.json", data);

    const env = { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
    const results = migrateCoreSettingsToSqlite(env);
    const r = results.find((r) => r.store === "update-check");

    expect(r?.migrated).toBe(true);
    const stored = getCoreSettingFromDb<typeof data>("gateway", "update-check");
    expect(stored?.lastNotifiedVersion).toBe("2026.1.1");
  });

  it("migrates apns-registrations.json to core_settings", () => {
    const stateDir = makeStateDir();
    const data = {
      registrationsByNodeId: {
        node1: {
          nodeId: "node1",
          token: "tok",
          topic: "com.x",
          environment: "production",
          updatedAtMs: 1,
        },
      },
    };
    writeJsonFile(stateDir, "push/apns-registrations.json", data);

    const env = { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
    const results = migrateCoreSettingsToSqlite(env);
    const r = results.find((r) => r.store === "apns-registrations");

    expect(r?.migrated).toBe(true);
    const stored = getCoreSettingFromDb<typeof data>("push");
    expect(stored?.registrationsByNodeId?.node1?.token).toBe("tok");
  });

  it("skips migration when DB already has data", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "settings/voicewake.json", { triggers: ["new"], updatedAtMs: 1 });

    // Pre-populate DB
    setCoreSettingInDb("voicewake", "", { triggers: ["old"], updatedAtMs: 0 });

    const env = { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
    const results = migrateCoreSettingsToSqlite(env);
    const r = results.find((r) => r.store === "voicewake");

    expect(r?.migrated).toBe(false);

    // Original DB data preserved
    const stored = getCoreSettingFromDb<{ triggers: string[] }>("voicewake");
    expect(stored?.triggers).toEqual(["old"]);

    // File should still be cleaned up
    expect(fs.existsSync(path.join(stateDir, "settings/voicewake.json"))).toBe(false);
  });

  it("handles missing state directory gracefully", () => {
    const env = { OPENCLAW_STATE_DIR: "/nonexistent/path" } as unknown as NodeJS.ProcessEnv;
    const results = migrateCoreSettingsToSqlite(env);

    for (const r of results) {
      expect(r.migrated).toBe(false);
      expect(r.error).toBeUndefined();
    }
  });

  it("migrates all 7 files in a single call", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "settings/voicewake.json", { triggers: ["a"] });
    writeJsonFile(stateDir, "settings/tts.json", { tts: {} });
    writeJsonFile(stateDir, "identity/device.json", { version: 1, deviceId: "d" });
    writeJsonFile(stateDir, "identity/device-auth.json", { version: 1, deviceId: "d", tokens: {} });
    writeJsonFile(stateDir, "restart-sentinel.json", { version: 1, payload: {} });
    writeJsonFile(stateDir, "update-check.json", { lastCheckedAt: "x" });
    writeJsonFile(stateDir, "push/apns-registrations.json", { registrationsByNodeId: {} });

    const env = { OPENCLAW_STATE_DIR: stateDir } as unknown as NodeJS.ProcessEnv;
    const results = migrateCoreSettingsToSqlite(env);

    expect(results).toHaveLength(7);
    const migrated = results.filter((r) => r.migrated);
    expect(migrated).toHaveLength(7);
  });
});
