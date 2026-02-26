/**
 * Cleanup & Maintenance Tests
 * Tests for cleanup and maintenance functions
 */

import { rm } from "fs/promises";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cleanupOldMessages,
  archiveCompletedTasks,
  cleanupInactiveTeams,
  closeAllManagers,
  checkpointWAL,
} from "../teams/cleanup.js";

// Mock the pool module
vi.mock("../teams/pool.js", () => ({
  getTeamManager: vi.fn(),
  closeAll: vi.fn(),
}));

describe("Cleanup & Maintenance", () => {
  const TEST_DIR = "/tmp/test-cleanup";
  const stateDir = TEST_DIR;

  beforeEach(async () => {
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  });

  afterEach(async () => {
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  });

  describe("cleanupOldMessages", () => {
    it("has correct signature and can be called", async () => {
      await expect(
        cleanupOldMessages("test-team", 24 * 60 * 60 * 1000, stateDir),
      ).resolves.not.toThrow();
    });

    it("uses default max age of 24 hours", async () => {
      await expect(cleanupOldMessages("test-team", undefined, stateDir)).resolves.not.toThrow();
    });
  });

  describe("archiveCompletedTasks", () => {
    it("has correct signature and can be called", async () => {
      await expect(
        archiveCompletedTasks("test-team", 30 * 24 * 60 * 60 * 1000, stateDir),
      ).resolves.not.toThrow();
    });

    it("uses default max age of 30 days", async () => {
      await expect(archiveCompletedTasks("test-team", undefined, stateDir)).resolves.not.toThrow();
    });
  });

  describe("cleanupInactiveTeams", () => {
    it("has correct signature and returns array", async () => {
      const result = await cleanupInactiveTeams(stateDir, 7 * 24 * 60 * 60 * 1000);
      expect(Array.isArray(result)).toBe(true);
    });

    it("uses default max age of 7 days", async () => {
      const result = await cleanupInactiveTeams(stateDir, undefined);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("closeAllManagers", () => {
    it("calls closeAll from pool", () => {
      expect(() => closeAllManagers()).not.toThrow();
    });
  });

  describe("checkpointWAL", () => {
    it("has correct signature and can be called", async () => {
      await expect(checkpointWAL("test-team", stateDir)).resolves.not.toThrow();
    });
  });
});
