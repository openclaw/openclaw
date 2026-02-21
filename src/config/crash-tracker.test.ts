import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readCrashTrackerState,
  writeCrashTrackerState,
  recordStartupAndCheckCrashLoop,
  saveLastKnownGood,
  hasLastKnownGood,
  revertToLastKnownGood,
  clearCrashTracker,
  getLastKnownGoodPath,
  getFailedConfigPath,
} from "./crash-tracker.js";

describe("crash-tracker", () => {
  let tmpDir: string;
  let stateDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-tracker-test-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    configPath = path.join(tmpDir, "openclaw.json");
    fs.writeFileSync(configPath, '{"valid": true}');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("readCrashTrackerState", () => {
    it("returns empty state when file does not exist", () => {
      const state = readCrashTrackerState(stateDir);
      expect(state.startupTimestamps).toEqual([]);
    });

    it("reads existing state", () => {
      const expected = { startupTimestamps: [1000, 2000, 3000] };
      writeCrashTrackerState(stateDir, expected);
      const state = readCrashTrackerState(stateDir);
      expect(state.startupTimestamps).toEqual([1000, 2000, 3000]);
    });

    it("handles corrupted state file", () => {
      fs.writeFileSync(path.join(stateDir, "crash-tracker.json"), "not json");
      const state = readCrashTrackerState(stateDir);
      expect(state.startupTimestamps).toEqual([]);
    });
  });

  describe("recordStartupAndCheckCrashLoop", () => {
    it("returns false for first startup", () => {
      const isCrashLoop = recordStartupAndCheckCrashLoop(stateDir);
      expect(isCrashLoop).toBe(false);
    });

    it("returns false for 2 startups", () => {
      recordStartupAndCheckCrashLoop(stateDir);
      const isCrashLoop = recordStartupAndCheckCrashLoop(stateDir);
      expect(isCrashLoop).toBe(false);
    });

    it("returns true after 3 startups within window", () => {
      recordStartupAndCheckCrashLoop(stateDir);
      recordStartupAndCheckCrashLoop(stateDir);
      const isCrashLoop = recordStartupAndCheckCrashLoop(stateDir);
      expect(isCrashLoop).toBe(true);
    });

    it("respects custom maxCrashes", () => {
      recordStartupAndCheckCrashLoop(stateDir, { maxCrashes: 5 });
      recordStartupAndCheckCrashLoop(stateDir, { maxCrashes: 5 });
      recordStartupAndCheckCrashLoop(stateDir, { maxCrashes: 5 });
      const isCrashLoop = recordStartupAndCheckCrashLoop(stateDir, { maxCrashes: 5 });
      expect(isCrashLoop).toBe(false);
    });

    it("ignores old timestamps outside window", () => {
      // Manually write old timestamps
      const oldTime = Date.now() - 120_000; // 2 minutes ago
      writeCrashTrackerState(stateDir, {
        startupTimestamps: [oldTime, oldTime + 1000],
      });
      const isCrashLoop = recordStartupAndCheckCrashLoop(stateDir);
      expect(isCrashLoop).toBe(false);
    });
  });

  describe("saveLastKnownGood", () => {
    it("copies config to .last-known-good", () => {
      const result = saveLastKnownGood(configPath);
      expect(result).toBe(true);
      const lkgContent = fs.readFileSync(getLastKnownGoodPath(configPath), "utf-8");
      expect(lkgContent).toBe('{"valid": true}');
    });

    it("returns false if config does not exist", () => {
      const result = saveLastKnownGood(path.join(tmpDir, "nonexistent.json"));
      expect(result).toBe(false);
    });
  });

  describe("hasLastKnownGood", () => {
    it("returns false when no LKG exists", () => {
      expect(hasLastKnownGood(configPath)).toBe(false);
    });

    it("returns true after saving LKG", () => {
      saveLastKnownGood(configPath);
      expect(hasLastKnownGood(configPath)).toBe(true);
    });
  });

  describe("revertToLastKnownGood", () => {
    it("reverts config to last-known-good", () => {
      // Save good config as LKG
      saveLastKnownGood(configPath);

      // Write bad config
      fs.writeFileSync(configPath, '{"bad": true}');

      // Revert
      const result = revertToLastKnownGood(configPath, stateDir);
      expect(result).toBe(true);

      // Config should be restored
      const content = fs.readFileSync(configPath, "utf-8");
      expect(content).toBe('{"valid": true}');
    });

    it("saves failed config for debugging", () => {
      saveLastKnownGood(configPath);
      fs.writeFileSync(configPath, '{"bad": true}');

      revertToLastKnownGood(configPath, stateDir);

      // Find the failed config file
      const files = fs.readdirSync(tmpDir).filter((f) => f.includes(".failed-"));
      expect(files.length).toBe(1);
      const failedContent = fs.readFileSync(path.join(tmpDir, files[0]!), "utf-8");
      expect(failedContent).toBe('{"bad": true}');
    });

    it("resets crash tracker after revert", () => {
      saveLastKnownGood(configPath);
      recordStartupAndCheckCrashLoop(stateDir);
      recordStartupAndCheckCrashLoop(stateDir);

      revertToLastKnownGood(configPath, stateDir);

      const state = readCrashTrackerState(stateDir);
      expect(state.startupTimestamps).toEqual([]);
      expect(state.lastRevertTimestamp).toBeGreaterThan(0);
    });

    it("returns false when no LKG exists", () => {
      const result = revertToLastKnownGood(configPath, stateDir);
      expect(result).toBe(false);
    });
  });

  describe("clearCrashTracker", () => {
    it("clears startup timestamps", () => {
      recordStartupAndCheckCrashLoop(stateDir);
      recordStartupAndCheckCrashLoop(stateDir);
      clearCrashTracker(stateDir);
      const state = readCrashTrackerState(stateDir);
      expect(state.startupTimestamps).toEqual([]);
    });
  });
});
