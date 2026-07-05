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
});
