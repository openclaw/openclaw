import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import {
  getPairedDevicesFromDb,
  getPendingDevicePairingsFromDb,
  resetDevicePairingDbForTest,
  setDevicePairingDbForTest,
} from "./device-pairing-sqlite.js";
import { migratePhase5aToSqlite } from "./migrate-phase5a.js";
import {
  getPairedNodesFromDb,
  getPendingNodePairingsFromDb,
  resetNodePairingDbForTest,
  setNodePairingDbForTest,
} from "./node-pairing-sqlite.js";
import { runMigrations } from "./schema.js";

describe("migratePhase5aToSqlite", () => {
  let db: ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
  let tmpDir: string;

  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    setDevicePairingDbForTest(db);
    setNodePairingDbForTest(db);
  });

  afterEach(() => {
    resetDevicePairingDbForTest();
    resetNodePairingDbForTest();
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-migrate-5a-"));
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

  // ── Device pairing ─────────────────────────────────────────────────────────

  it("migrates devices/pending.json and devices/paired.json", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "devices/pending.json", {
      "req-1": {
        requestId: "req-1",
        deviceId: "dev-abc",
        publicKey: "pk-abc",
        platform: "ios",
        ts: 1700000000000,
      },
    });
    writeJsonFile(stateDir, "devices/paired.json", {
      "dev-xyz": {
        deviceId: "dev-xyz",
        publicKey: "pk-xyz",
        platform: "macos",
        createdAtMs: 1700000001000,
        approvedAtMs: 1700000002000,
      },
    });

    const results = migratePhase5aToSqlite(makeEnv(stateDir));
    const r = results.find((r) => r.store === "device-pairing");

    expect(r?.migrated).toBe(true);
    expect(r?.count).toBe(2); // 1 pending + 1 paired

    expect(getPendingDevicePairingsFromDb()).toHaveLength(1);
    expect(getPendingDevicePairingsFromDb()[0].requestId).toBe("req-1");
    expect(getPairedDevicesFromDb()).toHaveLength(1);
    expect(getPairedDevicesFromDb()[0].deviceId).toBe("dev-xyz");

    expect(fs.existsSync(path.join(stateDir, "devices", "pending.json"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "devices", "paired.json"))).toBe(false);
  });

  it("skips device-pairing migration if DB already has data", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "devices/pending.json", {
      "req-1": {
        requestId: "req-1",
        deviceId: "dev-abc",
        publicKey: "pk-abc",
        ts: 1700000000000,
      },
    });

    // First run populates DB
    migratePhase5aToSqlite(makeEnv(stateDir));
    // Write file back
    writeJsonFile(stateDir, "devices/pending.json", {
      "req-2": {
        requestId: "req-2",
        deviceId: "dev-new",
        publicKey: "pk-new",
        ts: 1700000000000,
      },
    });

    const results = migratePhase5aToSqlite(makeEnv(stateDir));
    const r = results.find((r) => r.store === "device-pairing");
    expect(r?.migrated).toBe(false);
    // Original data preserved
    expect(getPendingDevicePairingsFromDb()[0].requestId).toBe("req-1");
    // File cleaned up
    expect(fs.existsSync(path.join(stateDir, "devices", "pending.json"))).toBe(false);
  });

  it("skips missing device pairing files without error", () => {
    const stateDir = makeStateDir();
    const results = migratePhase5aToSqlite(makeEnv(stateDir));
    const r = results.find((r) => r.store === "device-pairing");
    expect(r?.migrated).toBe(false);
    expect(r?.error).toBeUndefined();
  });

  it("migrates only paired.json when pending.json is absent", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "devices/paired.json", {
      "dev-abc": {
        deviceId: "dev-abc",
        publicKey: "pk-abc",
        createdAtMs: 1700000001000,
        approvedAtMs: 1700000002000,
      },
    });

    migratePhase5aToSqlite(makeEnv(stateDir));
    expect(getPairedDevicesFromDb()).toHaveLength(1);
    expect(fs.existsSync(path.join(stateDir, "devices", "paired.json"))).toBe(false);
  });

  // ── Node pairing ────────────────────────────────────────────────────────────

  it("migrates nodes/pending.json and nodes/paired.json", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "nodes/pending.json", {
      "req-n1": {
        requestId: "req-n1",
        nodeId: "node-abc",
        platform: "linux",
        ts: 1700000000000,
      },
    });
    writeJsonFile(stateDir, "nodes/paired.json", {
      "node-xyz": {
        nodeId: "node-xyz",
        token: "tok-xyz",
        platform: "linux",
        createdAtMs: 1700000001000,
        approvedAtMs: 1700000002000,
      },
    });

    const results = migratePhase5aToSqlite(makeEnv(stateDir));
    const r = results.find((r) => r.store === "node-pairing");

    expect(r?.migrated).toBe(true);
    expect(r?.count).toBe(2);

    expect(getPendingNodePairingsFromDb()).toHaveLength(1);
    expect(getPendingNodePairingsFromDb()[0].requestId).toBe("req-n1");
    expect(getPairedNodesFromDb()).toHaveLength(1);
    expect(getPairedNodesFromDb()[0].nodeId).toBe("node-xyz");

    expect(fs.existsSync(path.join(stateDir, "nodes", "pending.json"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "nodes", "paired.json"))).toBe(false);
  });

  it("skips node-pairing migration if DB already has data", () => {
    const stateDir = makeStateDir();
    writeJsonFile(stateDir, "nodes/paired.json", {
      "node-abc": {
        nodeId: "node-abc",
        token: "tok-abc",
        createdAtMs: 1700000001000,
        approvedAtMs: 1700000002000,
      },
    });

    migratePhase5aToSqlite(makeEnv(stateDir));
    writeJsonFile(stateDir, "nodes/paired.json", {
      "node-new": {
        nodeId: "node-new",
        token: "tok-new",
        createdAtMs: 1700000001000,
        approvedAtMs: 1700000002000,
      },
    });

    const results = migratePhase5aToSqlite(makeEnv(stateDir));
    const r = results.find((r) => r.store === "node-pairing");
    expect(r?.migrated).toBe(false);
    expect(getPairedNodesFromDb()[0].nodeId).toBe("node-abc");
    expect(fs.existsSync(path.join(stateDir, "nodes", "paired.json"))).toBe(false);
  });

  it("skips missing node pairing files without error", () => {
    const stateDir = makeStateDir();
    const results = migratePhase5aToSqlite(makeEnv(stateDir));
    const r = results.find((r) => r.store === "node-pairing");
    expect(r?.migrated).toBe(false);
    expect(r?.error).toBeUndefined();
  });

  it("returns all non-migrated results when no files exist", () => {
    const stateDir = makeStateDir();
    const results = migratePhase5aToSqlite(makeEnv(stateDir));
    expect(results.every((r) => !r.migrated && !r.error)).toBe(true);
  });
});
