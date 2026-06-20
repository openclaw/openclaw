// Tests for `resolveSidebarRecentSessions`, the left Recent Sessions sidebar
// projection. Regression coverage for #95295: when the Sessions-view "All
// agents" toggle is on, the sidebar must surface cross-agent child-spawned
// rows instead of silently dropping them like the pre-fix projection did.
import { describe, expect, it } from "vitest";
import { resolveSidebarRecentSessions } from "./app-render.ts";
import type { AppViewState } from "./app-view-state.ts";

type SessionRowOverrides = Record<string, unknown>;

function makeRow(overrides: SessionRowOverrides = {}) {
  return {
    key: "agent:main:main",
    kind: "direct",
    archived: false,
    spawnedBy: null,
    updatedAt: 0,
    label: null,
    ...overrides,
  };
}

function makeState(overrides: SessionRowOverrides = {}) {
  return {
    hello: null,
    agentsList: null,
    assistantAgentId: null,
    sessionKey: "agent:main:main",
    sessionsResult: null,
    sessionsAllAgents: false,
    ...overrides,
  } as unknown as AppViewState;
}

const baseSessionsPayload = {
  ts: 1,
  path: "(multiple)",
  count: 3,
  defaults: { modelProvider: null, model: null, contextTokens: null },
};

describe("resolveSidebarRecentSessions (#95295)", () => {
  it("hides cross-agent child-spawned subagent rows by default", () => {
    const state = makeState({
      sessionsResult: {
        ...baseSessionsPayload,
        sessions: [
          makeRow({ key: "agent:main:main", updatedAt: 100 }),
          makeRow({
            key: "agent:orchestrator:subagent:review-1",
            kind: "spawn-child",
            spawnedBy: "agent:orchestrator:worker",
            updatedAt: 200,
          }),
          makeRow({
            key: "agent:dev:subagent:dev-1",
            kind: "spawn-child",
            spawnedBy: "agent:dev:main",
            updatedAt: 150,
          }),
        ],
      },
    });

    const result = resolveSidebarRecentSessions(state);
    expect(result.map((row) => row.key)).toEqual(["agent:main:main"]);
  });

  it("surfaces cross-agent child-spawned subagent rows when sessionsAllAgents is on", () => {
    const state = makeState({
      sessionsAllAgents: true,
      sessionsResult: {
        ...baseSessionsPayload,
        sessions: [
          makeRow({ key: "agent:main:main", updatedAt: 100 }),
          makeRow({
            key: "agent:orchestrator:subagent:review-1",
            kind: "spawn-child",
            spawnedBy: "agent:orchestrator:worker",
            updatedAt: 200,
          }),
          makeRow({
            key: "agent:dev:subagent:dev-1",
            kind: "spawn-child",
            spawnedBy: "agent:dev:main",
            updatedAt: 150,
          }),
        ],
      },
    });

    const result = resolveSidebarRecentSessions(state);
    // sorted by updatedAt desc; cross-agent rows surface when allAgents is on
    expect(result.map((row) => row.key)).toEqual([
      "agent:orchestrator:subagent:review-1",
      "agent:dev:subagent:dev-1",
      "agent:main:main",
    ]);
  });

  it("keeps archived / global / unknown / cron rows hidden even with sessionsAllAgents on", () => {
    const state = makeState({
      sessionsAllAgents: true,
      sessionsResult: {
        ...baseSessionsPayload,
        sessions: [
          makeRow({ key: "agent:main:main", updatedAt: 100 }),
          makeRow({ key: "global", kind: "global", updatedAt: 300 }),
          makeRow({ key: "unknown", kind: "unknown", updatedAt: 300 }),
          makeRow({ key: "cron:nightly", kind: "cron", updatedAt: 300 }),
          makeRow({ key: "agent:main:archived", archived: true, updatedAt: 300 }),
          makeRow({
            key: "agent:orchestrator:subagent:review-1",
            kind: "spawn-child",
            spawnedBy: "agent:orchestrator:worker",
            updatedAt: 200,
          }),
        ],
      },
    });

    const result = resolveSidebarRecentSessions(state);
    expect(result.map((row) => row.key)).toEqual([
      "agent:orchestrator:subagent:review-1",
      "agent:main:main",
    ]);
  });
});
