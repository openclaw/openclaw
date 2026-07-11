import { describe, expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { resolveSessionNavigation } from "./navigation.ts";

function sessionsResult(sessions: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

describe("resolveSessionNavigation", () => {
  it("keeps the selected session in its sorted slot instead of hoisting it", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      key: `agent:main:recent-${index}`,
      kind: "direct" as const,
      updatedAt: 100 - index,
    }));
    const navigation = resolveSessionNavigation({
      result: sessionsResult(rows),
      resultAgentId: "main",
      sessionKey: "agent:main:recent-3",
    });

    expect(navigation.recentSessions.map((row) => row.key)).toEqual(rows.map((row) => row.key));
    expect(navigation.activeRowKey).toBe("agent:main:recent-3");
  });

  it("uses the caller's sort order before applying the recent-session projection", () => {
    const navigation = resolveSessionNavigation({
      result: sessionsResult([
        { key: "agent:main:session-c", kind: "direct", updatedAt: 300 },
        { key: "agent:main:session-a", kind: "direct", updatedAt: 100 },
        { key: "agent:main:session-b", kind: "direct", updatedAt: 200 },
      ]),
      resultAgentId: "main",
      sessionKey: "agent:main:session-b",
      compareSessions: (a, b) => a.key.localeCompare(b.key),
    });

    expect(navigation.recentSessions.map((row) => row.key)).toEqual([
      "agent:main:session-a",
      "agent:main:session-b",
      "agent:main:session-c",
    ]);
    expect(navigation.activeRowKey).toBe("agent:main:session-b");
  });

  it("pins the selected session ahead of the nine most recent rows when the list omits it", () => {
    const navigation = resolveSessionNavigation({
      result: sessionsResult(
        Array.from({ length: 11 }, (_, index) => ({
          key: `agent:main:recent-${index}`,
          kind: "direct",
          updatedAt: 100 - index,
        })),
      ),
      resultAgentId: "main",
      sessionKey: "agent:main:oldest",
    });

    expect(navigation.recentSessions).toHaveLength(10);
    expect(navigation.recentSessions[0]).toMatchObject({
      key: "agent:main:oldest",
      kind: "direct",
      updatedAt: null,
    });
    expect(navigation.activeRowKey).toBe("agent:main:oldest");
    expect(navigation.recentSessions.slice(1).map((row) => row.key)).toEqual(
      Array.from({ length: 9 }, (_, index) => `agent:main:recent-${index}`),
    );
  });

  it("surfaces the real row when the selected session sits beyond the recency cap", () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      key: `agent:main:recent-${index}`,
      kind: "direct" as const,
      updatedAt: 100 - index,
    }));
    const navigation = resolveSessionNavigation({
      result: sessionsResult(rows),
      resultAgentId: "main",
      sessionKey: "agent:main:recent-11",
    });

    expect(navigation.recentSessions[0]).toBe(rows[11]);
    expect(navigation.recentSessions).toHaveLength(10);
    expect(navigation.activeRowKey).toBe("agent:main:recent-11");
  });

  it("keeps every pinned session when pins exceed the recent-session cap", () => {
    const pinnedSessions = Array.from({ length: 10 }, (_, index) => ({
      key: `agent:main:pinned-${index}`,
      kind: "direct" as const,
      pinned: true,
      updatedAt: 100 - index,
    }));
    const navigation = resolveSessionNavigation({
      result: sessionsResult([
        { key: "agent:main:recent", kind: "direct", updatedAt: 1_000 },
        ...pinnedSessions,
      ]),
      resultAgentId: "main",
      sessionKey: "unknown",
    });

    expect(navigation.recentSessions.map((row) => row.key)).toEqual([
      ...pinnedSessions.map((row) => row.key),
      "agent:main:recent",
    ]);
  });

  it("keeps nine recent chats in addition to pinned sessions", () => {
    const pinnedSessions = Array.from({ length: 3 }, (_, index) => ({
      key: `agent:main:pinned-${index}`,
      kind: "direct" as const,
      pinned: true,
      updatedAt: 100 - index,
    }));
    const recentSessions = Array.from({ length: 10 }, (_, index) => ({
      key: `agent:main:recent-${index}`,
      kind: "direct" as const,
      updatedAt: 1_000 - index,
    }));
    const navigation = resolveSessionNavigation({
      result: sessionsResult([...recentSessions, ...pinnedSessions]),
      resultAgentId: "main",
      sessionKey: "unknown",
    });

    expect(navigation.recentSessions.map((row) => row.key)).toEqual([
      ...pinnedSessions.map((row) => row.key),
      ...recentSessions.slice(0, 9).map((row) => row.key),
    ]);
    expect(navigation.activeRowKey).toBeNull();
  });
});
