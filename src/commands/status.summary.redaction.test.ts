import { describe, expect, it } from "vitest";
import { redactSensitiveStatusSummary } from "./status.summary.js";
import type { StatusSummary } from "./status.types.js";

function createRecentSessionRow() {
  return {
    key: "main",
    kind: "direct" as const,
    sessionId: "sess-1",
    updatedAt: 1,
    age: 2,
    totalTokens: 3,
    totalTokensFresh: true,
    remainingTokens: 4,
    percentUsed: 5,
    model: "gpt-5",
    contextTokens: 200_000,
    flags: ["id:sess-1"],
  };
}

describe("redactSensitiveStatusSummary", () => {
  it("removes sensitive session and path details while preserving summary structure", () => {
    const input: StatusSummary = {
      heartbeat: {
        defaultAgentId: "main",
        agents: [{ agentId: "main", enabled: true, every: "5m", everyMs: 300_000 }],
      },
      channelSummary: ["ok"],
      queuedSystemEvents: ["none"],
      sessions: {
        paths: ["/tmp/openclaw/sessions.json"],
        count: 1,
        defaults: { model: "gpt-5", contextTokens: 200_000 },
        recent: [createRecentSessionRow()],
        byAgent: [
          {
            agentId: "main",
            path: "/tmp/openclaw/main-sessions.json",
            count: 1,
            recent: [createRecentSessionRow()],
          },
        ],
      },
    };

    const redacted = redactSensitiveStatusSummary(input);
    expect(redacted.sessions.paths).toEqual([]);
    expect(redacted.sessions.defaults).toEqual({ model: null, contextTokens: null });
    expect(redacted.sessions.recent).toEqual([]);
    expect(redacted.sessions.byAgent[0]?.path).toBe("[redacted]");
    expect(redacted.sessions.byAgent[0]?.recent).toEqual([]);
    expect(redacted.heartbeat).toEqual(input.heartbeat);
    expect(redacted.channelSummary).toEqual(input.channelSummary);
  });
});
