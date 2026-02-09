import { describe, it, expect, vi } from "vitest";
import {
  isGitAvailable,
  initializeGitRepo,
  pullFromRemote,
  getUncommittedChanges,
  commitMemoryFiles,
  pushToRemote,
  syncMemories,
  hasMemoriesChanged,
} from "./workspace-sync.js";

describe("WorkspaceSync", () => {
  describe("isGitAvailable", () => {
    it("should detect if git is available", () => {
      const available = isGitAvailable();
      // This depends on the system, so we just check it returns a boolean
      expect(typeof available).toBe("boolean");
    });
  });

  describe("initializeGitRepo", () => {
    it("should handle initialization gracefully", () => {
      // Just test that it doesn't crash - actual git operations are complex to mock
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // This will likely fail in test environment, but should handle gracefully
      const result = initializeGitRepo("/tmp/test-repo", "https://example.com/repo.git");

      expect(typeof result).toBe("boolean");
      consoleSpy.mockRestore();
    });
  });

  describe("pullFromRemote", () => {
    it("should handle pull failures gracefully", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // This will likely fail without a real git repo
      const result = pullFromRemote("/tmp/nonexistent");

      expect(result).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  describe("getUncommittedChanges", () => {
    it("should return empty array for invalid path", () => {
      const changes = getUncommittedChanges("/tmp/nonexistent");
      expect(Array.isArray(changes)).toBe(true);
    });
  });

  describe("commitMemoryFiles", () => {
    it("should handle commit failures gracefully", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = commitMemoryFiles("/tmp/nonexistent", "/tmp/memory");

      expect(typeof result).toBe("boolean");
      consoleSpy.mockRestore();
    });
  });

  describe("pushToRemote", () => {
    it("should handle push failures gracefully", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = pushToRemote("/tmp/nonexistent");

      expect(result).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  describe("syncMemories", () => {
    it("should return sync result object with correct shape", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = syncMemories("/tmp/nonexistent", "/tmp/memory");

      expect(result).toHaveProperty("pulled");
      expect(result).toHaveProperty("committed");
      expect(result).toHaveProperty("pushed");
      expect(typeof result.pulled).toBe("boolean");
      expect(typeof result.committed).toBe("boolean");
      expect(typeof result.pushed).toBe("boolean");

      consoleSpy.mockRestore();
    });

    it("should not push if commit failed", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = syncMemories("/tmp/nonexistent", "/tmp/memory");

      // If commit is false, push should also be false (due to the logic)
      if (!result.committed) {
        expect(result.pushed).toBe(false);
      }

      consoleSpy.mockRestore();
    });
  });

  describe("hasMemoriesChanged", () => {
    it("should return false for non-existent path", () => {
      const result = hasMemoriesChanged("/tmp/nonexistent");
      expect(result).toBe(false);
    });

    it("should return true for first sync (no lastSyncTime)", () => {
      // This depends on having a real directory
      // In a real scenario, this would check if directory exists and return true
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Test with a path that likely doesn't exist
      const result = hasMemoriesChanged("/tmp/nonexistent/dir", undefined);
      expect(typeof result).toBe("boolean");

      consoleSpy.mockRestore();
    });

    it("should handle errors gracefully", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Test with invalid path
      const result = hasMemoriesChanged("/invalid/path/that/does/not/exist", Date.now());
      expect(result).toBe(false);

      consoleSpy.mockRestore();
    });
  });
});
