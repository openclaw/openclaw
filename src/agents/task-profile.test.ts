import { describe, expect, it } from "vitest";
import { resolveTaskProfile } from "./task-profile.js";

describe("resolveTaskProfile", () => {
  it("prefers explicit profile overrides", () => {
    expect(resolveTaskProfile({ explicit: "research", tools: [] })).toEqual({
      id: "research",
      source: "explicit",
    });
  });

  it("detects specific profiles from session keys before tool heuristics", () => {
    expect(resolveTaskProfile({ sessionKey: "agent:ops:main", tools: [] })).toEqual({
      id: "ops",
      source: "session-key",
      signal: "agent:ops:main",
    });
    expect(resolveTaskProfile({ sessionKey: "agent:research:worker", tools: [] })).toEqual({
      id: "research",
      source: "session-key",
      signal: "agent:research:worker",
    });
  });

  it("detects profiles from prompt text before tool-surface fallback", () => {
    expect(
      resolveTaskProfile({
        promptText: "Fix the TypeScript build error in src/version.ts",
        tools: [],
      }),
    ).toEqual({
      id: "coding",
      source: "prompt-text",
      signal: "Fix",
    });
    expect(
      resolveTaskProfile({
        promptText: "Research the latest OpenClaw documentation and summarize it",
        tools: [],
      }),
    ).toEqual({
      id: "research",
      source: "prompt-text",
      signal: "Research",
    });
  });

  it("infers coding and research profiles from tool surfaces", () => {
    expect(resolveTaskProfile({ tools: [{ name: "read" } as never] })).toEqual({
      id: "coding",
      source: "tool-surface",
      signal: "read",
    });
    expect(resolveTaskProfile({ tools: [{ name: "web_search" } as never] })).toEqual({
      id: "research",
      source: "tool-surface",
      signal: "web_search",
    });
  });

  it("still detects ops from tool surfaces when there is no stronger coding signal", () => {
    expect(resolveTaskProfile({ tools: [{ name: "nodes" } as never] })).toEqual({
      id: "ops",
      source: "tool-surface",
      signal: "nodes",
    });
  });

  it("falls back to assistant for default or main sessions when no stronger signal exists", () => {
    expect(resolveTaskProfile({ sessionKey: "agent:default:main", tools: [] })).toEqual({
      id: "assistant",
      source: "session-key",
      signal: "agent:default:main",
    });
  });

  it("defaults to assistant when there are no other signals", () => {
    expect(resolveTaskProfile({ tools: [] })).toEqual({
      id: "assistant",
      source: "default",
    });
  });
});
