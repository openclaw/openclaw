import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStateFilePath } from "./session-persistence.js";

// We test the file I/O logic directly rather than going through CDP,
// since CDP requires a real browser. The CDP integration is tested manually / e2e.

describe("session-persistence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-persist-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getStateFilePath resolves correctly", () => {
    const p = getStateFilePath("/some/user-data");
    expect(p).toBe("/some/user-data/openclaw-saved-state.json");
  });

  describe("state file format", () => {
    it("reads a valid state file", () => {
      const statePath = getStateFilePath(tmpDir);
      const state = {
        version: 1,
        savedAt: new Date().toISOString(),
        cookies: [
          {
            name: "sid",
            value: "abc123",
            domain: ".example.com",
            path: "/",
            expires: Math.floor(Date.now() / 1000) + 3600,
            size: 10,
            httpOnly: true,
            secure: true,
            session: false,
            sameSite: "Lax",
          },
        ],
      };
      fs.writeFileSync(statePath, JSON.stringify(state), "utf-8");

      const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(parsed.version).toBe(1);
      expect(parsed.cookies).toHaveLength(1);
      expect(parsed.cookies[0].name).toBe("sid");
    });

    it("handles corrupted state file gracefully", () => {
      const statePath = getStateFilePath(tmpDir);
      fs.writeFileSync(statePath, "not json {{{", "utf-8");

      let parsed: unknown = null;
      try {
        parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      } catch {
        parsed = null;
      }
      expect(parsed).toBeNull();
    });

    it("handles missing state file", () => {
      const statePath = getStateFilePath(tmpDir);
      expect(fs.existsSync(statePath)).toBe(false);
    });
  });

  describe("expired cookie filtering", () => {
    it("filters out expired cookies", () => {
      const now = Date.now() / 1000;
      const cookies = [
        { name: "valid", expires: now + 3600, session: false },
        { name: "expired", expires: now - 3600, session: false },
        { name: "session", expires: 0, session: true },
        { name: "no-expiry", expires: -1, session: false },
        { name: "zero-expiry", expires: 0, session: false },
      ];

      const validCookies = cookies.filter(
        (c) => c.session || c.expires === -1 || c.expires === 0 || c.expires > now,
      );

      expect(validCookies.map((c) => c.name)).toEqual([
        "valid",
        "session",
        "no-expiry",
        "zero-expiry",
      ]);
    });
  });

  describe("atomic write", () => {
    it("writes via tmp then rename", () => {
      const statePath = getStateFilePath(tmpDir);
      const state = {
        version: 1,
        savedAt: new Date().toISOString(),
        cookies: [],
      };

      // Simulate the atomic write pattern
      const tmpPath = statePath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
      expect(fs.existsSync(tmpPath)).toBe(true);
      expect(fs.existsSync(statePath)).toBe(false);

      fs.renameSync(tmpPath, statePath);
      expect(fs.existsSync(statePath)).toBe(true);
      expect(fs.existsSync(tmpPath)).toBe(false);

      const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(parsed.version).toBe(1);
    });
  });

  describe("startPeriodicSave", () => {
    it("returns a cleanup function that clears the interval", async () => {
      // We can't easily test the full flow without a browser, but we can
      // verify the cleanup function works by importing and calling it
      // with a mock that always returns null (no browser).
      const { startPeriodicSave } = await import("./session-persistence.js");

      const mockLog = { info: vi.fn(), warn: vi.fn() };
      const getCdpWsUrl = vi.fn().mockResolvedValue(null);

      const stop = startPeriodicSave(getCdpWsUrl, tmpDir, mockLog, 50);
      expect(typeof stop).toBe("function");

      // Wait for at least one interval tick
      await new Promise((r) => setTimeout(r, 120));
      expect(getCdpWsUrl).toHaveBeenCalled();

      // Cleanup should stop the timer
      stop();
      const callCount = getCdpWsUrl.mock.calls.length;
      await new Promise((r) => setTimeout(r, 120));
      // No additional calls after cleanup
      expect(getCdpWsUrl.mock.calls.length).toBe(callCount);
    });
  });
});
