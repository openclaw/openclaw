import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { warnMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", () => {
  const makeLogger = () => ({
    subsystem: "sessions/store",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => makeLogger(),
  });
  return { createSubsystemLogger: () => makeLogger() };
});

import type { SessionEntry } from "../sessions.js";

const LARGE_STORE_LIMIT_BYTES = 1_000_000;

function createSmallSessionStore(): Record<string, SessionEntry> {
  return {
    "session:1": {
      sessionId: "id-1",
      updatedAt: Date.now(),
      displayName: "Small Session",
    },
  };
}

function createLargeSessionStore(): Record<string, SessionEntry> {
  const repeated = "x".repeat(4096);
  const now = Date.now();
  const store: Record<string, SessionEntry> = {};
  for (let i = 0; i < 320; i += 1) {
    store[`session:${String(i)}`] = {
      sessionId: `id-${String(i)}`,
      updatedAt: now + i,
      displayName: `Large Session ${String(i)} ${repeated}`,
    };
  }
  return store;
}

describe("session object cache limit warning", () => {
  let clearSessionStoreCacheForTest: typeof import("../sessions.js").clearSessionStoreCacheForTest;
  let loadSessionStore: typeof import("../sessions.js").loadSessionStore;
  let saveSessionStore: typeof import("../sessions.js").saveSessionStore;
  let fixtureRoot = "";
  let caseId = 0;
  let testDir = "";
  let storePath = "";

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-cache-limit-warning-test-"));
  });

  afterAll(() => {
    if (fixtureRoot) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    vi.resetModules();
    ({ clearSessionStoreCacheForTest, loadSessionStore, saveSessionStore } =
      await import("../sessions.js"));
    warnMock.mockClear();
    testDir = path.join(fixtureRoot, `case-${caseId++}`);
    fs.mkdirSync(testDir, { recursive: true });
    storePath = path.join(testDir, "sessions.json");
    clearSessionStoreCacheForTest();
    delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    delete process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES;
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    delete process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES;
  });

  it("logs a warning the first time a store exceeds the object cache limit", async () => {
    await saveSessionStore(storePath, createLargeSessionStore());

    expect(fs.statSync(storePath).size).toBeGreaterThan(LARGE_STORE_LIMIT_BYTES);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      "session object cache disabled for large store",
      expect.objectContaining({
        envVar: "OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES",
        limitBytes: LARGE_STORE_LIMIT_BYTES,
        sizeBytes: expect.any(Number),
        storePath,
      }),
    );
  });

  it("does not spam warnings for repeated oversized accesses to the same store", async () => {
    await saveSessionStore(storePath, createLargeSessionStore());
    loadSessionStore(storePath);
    loadSessionStore(storePath);

    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it("does not warn for small stores", async () => {
    await saveSessionStore(storePath, createSmallSessionStore());
    loadSessionStore(storePath);

    expect(warnMock).not.toHaveBeenCalled();
  });
});
