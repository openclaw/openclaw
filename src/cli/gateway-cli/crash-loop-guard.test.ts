import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyCrashLoopGuard,
  clearGatewayCrashHistory,
  CrashLoopError,
  recordGatewayCrash,
  _TEST_ONLY,
} from "./crash-loop-guard.js";

const { CRASH_WINDOW_MS, BACKOFF_THRESHOLD, MAX_CRASHES } = _TEST_ONLY;

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crash-guard-"));
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("crash-loop-guard", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      rmDir(d);
    }
    dirs.length = 0;
  });

  function tempDir(): string {
    const d = makeTempDir();
    dirs.push(d);
    return d;
  }

  describe("recordGatewayCrash / clearGatewayCrashHistory", () => {
    it("records crash timestamps and clears them", () => {
      const dir = tempDir();
      recordGatewayCrash(dir, 1000);
      recordGatewayCrash(dir, 2000);

      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, "gateway-crash-history.json"), "utf-8"),
      );
      expect(raw.crashes).toEqual([1000, 2000]);

      clearGatewayCrashHistory(dir);
      const cleared = JSON.parse(
        fs.readFileSync(path.join(dir, "gateway-crash-history.json"), "utf-8"),
      );
      expect(cleared.crashes).toEqual([]);
    });

    it("prunes timestamps outside the window", () => {
      const dir = tempDir();
      const now = Date.now();
      const old = now - CRASH_WINDOW_MS - 1000;
      recordGatewayCrash(dir, old);
      recordGatewayCrash(dir, now);

      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, "gateway-crash-history.json"), "utf-8"),
      );
      expect(raw.crashes).toEqual([now]);
    });
  });

  describe("applyCrashLoopGuard", () => {
    it("does nothing when crash history is empty", async () => {
      const dir = tempDir();
      const sleep = vi.fn(async () => {});
      await applyCrashLoopGuard({
        stateDir: dir,
        sleep,
        logger: { warn: vi.fn(), error: vi.fn() },
      });
      expect(sleep).not.toHaveBeenCalled();
    });

    it("does nothing for fewer than BACKOFF_THRESHOLD crashes", async () => {
      const dir = tempDir();
      const now = Date.now();
      for (let i = 0; i < BACKOFF_THRESHOLD - 1; i++) {
        recordGatewayCrash(dir, now - i * 1000);
      }

      const sleep = vi.fn(async () => {});
      await applyCrashLoopGuard({
        stateDir: dir,
        now: () => now,
        sleep,
        logger: { warn: vi.fn(), error: vi.fn() },
      });
      expect(sleep).not.toHaveBeenCalled();
    });

    it("applies 30s backoff for 4-6 crashes", async () => {
      const dir = tempDir();
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        recordGatewayCrash(dir, now - i * 1000);
      }

      const sleep = vi.fn(async () => {});
      const warn = vi.fn();
      await applyCrashLoopGuard({
        stateDir: dir,
        now: () => now,
        sleep,
        logger: { warn, error: vi.fn() },
      });
      expect(sleep).toHaveBeenCalledWith(30_000);
      expect(warn).toHaveBeenCalled();
    });

    it("applies 5-min backoff for 7+ crashes", async () => {
      const dir = tempDir();
      const now = Date.now();
      for (let i = 0; i < 8; i++) {
        recordGatewayCrash(dir, now - i * 1000);
      }

      const sleep = vi.fn(async () => {});
      await applyCrashLoopGuard({
        stateDir: dir,
        now: () => now,
        sleep,
        logger: { warn: vi.fn(), error: vi.fn() },
      });
      expect(sleep).toHaveBeenCalledWith(5 * 60 * 1000);
    });

    it("throws CrashLoopError after MAX_CRASHES", async () => {
      const dir = tempDir();
      const now = Date.now();
      for (let i = 0; i < MAX_CRASHES; i++) {
        recordGatewayCrash(dir, now - i * 1000);
      }

      await expect(
        applyCrashLoopGuard({
          stateDir: dir,
          now: () => now,
          sleep: vi.fn(async () => {}),
          logger: { warn: vi.fn(), error: vi.fn() },
        }),
      ).rejects.toThrow(CrashLoopError);
    });

    it("ignores corrupt history file gracefully", async () => {
      const dir = tempDir();
      fs.writeFileSync(path.join(dir, "gateway-crash-history.json"), "NOT JSON", "utf-8");

      const sleep = vi.fn(async () => {});
      await applyCrashLoopGuard({
        stateDir: dir,
        sleep,
        logger: { warn: vi.fn(), error: vi.fn() },
      });
      expect(sleep).not.toHaveBeenCalled();
    });
  });
});
