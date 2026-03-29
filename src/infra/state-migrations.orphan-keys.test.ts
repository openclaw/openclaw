import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { migrateOrphanedSessionKeys } from "./state-migrations.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orphan-keys-test-"));
}

function writeStore(storePath: string, store: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store));
}

function readStore(storePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(storePath, "utf-8"));
}

describe("migrateOrphanedSessionKeys", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stateDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renames orphaned raw key to canonical form", async () => {
    const storePath = path.join(stateDir, "agents", "ops", "sessions", "sessions.json");
    writeStore(storePath, {
      "agent:main:main": { sessionId: "abc-123", updatedAt: 1000 },
    });

    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;

    const result = await migrateOrphanedSessionKeys({
      cfg,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(result.changes.length).toBeGreaterThan(0);
    const store = readStore(storePath);
    expect(store["agent:ops:work"]).toBeDefined();
    expect((store["agent:ops:work"] as { sessionId: string }).sessionId).toBe("abc-123");
    expect(store["agent:main:main"]).toBeUndefined();
  });

  it("keeps most recently updated entry when both orphan and canonical exist", async () => {
    const storePath = path.join(stateDir, "agents", "ops", "sessions", "sessions.json");
    writeStore(storePath, {
      "agent:main:main": { sessionId: "old-orphan", updatedAt: 500 },
      "agent:ops:work": { sessionId: "current", updatedAt: 2000 },
    });

    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;

    await migrateOrphanedSessionKeys({
      cfg,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    const store = readStore(storePath);
    expect((store["agent:ops:work"] as { sessionId: string }).sessionId).toBe("current");
    expect(store["agent:main:main"]).toBeUndefined();
  });

  it("skips stores that are already fully canonical", async () => {
    const storePath = path.join(stateDir, "agents", "ops", "sessions", "sessions.json");
    writeStore(storePath, {
      "agent:ops:work": { sessionId: "abc-123", updatedAt: 1000 },
    });

    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;

    const result = await migrateOrphanedSessionKeys({
      cfg,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(result.changes).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("handles missing store files gracefully", async () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;

    const result = await migrateOrphanedSessionKeys({
      cfg,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(result.changes).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("is idempotent — running twice produces same result", async () => {
    const storePath = path.join(stateDir, "agents", "ops", "sessions", "sessions.json");
    writeStore(storePath, {
      "agent:main:main": { sessionId: "abc-123", updatedAt: 1000 },
    });

    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;

    const env = { OPENCLAW_STATE_DIR: stateDir };
    await migrateOrphanedSessionKeys({ cfg, env });
    const result2 = await migrateOrphanedSessionKeys({ cfg, env });

    expect(result2.changes).toHaveLength(0);
    const store = readStore(storePath);
    expect((store["agent:ops:work"] as { sessionId: string }).sessionId).toBe("abc-123");
  });

  it("preserves legitimate agent:main:* keys in shared stores with both main and non-main agents", async () => {
    // When session.store lacks {agentId}, all agents resolve to the same file.
    // The "main" agent's keys must not be remapped into the "ops" namespace.
    const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
    writeStore(sharedStorePath, {
      "agent:main:main": { sessionId: "main-session", updatedAt: 2000 },
      "agent:ops:work": { sessionId: "ops-session", updatedAt: 1000 },
    });

    const cfg = {
      session: { mainKey: "work", store: sharedStorePath },
      agents: { list: [{ id: "main" }, { id: "ops", default: true }] },
    } as OpenClawConfig;

    await migrateOrphanedSessionKeys({
      cfg,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    const store = readStore(sharedStorePath);
    // main agent's session is canonicalised to use configured mainKey ("work"),
    // but stays in the "main" agent namespace — NOT remapped into "ops".
    expect(store["agent:main:work"]).toBeDefined();
    expect((store["agent:main:work"] as { sessionId: string }).sessionId).toBe("main-session");
    expect(store["agent:ops:work"]).toBeDefined();
    expect((store["agent:ops:work"] as { sessionId: string }).sessionId).toBe("ops-session");
    // The key must NOT have been merged into ops namespace
    expect(Object.keys(store).filter((k) => k.startsWith("agent:ops:")).length).toBe(1);
  });

  it("no-ops when default agentId is main and mainKey is main", async () => {
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    writeStore(storePath, {
      "agent:main:main": { sessionId: "abc-123", updatedAt: 1000 },
    });

    const cfg = {} as OpenClawConfig;

    const result = await migrateOrphanedSessionKeys({
      cfg,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(result.changes).toHaveLength(0);
    const store = readStore(storePath);
    expect(store["agent:main:main"]).toBeDefined();
  });
});
