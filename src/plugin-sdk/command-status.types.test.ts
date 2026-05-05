import { describe, expect, it } from "vitest";
import type { HeartbeatStatus, SessionStatus, StatusSummary } from "./command-status.js";

// Regression for #76759: status payload types are part of the public plugin-sdk
// surface so plugins consuming gateway status RPCs (or formatting `/status`
// output) can bind against the canonical host shape rather than redeclare it
// and drift on host upgrades.
describe("command-status type re-exports (#76759)", () => {
  it("StatusSummary, SessionStatus, and HeartbeatStatus are importable as types", () => {
    const session: SessionStatus = {
      key: "agent:main",
      kind: "direct",
      updatedAt: 1_700_000_000_000,
      age: 1000,
      totalTokens: 1234,
      totalTokensFresh: true,
      remainingTokens: 1024,
      percentUsed: 50,
      model: "claude-opus-4-7",
      contextTokens: 200000,
      flags: [],
    };
    const heartbeat: HeartbeatStatus = {
      agentId: "main",
      enabled: true,
      every: "1m",
      everyMs: 60000,
    };
    const summary: StatusSummary = {
      heartbeat: { defaultAgentId: "main", agents: [heartbeat] },
      channelSummary: [],
      queuedSystemEvents: [],
      // The exact `tasks` and `taskAudit` field shapes are host-internal (the
      // value of this re-export is the OUTER `StatusSummary` shape itself,
      // which plugins use to type the gateway status response). Cast through
      // `unknown` so the test asserts type-portability of the public surface
      // without binding the test to host-internal nested types — those are
      // already locked by their own tests in `src/tasks/*` and `src/status/*`.
      tasks: {} as unknown as StatusSummary["tasks"],
      taskAudit: {} as unknown as StatusSummary["taskAudit"],
      sessions: {
        paths: [],
        count: 1,
        defaults: { model: null, contextTokens: null },
        recent: [session],
        byAgent: [],
      },
    };

    expect(summary.sessions.recent[0]?.totalTokens).toBe(1234);
    expect(summary.heartbeat.agents[0]?.everyMs).toBe(60000);
  });
});
