import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTabManager,
  DEFAULT_CONFIG,
  formatRecoveryResult,
  TabManager,
  type RecoveryResult,
  type TabRecoveryConfig,
  type TrackedTab,
} from "./tab-manager.js";
import type { BrowserTab } from "./client.js";

describe("tab-manager", () => {
  const mockTab1: BrowserTab = {
    targetId: "tab1",
    url: "https://github.com/openclaw/openclaw",
    title: "OpenClaw GitHub",
    type: "page",
  };

  const mockTab2: BrowserTab = {
    targetId: "tab2",
    url: "https://github.com/openclaw/openclaw/issues",
    title: "Issues",
    type: "page",
  };

  const mockTab3: BrowserTab = {
    targetId: "tab3",
    url: "https://google.com/search?q=test",
    title: "Google Search",
    type: "page",
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("TabManager", () => {
    it("should create with default config", () => {
      const manager = new TabManager("test-profile");
      
      expect(manager.size()).toBe(0);
      expect(manager.getConfig().enabled).toBe(true);
      expect(manager.getConfig().maxTabs).toBe(50);
    });

    it("should create with custom config", () => {
      const config: Partial<TabRecoveryConfig> = {
        maxTabs: 10,
        ttlMs: 60000,
      };
      
      const manager = new TabManager("test-profile", config);
      
      expect(manager.getConfig().maxTabs).toBe(10);
      expect(manager.getConfig().ttlMs).toBe(60000);
    });

    it("should track a tab", () => {
      const manager = new TabManager("test-profile");
      
      manager.track(mockTab1);
      
      expect(manager.size()).toBe(1);
      expect(manager.has("tab1")).toBe(true);
      
      const tracked = manager.get("tab1");
      expect(tracked).toBeDefined();
      expect(tracked?.targetId).toBe("tab1");
      expect(tracked?.url).toBe(mockTab1.url);
    });

    it("should track multiple tabs", () => {
      const manager = new TabManager("test-profile");
      
      manager.trackMany([mockTab1, mockTab2, mockTab3]);
      
      expect(manager.size()).toBe(3);
      expect(manager.has("tab1")).toBe(true);
      expect(manager.has("tab2")).toBe(true);
      expect(manager.has("tab3")).toBe(true);
    });

    it("should update existing tab when tracked again", () => {
      const manager = new TabManager("test-profile");
      
      manager.track(mockTab1);
      const firstSeen = manager.get("tab1")?.lastSeen;
      
      vi.advanceTimersByTime(1000);
      
      manager.track(mockTab1);
      const secondSeen = manager.get("tab1")?.lastSeen;
      
      expect(secondSeen).toBeGreaterThan(firstSeen!);
    });

    it("should touch a tab to update lastSeen", () => {
      const manager = new TabManager("test-profile");
      
      manager.track(mockTab1);
      const firstSeen = manager.get("tab1")?.lastSeen;
      
      vi.advanceTimersByTime(1000);
      
      manager.touch("tab1");
      const secondSeen = manager.get("tab1")?.lastSeen;
      
      expect(secondSeen).toBeGreaterThan(firstSeen!);
    });

    it("should untrack a tab", () => {
      const manager = new TabManager("test-profile");
      
      manager.track(mockTab1);
      expect(manager.has("tab1")).toBe(true);
      
      manager.untrack("tab1");
      expect(manager.has("tab1")).toBe(false);
      expect(manager.size()).toBe(0);
    });

    it("should get all tracked tabs", () => {
      const manager = new TabManager("test-profile");
      
      manager.trackMany([mockTab1, mockTab2]);
      
      const all = manager.getAll();
      expect(all).toHaveLength(2);
      expect(all.some((t) => t.targetId === "tab1")).toBe(true);
      expect(all.some((t) => t.targetId === "tab2")).toBe(true);
    });

    it("should not track when disabled", () => {
      const manager = new TabManager("test-profile", { enabled: false });
      
      manager.track(mockTab1);
      
      expect(manager.size()).toBe(0);
    });

    it("should prune oldest tab when maxTabs exceeded", () => {
      const manager = new TabManager("test-profile", { maxTabs: 2 });
      
      manager.track(mockTab1);
      vi.advanceTimersByTime(100);
      
      manager.track(mockTab2);
      vi.advanceTimersByTime(100);
      
      // This should prune tab1 (oldest)
      manager.track(mockTab3);
      
      expect(manager.size()).toBe(2);
      expect(manager.has("tab1")).toBe(false); // Pruned
      expect(manager.has("tab2")).toBe(true);
      expect(manager.has("tab3")).toBe(true);
    });

    it("should prune stale tabs based on TTL", () => {
      const manager = new TabManager("test-profile", {
        ttlMs: 60000, // 1 minute
      });
      
      manager.track(mockTab1);
      manager.track(mockTab2);
      
      // Advance time past TTL for tab1
      vi.advanceTimersByTime(70000);
      
      // Touch tab2 to keep it fresh
      manager.touch("tab2");
      
      const pruned = manager.pruneStale();
      
      expect(pruned).toBe(1);
      expect(manager.has("tab1")).toBe(false); // Pruned
      expect(manager.has("tab2")).toBe(true); // Still fresh
    });

    it("should recover tab by exact URL", async () => {
      const manager = new TabManager("test-profile");
      
      // Track original tab
      manager.track(mockTab1);
      
      // Simulate tab getting new ID (browser restart, etc.)
      const newTab: BrowserTab = {
        targetId: "tab1-new",
        url: mockTab1.url, // Same URL
        title: mockTab1.title,
        type: "page",
      };
      
      const result = await manager.recover("tab1", [newTab]);
      
      expect(result.recovered).toBe(true);
      expect(result.newTargetId).toBe("tab1-new");
      expect(result.reason).toContain("exact URL");
      
      // Registry should be updated
      expect(manager.has("tab1")).toBe(false);
      expect(manager.has("tab1-new")).toBe(true);
    });

    it("should recover tab by normalized URL", async () => {
      const manager = new TabManager("test-profile");
      
      // Track tab with query params
      manager.track(mockTab3);
      
      // New tab without query params
      const newTab: BrowserTab = {
        targetId: "tab3-new",
        url: "https://google.com/search", // No query params
        title: "Google",
        type: "page",
      };
      
      const result = await manager.recover("tab3", [newTab]);
      
      expect(result.recovered).toBe(true);
      expect(result.newTargetId).toBe("tab3-new");
      expect(result.reason).toContain("normalized URL");
    });

    it("should fail to recover if tab not in registry", async () => {
      const manager = new TabManager("test-profile");
      
      const result = await manager.recover("unknown-tab", [mockTab1]);
      
      expect(result.recovered).toBe(false);
      expect(result.reason).toContain("not in registry");
    });

    it("should fail to recover if no matching tab found", async () => {
      const manager = new TabManager("test-profile");
      
      manager.track(mockTab1);
      
      // Try to recover with completely different tabs
      const result = await manager.recover("tab1", [mockTab2, mockTab3]);
      
      expect(result.recovered).toBe(false);
      expect(result.reason).toContain("No matching tab");
    });

    it("should not recover when disabled", async () => {
      const manager = new TabManager("test-profile", { enabled: false });
      
      const result = await manager.recover("tab1", [mockTab1]);
      
      expect(result.recovered).toBe(false);
      expect(result.reason).toContain("disabled");
    });

    it("should clear all tabs", () => {
      const manager = new TabManager("test-profile");
      
      manager.trackMany([mockTab1, mockTab2, mockTab3]);
      expect(manager.size()).toBe(3);
      
      manager.clear();
      expect(manager.size()).toBe(0);
    });

    it("should update configuration", () => {
      const manager = new TabManager("test-profile");
      
      manager.updateConfig({ maxTabs: 10 });
      
      expect(manager.getConfig().maxTabs).toBe(10);
    });

    it("should handle tabs with hash fragments", async () => {
      const manager = new TabManager("test-profile");
      
      const tabWithHash: BrowserTab = {
        targetId: "tab-hash",
        url: "https://github.com/openclaw#readme",
        title: "GitHub",
        type: "page",
      };
      
      manager.track(tabWithHash);
      
      // New tab without hash
      const newTab: BrowserTab = {
        targetId: "tab-new",
        url: "https://github.com/openclaw",
        title: "GitHub",
        type: "page",
      };
      
      const result = await manager.recover("tab-hash", [newTab]);
      
      expect(result.recovered).toBe(true);
      expect(result.newTargetId).toBe("tab-new");
    });

    it("should not prune stale tabs if none are stale", () => {
      const manager = new TabManager("test-profile", {
        ttlMs: 60000,
      });
      
      manager.trackMany([mockTab1, mockTab2]);
      
      // Advance time but not past TTL
      vi.advanceTimersByTime(30000);
      
      const pruned = manager.pruneStale();
      
      expect(pruned).toBe(0);
      expect(manager.size()).toBe(2);
    });
  });

  describe("createTabManager", () => {
    it("should create a tab manager instance", () => {
      const manager = createTabManager("test-profile");
      
      expect(manager).toBeInstanceOf(TabManager);
      expect(manager.size()).toBe(0);
    });

    it("should accept custom configuration", () => {
      const config: Partial<TabRecoveryConfig> = {
        maxTabs: 20,
      };
      
      const manager = createTabManager("test-profile", config);
      
      expect(manager.getConfig().maxTabs).toBe(20);
    });
  });

  describe("formatRecoveryResult", () => {
    it("should format successful recovery", () => {
      const result: RecoveryResult = {
        recovered: true,
        newTargetId: "new-tab-id",
        reason: "Found by exact URL",
      };
      
      const formatted = formatRecoveryResult("old-tab-id", result);
      
      expect(formatted).toContain("old-tab-id");
      expect(formatted).toContain("new-tab-id");
      expect(formatted).toContain("Found by exact URL");
    });

    it("should format failed recovery", () => {
      const result: RecoveryResult = {
        recovered: false,
        reason: "No matching tab found",
      };
      
      const formatted = formatRecoveryResult("lost-tab-id", result);
      
      expect(formatted).toContain("failed");
      expect(formatted).toContain("lost-tab-id");
      expect(formatted).toContain("No matching tab");
    });
  });
});
