import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetCoreSettingsDbForTest,
  setCoreSettingsDbForTest,
} from "../infra/state-db/core-settings-sqlite.js";
import { runMigrations } from "../infra/state-db/schema.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { ensureNodeHostConfig, loadNodeHostConfig, saveNodeHostConfig } from "./config.js";

describe("node-host config (SQLite)", () => {
  let db: ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];

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
  });

  it("returns null when no config saved", async () => {
    expect(await loadNodeHostConfig()).toBeNull();
  });

  it("saves and loads a config", async () => {
    await saveNodeHostConfig({
      version: 1,
      nodeId: "node-abc",
      token: "tok-123",
      displayName: "My Node",
    });
    const config = await loadNodeHostConfig();
    expect(config?.nodeId).toBe("node-abc");
    expect(config?.token).toBe("tok-123");
    expect(config?.displayName).toBe("My Node");
  });

  it("saves and loads gateway config", async () => {
    await saveNodeHostConfig({
      version: 1,
      nodeId: "node-abc",
      gateway: { host: "gateway.example.com", port: 8443, tls: true, tlsFingerprint: "fp-abc" },
    });
    const config = await loadNodeHostConfig();
    expect(config?.gateway?.host).toBe("gateway.example.com");
    expect(config?.gateway?.port).toBe(8443);
    expect(config?.gateway?.tls).toBe(true);
    expect(config?.gateway?.tlsFingerprint).toBe("fp-abc");
  });

  it("overwrites config on save", async () => {
    await saveNodeHostConfig({ version: 1, nodeId: "node-1", token: "tok-old" });
    await saveNodeHostConfig({ version: 1, nodeId: "node-1", token: "tok-new" });
    const config = await loadNodeHostConfig();
    expect(config?.token).toBe("tok-new");
  });

  it("ensureNodeHostConfig creates config with random nodeId when empty", async () => {
    const config = await ensureNodeHostConfig();
    expect(config.version).toBe(1);
    expect(config.nodeId).toBeTruthy();
    expect(config.nodeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Persisted to DB
    const loaded = await loadNodeHostConfig();
    expect(loaded?.nodeId).toBe(config.nodeId);
  });

  it("ensureNodeHostConfig preserves existing nodeId", async () => {
    await saveNodeHostConfig({ version: 1, nodeId: "node-existing", token: "tok-1" });
    const config = await ensureNodeHostConfig();
    expect(config.nodeId).toBe("node-existing");
    expect(config.token).toBe("tok-1");
  });

  it("normalizes empty nodeId to a random UUID", async () => {
    await saveNodeHostConfig({ version: 1, nodeId: "", token: "tok-1" });
    const config = await loadNodeHostConfig();
    expect(config?.nodeId).toBeTruthy();
    expect(config?.nodeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("normalizes whitespace-only nodeId to a random UUID", async () => {
    await saveNodeHostConfig({ version: 1, nodeId: "   ", token: "tok-1" });
    const config = await loadNodeHostConfig();
    expect(config?.nodeId).toBeTruthy();
    // Should be a UUID, not whitespace
    expect(config?.nodeId.trim()).toBe(config?.nodeId);
    expect(config?.nodeId.length).toBeGreaterThan(10);
  });
});
