import { describe, expect, it } from "vitest";
import type { AppViewState } from "../app-view-state.ts";
import { resolvePreferredSessionForAgent } from "./session-display.ts";

function state(overrides: Partial<AppViewState>): AppViewState {
  return {
    agentsList: { defaultId: "main", agents: [{ id: "main", name: "Todd Stanski" }] },
    sessionKey: "agent:main:codex:openclaw-dashboard",
    sessionsResult: null,
    ...overrides,
  } as AppViewState;
}

describe("resolvePreferredSessionForAgent", () => {
  it("routes the default Todd agent back to the local main session from Codex project sessions", () => {
    expect(resolvePreferredSessionForAgent(state({}), "main")).toBe("agent:main:main");
  });

  it("does not choose the newest Codex project row as Todd's preferred local chat", () => {
    expect(
      resolvePreferredSessionForAgent(
        state({
          sessionKey: "agent:strategic-director:main",
          sessionsResult: {
            ts: 10_000,
            path: "sessions.json",
            count: 2,
            defaults: { modelProvider: null, model: null, contextTokens: null },
            sessions: [
              { key: "agent:main:codex:openclaw-dashboard", kind: "direct", updatedAt: 10_000 },
              { key: "agent:main:main", kind: "direct", updatedAt: 1 },
            ],
          },
        }),
        "main",
      ),
    ).toBe("agent:main:main");
  });
});
