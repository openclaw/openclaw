import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "./types.js";
import { clearSessionStoreCacheForTest, loadSessionStore, saveSessionStore } from "./store.js";

// Keep integration tests deterministic: never read a real openclaw.json.
vi.mock("../config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

let fixtureRoot = "";
let fixtureCount = 0;

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

async function createCaseDir(prefix: string): Promise<string> {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("Integration: saveSessionStore with pruning", () => {
  let testDir: string;
  let storePath: string;
  let savedCacheTtl: string | undefined;
  let mockLoadConfig: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pruning-integ-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    testDir = await createCaseDir("pruning-integ");
    storePath = path.join(testDir, "sessions.json");
    savedCacheTtl = process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    process.env.OPENCLAW_SESSION_CACHE_TTL_MS = "0";
    clearSessionStoreCacheForTest();

    const configModule = await import("../config.js");
    mockLoadConfig = configModule.loadConfig as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearSessionStoreCacheForTest();
    if (savedCacheTtl === undefined) {
      delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    } else {
      process.env.OPENCLAW_SESSION_CACHE_TTL_MS = savedCacheTtl;
    }
  });

  it("saveSessionStore prunes stale entries on write", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "7d",
          maxEntries: 500,
          rotateBytes: 10_485_760,
        },
      },
    });

    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      stale: makeEntry(now - 30 * DAY_MS),
      fresh: makeEntry(now),
    };

    await saveSessionStore(storePath, store);

    const loaded = loadSessionStore(storePath);
    expect(loaded.stale).toBeUndefined();
    expect(loaded.fresh).toBeDefined();
  });

  it("saveSessionStore caps entries over limit", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "30d",
          maxEntries: 5,
          rotateBytes: 10_485_760,
        },
      },
    });

    const now = Date.now();
    const store: Record<string, SessionEntry> = {};
    for (let i = 0; i < 10; i++) {
      store[`key-${i}`] = makeEntry(now - i * 1000);
    }

    await saveSessionStore(storePath, store);

    const loaded = loadSessionStore(storePath);
    expect(Object.keys(loaded)).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(loaded[`key-${i}`]).toBeDefined();
    }
    for (let i = 5; i < 10; i++) {
      expect(loaded[`key-${i}`]).toBeUndefined();
    }
  });

  it("saveSessionStore rotates file when over size limit and creates .bak", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "30d",
          maxEntries: 500,
          rotateBytes: "100b",
        },
      },
    });

    const now = Date.now();
    const largeStore: Record<string, SessionEntry> = {};
    for (let i = 0; i < 50; i++) {
      largeStore[`agent:main:session-${crypto.randomUUID()}`] = makeEntry(now - i * 1000);
    }
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(largeStore, null, 2), "utf-8");

    const statBefore = await fs.stat(storePath);
    expect(statBefore.size).toBeGreaterThan(100);

    const smallStore: Record<string, SessionEntry> = {
      only: makeEntry(now),
    };
    await saveSessionStore(storePath, smallStore);

    const files = await fs.readdir(testDir);
    const bakFiles = files.filter((f) => f.startsWith("sessions.json.bak."));
    expect(bakFiles.length).toBeGreaterThanOrEqual(1);

    const loaded = loadSessionStore(storePath);
    expect(loaded.only).toBeDefined();
  });

  it("saveSessionStore skips enforcement when maintenance mode is warn", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "warn",
          pruneAfter: "7d",
          maxEntries: 1,
          rotateBytes: 10_485_760,
        },
      },
    });

    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      stale: makeEntry(now - 30 * DAY_MS),
      fresh: makeEntry(now),
    };

    await saveSessionStore(storePath, store);

    const loaded = loadSessionStore(storePath);
    expect(loaded.stale).toBeDefined();
    expect(loaded.fresh).toBeDefined();
    expect(Object.keys(loaded)).toHaveLength(2);
  });

  it("resolveMaintenanceConfig reads from loadConfig().session.maintenance", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: { pruneAfter: "7d", maxEntries: 100, rotateBytes: "5mb" },
      },
    });

    const { resolveMaintenanceConfig } = await import("./store.js");
    const config = resolveMaintenanceConfig();

    expect(config).toEqual({
      mode: "warn",
      pruneAfterMs: 7 * DAY_MS,
      maxEntries: 100,
      rotateBytes: 5 * 1024 * 1024,
    });
  });

  it("resolveMaintenanceConfig uses defaults for missing fields", async () => {
    mockLoadConfig.mockReturnValue({ session: { maintenance: { pruneAfter: "14d" } } });

    const { resolveMaintenanceConfig } = await import("./store.js");
    const config = resolveMaintenanceConfig();

    expect(config).toEqual({
      mode: "warn",
      pruneAfterMs: 14 * DAY_MS,
      maxEntries: 500,
      rotateBytes: 10_485_760,
    });
  });

  it("resolveMaintenanceConfig falls back to deprecated pruneDays", async () => {
    mockLoadConfig.mockReturnValue({ session: { maintenance: { pruneDays: 2 } } });

    const { resolveMaintenanceConfig } = await import("./store.js");
    const config = resolveMaintenanceConfig();

    expect(config).toEqual({
      mode: "warn",
      pruneAfterMs: 2 * DAY_MS,
      maxEntries: 500,
      rotateBytes: 10_485_760,
    });
  });
});
