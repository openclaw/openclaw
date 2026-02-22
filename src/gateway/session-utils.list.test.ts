import { describe, expect, test } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { SessionsListParams } from "./protocol/schema/sessions.js";
import { listSessionsFromStore } from "./session-utils.js";

// Minimal mock config for testing listSessionsFromStore
const mockConfig = {
  agents: {
    list: [{ id: "main", name: "Main Agent" }],
    defaults: {},
  },
  session: {
    scope: "per-sender" as const,
    store: "/tmp/test-sessions.json",
  },
} as unknown as Parameters<typeof listSessionsFromStore>[0]["cfg"];

describe("listSessionsFromStore", () => {
  describe("spawnedBy and spawnDepth fields", () => {
    test("includes spawnedBy and spawnDepth for subagent sessions", () => {
      const now = Date.now();
      const store: Record<string, SessionEntry> = {
        "agent:main:work": {
          sessionId: "sess-main",
          updatedAt: now,
        },
        "agent:main:subagent:abc123": {
          sessionId: "sess-subagent-1",
          updatedAt: now - 1000,
          spawnedBy: "agent:main:work",
          spawnDepth: 1,
        },
        "agent:main:subagent:def456": {
          sessionId: "sess-subagent-2",
          updatedAt: now - 2000,
          spawnedBy: "agent:main:work",
          spawnDepth: 1,
        },
      };

      const result = listSessionsFromStore({
        cfg: mockConfig,
        storePath: "/tmp/test-sessions.json",
        store,
        opts: {} as SessionsListParams,
      });

      // Find the subagent sessions
      const subagent1 = result.sessions.find((s) => s.key === "agent:main:subagent:abc123");
      const subagent2 = result.sessions.find((s) => s.key === "agent:main:subagent:def456");
      const mainSession = result.sessions.find((s) => s.key === "agent:main:work");

      expect(subagent1).toBeDefined();
      expect(subagent1?.spawnedBy).toBe("agent:main:work");
      expect(subagent1?.spawnDepth).toBe(1);

      expect(subagent2).toBeDefined();
      expect(subagent2?.spawnedBy).toBe("agent:main:work");
      expect(subagent2?.spawnDepth).toBe(1);

      // Main session should not have these fields set (or be undefined)
      expect(mainSession).toBeDefined();
      expect(mainSession?.spawnedBy).toBeUndefined();
      expect(mainSession?.spawnDepth).toBeUndefined();
    });

    test("returns empty spawnedBy/undefined spawnDepth for regular sessions", () => {
      const now = Date.now();
      const store: Record<string, SessionEntry> = {
        "agent:main:work": {
          sessionId: "sess-main",
          updatedAt: now,
        },
        global: {
          sessionId: "sess-global",
          updatedAt: now - 5000,
        },
      };

      const result = listSessionsFromStore({
        cfg: mockConfig,
        storePath: "/tmp/test-sessions.json",
        store,
        opts: { includeGlobal: true } as SessionsListParams,
      });

      const mainSession = result.sessions.find((s) => s.key === "agent:main:work");
      const globalSession = result.sessions.find((s) => s.key === "global");

      expect(mainSession?.spawnedBy).toBeUndefined();
      expect(mainSession?.spawnDepth).toBeUndefined();
      expect(globalSession?.spawnedBy).toBeUndefined();
      expect(globalSession?.spawnDepth).toBeUndefined();
    });

    test("filters by spawnedBy when provided", () => {
      const now = Date.now();
      const parentKey = "agent:main:work";
      const store: Record<string, SessionEntry> = {
        [parentKey]: {
          sessionId: "sess-main",
          updatedAt: now,
        },
        "agent:main:subagent:child1": {
          sessionId: "sess-child-1",
          updatedAt: now - 1000,
          spawnedBy: parentKey,
          spawnDepth: 1,
        },
        "agent:main:subagent:child2": {
          sessionId: "sess-child-2",
          updatedAt: now - 2000,
          spawnedBy: parentKey,
          spawnDepth: 1,
        },
        "agent:main:other": {
          sessionId: "sess-other",
          updatedAt: now - 3000,
        },
      };

      const result = listSessionsFromStore({
        cfg: mockConfig,
        storePath: "/tmp/test-sessions.json",
        store,
        opts: { spawnedBy: parentKey } as SessionsListParams,
      });

      // Should only return sessions spawned by the parent
      expect(result.sessions).toHaveLength(2);
      expect(result.sessions.every((s) => s.spawnedBy === parentKey)).toBe(true);
      expect(result.sessions.every((s) => s.spawnDepth === 1)).toBe(true);
    });
  });

  describe("activeMinutes default behavior", () => {
    test("returns all sessions when activeMinutes is undefined", () => {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const oneDayAgo = now - 24 * 60 * 60 * 1000;

      const store: Record<string, SessionEntry> = {
        recent: {
          sessionId: "sess-recent",
          updatedAt: now - 1000,
        },
        oneHourOld: {
          sessionId: "sess-hour",
          updatedAt: oneHourAgo,
        },
        oneDayOld: {
          sessionId: "sess-day",
          updatedAt: oneDayAgo,
        },
      };

      const result = listSessionsFromStore({
        cfg: mockConfig,
        storePath: "/tmp/test-sessions.json",
        store,
        opts: {} as SessionsListParams, // No activeMinutes filter
      });

      // All sessions should be returned since no activeMinutes filter
      expect(result.sessions).toHaveLength(3);
    });

    test("filters sessions by activeMinutes when provided", () => {
      const now = Date.now();
      const thirtyMinutesAgo = now - 30 * 60 * 1000;
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;

      const store: Record<string, SessionEntry> = {
        recent: {
          sessionId: "sess-recent",
          updatedAt: now - 1000,
        },
        thirtyMinOld: {
          sessionId: "sess-thirty",
          updatedAt: thirtyMinutesAgo,
        },
        twoHoursOld: {
          sessionId: "sess-two-hours",
          updatedAt: twoHoursAgo,
        },
      };

      const result = listSessionsFromStore({
        cfg: mockConfig,
        storePath: "/tmp/test-sessions.json",
        store,
        opts: { activeMinutes: 60 } as SessionsListParams,
      });

      // Only sessions within the last 60 minutes should be returned
      expect(result.sessions).toHaveLength(2);
      expect(result.sessions.find((s) => s.key === "twoHoursOld")).toBeUndefined();
    });
  });
});
