import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";

describe("session-crash-recovery", () => {
  let testStateDir: string;
  let originalStateDir: string | undefined;
  let mockSessionStores: Map<string, Record<string, SessionEntry>>;
  let sessionsModule: typeof import("../config/sessions.js");

  beforeEach(async () => {
    vi.clearAllMocks();
    testStateDir = fs.mkdtempSync(path.join(__dirname, "../../.test-state-"));
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    mockSessionStores = new Map();

    // Import sessions module and spy on its methods
    sessionsModule = await import("../config/sessions.js");
    vi.spyOn(sessionsModule, "loadSessionStore").mockImplementation((storePath: string) => {
      if (!mockSessionStores.has(storePath)) {
        mockSessionStores.set(storePath, {});
      }
      return mockSessionStores.get(storePath)!;
    });
    vi.spyOn(sessionsModule, "resolveAgentIdFromSessionKey").mockImplementation(
      (sessionKey: string | null | undefined) => {
        const key = sessionKey ?? "";
        const parts = key.split(":");
        return parts.length > 1 ? parts[1] : "main";
      },
    );
    vi.spyOn(sessionsModule, "resolveStorePath").mockImplementation(
      (_storeConfig?: string, opts?: { agentId?: string }) => {
        return `${testStateDir}/agents/${opts?.agentId ?? "main"}/sessions/sessions.json`;
      },
    );
    vi.spyOn(sessionsModule, "updateSessionStore").mockImplementation(
      async (storePath: string, updater: (store: Record<string, SessionEntry>) => unknown) => {
        const store = mockSessionStores.get(storePath);
        if (store) {
          return updater(store);
        }
      },
    );

    // Mock config
    const configModule = await import("../config/config.js");
    vi.spyOn(configModule, "loadConfig").mockImplementation(
      () =>
        ({
          session: { store: undefined },
        }) as unknown as ReturnType<typeof import("../config/config.js").loadConfig>,
    );

    // Mock paths
    const pathsModule = await import("../config/paths.js");
    vi.spyOn(pathsModule, "resolveStateDir").mockImplementation(() => testStateDir);

    // Reset crash recovery state
    const mod = await import("./session-crash-recovery.js");
    mod.__testing?.resetForTest();
  });

  afterEach(() => {
    if (originalStateDir) {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    } else {
      delete process.env.OPENCLAW_STATE_DIR;
    }
    try {
      fs.rmSync(testStateDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    vi.restoreAllMocks();
  });

  describe("registerActiveSession / unregisterActiveSession", () => {
    it("tracks active sessions", async () => {
      const { registerActiveSession, __testing } = await import("./session-crash-recovery.js");

      registerActiveSession("agent:main:session-1");
      registerActiveSession("agent:main:session-2");

      const snapshot = __testing?.getRegisteredSessions();
      expect(snapshot?.size).toBe(2);
      expect(snapshot?.has("agent:main:session-1")).toBe(true);
      expect(snapshot?.has("agent:main:session-2")).toBe(true);
    });

    it("removes sessions when unregistered", async () => {
      const { registerActiveSession, unregisterActiveSession, __testing } =
        await import("./session-crash-recovery.js");

      registerActiveSession("agent:main:session-1");
      registerActiveSession("agent:main:session-2");

      unregisterActiveSession("agent:main:session-1");

      const snapshot = __testing?.getRegisteredSessions();
      expect(snapshot?.size).toBe(1);
      expect(snapshot?.has("agent:main:session-1")).toBe(false);
      expect(snapshot?.has("agent:main:session-2")).toBe(true);
    });

    it("clears all sessions", async () => {
      const { registerActiveSession, clearActiveSessions, __testing } =
        await import("./session-crash-recovery.js");

      registerActiveSession("agent:main:session-1");
      registerActiveSession("agent:main:session-2");

      clearActiveSessions();

      const snapshot = __testing?.getRegisteredSessions();
      expect(snapshot?.size).toBe(0);
    });

    it("ignores empty session keys", async () => {
      const { registerActiveSession, __testing } = await import("./session-crash-recovery.js");

      registerActiveSession("");
      registerActiveSession("  ");
      registerActiveSession("agent:main:valid");

      const snapshot = __testing?.getRegisteredSessions();
      expect(snapshot?.size).toBe(1);
      expect(snapshot?.has("agent:main:valid")).toBe(true);
    });
  });

  describe("crash marker write on exit", () => {
    it("writes crash marker with active sessions", async () => {
      const { registerActiveSession, __testing } = await import("./session-crash-recovery.js");

      registerActiveSession("agent:main:session-1");
      registerActiveSession("agent:main:session-2");

      const markerPath = path.join(testStateDir, "active-sessions-crash.json");
      __testing?.writeCrashMarkerSync(markerPath);

      expect(fs.existsSync(markerPath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      expect(content.sessions).toHaveLength(2);
      expect(content.sessions.map((s: { sessionKey: string }) => s.sessionKey)).toContain(
        "agent:main:session-1",
      );
    });

    it("does not write marker when no active sessions", async () => {
      const { __testing } = await import("./session-crash-recovery.js");

      const markerPath = path.join(testStateDir, "active-sessions-crash.json");
      __testing?.writeCrashMarkerSync(markerPath);

      expect(fs.existsSync(markerPath)).toBe(false);
    });
  });

  describe("crash recovery from marker", () => {
    it("marks sessions as aborted from crash marker", async () => {
      const { __testing } = await import("./session-crash-recovery.js");

      // Setup mock session stores
      const storePath = `${testStateDir}/agents/main/sessions/sessions.json`;
      mockSessionStores.set(storePath, {
        "agent:main:session-1": {
          sessionId: "sid-1",
          updatedAt: Date.now() - 1000,
        },
        "agent:main:session-2": {
          sessionId: "sid-2",
          updatedAt: Date.now() - 1000,
        },
      });

      // Create crash marker
      const markerPath = path.join(testStateDir, "active-sessions-crash.json");
      const markerContent = {
        sessions: [
          { sessionKey: "agent:main:session-1", updatedAt: Date.now() },
          { sessionKey: "agent:main:session-2", updatedAt: Date.now() },
        ],
      };
      fs.writeFileSync(markerPath, JSON.stringify(markerContent), "utf8");

      // Run recovery
      __testing?.recoverFromCrashMarkerSync(testStateDir);

      // Verify marker was removed
      expect(fs.existsSync(markerPath)).toBe(false);

      // Verify sessions were marked as aborted
      const updatedStore = mockSessionStores.get(storePath)!;
      expect(updatedStore["agent:main:session-1"].abortedLastRun).toBe(true);
      expect(updatedStore["agent:main:session-2"].abortedLastRun).toBe(true);
    });

    it("skips sessions that have already ended", async () => {
      const { __testing } = await import("./session-crash-recovery.js");

      const storePath = `${testStateDir}/agents/main/sessions/sessions.json`;
      mockSessionStores.set(storePath, {
        "agent:main:session-1": {
          sessionId: "sid-1",
          updatedAt: Date.now() - 1000,
          endedAt: Date.now(), // Already ended
          status: "done",
        },
        "agent:main:session-2": {
          sessionId: "sid-2",
          updatedAt: Date.now() - 1000,
        },
      });

      const markerPath = path.join(testStateDir, "active-sessions-crash.json");
      const markerContent = {
        sessions: [
          { sessionKey: "agent:main:session-1", updatedAt: Date.now() },
          { sessionKey: "agent:main:session-2", updatedAt: Date.now() },
        ],
      };
      fs.writeFileSync(markerPath, JSON.stringify(markerContent), "utf8");

      __testing?.recoverFromCrashMarkerSync(testStateDir);

      const updatedStore = mockSessionStores.get(storePath)!;
      expect(updatedStore["agent:main:session-1"].abortedLastRun).toBeUndefined();
      expect(updatedStore["agent:main:session-2"].abortedLastRun).toBe(true);
    });

    it("handles missing marker gracefully", async () => {
      const { __testing } = await import("./session-crash-recovery.js");

      expect(() => __testing?.recoverFromCrashMarkerSync(testStateDir)).not.toThrow();
    });

    it("handles corrupted marker gracefully", async () => {
      const { __testing } = await import("./session-crash-recovery.js");

      const markerPath = path.join(testStateDir, "active-sessions-crash.json");
      fs.writeFileSync(markerPath, "not valid json", "utf8");

      expect(() => __testing?.recoverFromCrashMarkerSync(testStateDir)).not.toThrow();
      expect(fs.existsSync(markerPath)).toBe(true); // Marker not removed on parse error
    });
  });

  describe("initSessionCrashRecovery", () => {
    it("initializes without errors", async () => {
      const { initSessionCrashRecovery } = await import("./session-crash-recovery.js");

      expect(() => initSessionCrashRecovery()).not.toThrow();
    });

    it("recovers from existing crash marker on init", async () => {
      const { initSessionCrashRecovery } = await import("./session-crash-recovery.js");

      const storePath = `${testStateDir}/agents/main/sessions/sessions.json`;
      mockSessionStores.set(storePath, {
        "agent:main:session-1": { sessionId: "sid-1", updatedAt: Date.now() - 1000 },
      });

      const markerPath = path.join(testStateDir, "active-sessions-crash.json");
      const markerContent = {
        sessions: [{ sessionKey: "agent:main:session-1", updatedAt: Date.now() }],
      };
      fs.writeFileSync(markerPath, JSON.stringify(markerContent), "utf8");

      initSessionCrashRecovery();

      // Marker should be removed after recovery
      expect(fs.existsSync(markerPath)).toBe(false);

      // Session should be marked as aborted
      const updatedStore = mockSessionStores.get(storePath)!;
      expect(updatedStore["agent:main:session-1"].abortedLastRun).toBe(true);
    });
  });
});
