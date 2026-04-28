// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AppViewState } from "../app-view-state.ts";
import type { SessionsListResult } from "../types.ts";
import { resolveSessionOptionGroups } from "./session-controls.ts";

type SessionRow = SessionsListResult["sessions"][number];

function row(overrides: Partial<SessionRow> & { key: string }): SessionRow {
  return { kind: "direct", updatedAt: 0, ...overrides };
}

function optionKeys(params: {
  sessionKey: string;
  sessions?: SessionRow[];
  agentsList?: AppViewState["agentsList"];
}): string[] {
  return resolveSessionOptionGroups(
    {
      sessionsHideCron: true,
      agentsList: params.agentsList ?? null,
    } as AppViewState,
    params.sessionKey,
    {
      ts: 0,
      path: "",
      count: params.sessions?.length ?? 0,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: params.sessions ?? [],
    },
  ).flatMap((group) => group.options.map((option) => option.key));
}

describe("resolveSessionOptionGroups configured agents", () => {
  it("adds configured agents without stored session rows", () => {
    const keys = optionKeys({
      sessionKey: "agent:alpha:main",
      agentsList: {
        defaultId: "alpha",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "alpha", name: "Deep Chat" },
          { id: "beta", name: "Coding" },
        ],
      },
      sessions: [row({ key: "agent:alpha:main" })],
    });

    expect(keys).toContain("agent:alpha:main");
    expect(keys).toContain("agent:beta:main");
  });

  it("uses the configured mainKey without nesting agent session keys", () => {
    const keys = optionKeys({
      sessionKey: "agent:alpha:work",
      agentsList: {
        defaultId: "alpha",
        mainKey: "agent:alpha:work",
        scope: "per-sender",
        agents: [
          { id: "alpha", name: "Deep Chat" },
          { id: "beta", name: "Coding" },
        ],
      },
      sessions: [row({ key: "agent:alpha:work" })],
    });

    expect(keys).toContain("agent:beta:work");
    expect(keys).not.toContain("agent:beta:main");
    expect(keys).not.toContain("agent:beta:agent:alpha:work");
  });

  it("deduplicates configured agents against existing aliases by normalized key", () => {
    const keys = optionKeys({
      sessionKey: "agent:alpha:main",
      agentsList: {
        defaultId: "alpha",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "alpha", name: "Deep Chat" },
          { id: "Beta", name: "Coding" },
        ],
      },
      sessions: [row({ key: "agent:alpha:main" }), row({ key: "agent:beta:main" })],
    });

    expect(keys.filter((key) => key.toLowerCase() === "agent:beta:main")).toHaveLength(1);
  });

  it("does not add per-agent switch targets for global-scope sessions", () => {
    const keys = optionKeys({
      sessionKey: "global",
      agentsList: {
        defaultId: "alpha",
        mainKey: "main",
        scope: "global",
        agents: [
          { id: "alpha", name: "Deep Chat" },
          { id: "beta", name: "Coding" },
        ],
      },
      sessions: [row({ key: "global", kind: "global" })],
    });

    expect(keys).toEqual(["global"]);
  });
});
