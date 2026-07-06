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
    expect(navigation.recentSessions.slice(1).map((row) => row.key)).toEqual(
      Array.from({ length: 9 }, (_, index) => `agent:main:recent-${index}`),
    );
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
  });
});
