import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  bumpContextLockVersion,
  checkContextLock,
  clearContextLock,
  createContextLock,
  resolveModelSwitchRestore,
} from "./context-lock.js";

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "test-session-id",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("createContextLock", () => {
  it("creates a lock with version 1", () => {
    const entry = makeEntry();
    createContextLock(entry, {
      shopKey: "bigmk",
      browserProfile: "tt-3bigmk",
      activeTabId: "tab-123",
      dateFilter: "2026-02-19",
      pageUrl: "https://seller.tiktok.com/bigmk",
    });
    expect(entry.contextLock).toBeDefined();
    expect(entry.contextLock!.shopKey).toBe("bigmk");
    expect(entry.contextLock!.browserProfile).toBe("tt-3bigmk");
    expect(entry.contextLock!.lockVersion).toBe(1);
    expect(entry.contextLock!.ttlMs).toBe(30 * 60 * 1000);
  });
});

describe("clearContextLock", () => {
  it("removes the lock", () => {
    const entry = makeEntry();
    createContextLock(entry, { shopKey: "bigmk", browserProfile: "tt-3bigmk" });
    expect(entry.contextLock).toBeDefined();
    clearContextLock(entry);
    expect(entry.contextLock).toBeUndefined();
  });

  it("is idempotent on entry without lock", () => {
    const entry = makeEntry();
    clearContextLock(entry);
    expect(entry.contextLock).toBeUndefined();
  });
});

describe("checkContextLock", () => {
  it("returns 'none' when no lock", () => {
    const entry = makeEntry();
    expect(checkContextLock(entry).status).toBe("none");
  });

  it("returns 'active' for a fresh lock", () => {
    const entry = makeEntry();
    createContextLock(entry, { shopKey: "bigmk", browserProfile: "tt-3bigmk" });
    const result = checkContextLock(entry);
    expect(result.status).toBe("active");
    if (result.status === "active") {
      expect(result.lock.shopKey).toBe("bigmk");
    }
  });

  it("returns 'expired' and clears when TTL exceeded", () => {
    const entry = makeEntry();
    createContextLock(entry, { shopKey: "bigmk", browserProfile: "tt-3bigmk" });
    // Simulate 31 minutes ago.
    entry.contextLock!.lockedAt = Date.now() - 31 * 60 * 1000;
    const result = checkContextLock(entry);
    expect(result.status).toBe("expired");
    expect(entry.contextLock).toBeUndefined();
  });

  it("returns 'active' when just under TTL", () => {
    const entry = makeEntry();
    createContextLock(entry, { shopKey: "bigmk", browserProfile: "tt-3bigmk" });
    // 29 minutes ago — still within 30min TTL.
    entry.contextLock!.lockedAt = Date.now() - 29 * 60 * 1000;
    const result = checkContextLock(entry);
    expect(result.status).toBe("active");
  });
});

describe("bumpContextLockVersion", () => {
  it("increments lockVersion", () => {
    const entry = makeEntry();
    createContextLock(entry, { shopKey: "bigmk", browserProfile: "tt-3bigmk" });
    expect(entry.contextLock!.lockVersion).toBe(1);
    bumpContextLockVersion(entry);
    expect(entry.contextLock!.lockVersion).toBe(2);
    bumpContextLockVersion(entry);
    expect(entry.contextLock!.lockVersion).toBe(3);
  });

  it("is a no-op when no lock exists", () => {
    const entry = makeEntry();
    bumpContextLockVersion(entry); // should not throw
    expect(entry.contextLock).toBeUndefined();
  });
});

describe("resolveModelSwitchRestore", () => {
  it("returns 'none' when no lock present", () => {
    const entry = makeEntry();
    const result = resolveModelSwitchRestore(entry);
    expect(result.action).toBe("none");
  });

  it("returns 'restore' when lock is active", () => {
    const entry = makeEntry();
    createContextLock(entry, {
      shopKey: "bigmk",
      browserProfile: "tt-3bigmk",
      pageUrl: "https://seller.tiktok.com",
    });
    const result = resolveModelSwitchRestore(entry);
    expect(result.action).toBe("restore");
    if (result.action === "restore") {
      expect(result.lock.shopKey).toBe("bigmk");
      expect(result.lock.browserProfile).toBe("tt-3bigmk");
    }
  });

  it("returns 'expired' when lock TTL exceeded", () => {
    const entry = makeEntry();
    createContextLock(entry, { shopKey: "bigmk", browserProfile: "tt-3bigmk" });
    entry.contextLock!.lockedAt = Date.now() - 31 * 60 * 1000;
    const result = resolveModelSwitchRestore(entry);
    expect(result.action).toBe("expired");
    expect(entry.contextLock).toBeUndefined();
  });
});
