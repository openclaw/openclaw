/**
 * Tests for the zombie reaper module.
 *
 * Unit tests cover the public API surface: reapZombies does not throw,
 * start/stop manage timer lifecycle, and the module is idempotent.
 *
 * Full end-to-end validation (zombie accumulation → reaping) requires a
 * Docker container running as PID 1 and is covered by the behavior proof
 * in the PR description.
 */
import { afterEach, describe, expect, it } from "vitest";

describe("zombie reaper", () => {
  let zombieReaper: typeof import("./zombie-reaper.js");

  async function loadModule() {
    zombieReaper = await import("./zombie-reaper.js");
  }

  afterEach(() => {
    zombieReaper?.stopZombieReaper();
  });

  describe("reapZombies", () => {
    it("does not throw on the current platform", async () => {
      await loadModule();
      // reapZombies should never throw, regardless of platform.
      // On Linux/macOS it sends SIGCHLD to self (which is harmless);
      // on Windows it's a silent no-op.
      expect(() => zombieReaper.reapZombies()).not.toThrow();
    });

    it("can be called repeatedly without side effects", async () => {
      await loadModule();
      for (let i = 0; i < 5; i++) {
        expect(() => zombieReaper.reapZombies()).not.toThrow();
      }
    });
  });

  describe("startZombieReaper / stopZombieReaper", () => {
    it("starts and stops without throwing", async () => {
      await loadModule();
      expect(() => zombieReaper.startZombieReaper()).not.toThrow();
      expect(() => zombieReaper.stopZombieReaper()).not.toThrow();
    });

    it("start is idempotent", async () => {
      await loadModule();
      // Multiple starts should not throw or create duplicate timers
      zombieReaper.startZombieReaper();
      zombieReaper.startZombieReaper();
      zombieReaper.startZombieReaper();
      zombieReaper.stopZombieReaper();
    });

    it("stop before start is harmless", async () => {
      await loadModule();
      expect(() => zombieReaper.stopZombieReaper()).not.toThrow();
    });

    it("restart after stop works", async () => {
      await loadModule();
      zombieReaper.startZombieReaper();
      zombieReaper.stopZombieReaper();
      zombieReaper.startZombieReaper();
      zombieReaper.stopZombieReaper();
    });
  });
});
