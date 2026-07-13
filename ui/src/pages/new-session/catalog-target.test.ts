import { describe, expect, it } from "vitest";
import { resolveAgentId } from "./catalog-target.ts";

describe("catalog target agent resolution", () => {
  const agents = [{ id: "main" }, { id: "research" }];

  it("preserves a valid requested agent for catalog-targeted sessions", () => {
    expect(
      resolveAgentId(
        {
          agentId: "research",
          catalogId: "claude",
        },
        agents,
        "main",
      ),
    ).toBe("research");
  });

  it("falls back when the requested agent is missing or invalid", () => {
    expect(
      resolveAgentId(
        {
          agentId: "missing",
          catalogId: "claude",
        },
        agents,
        "main",
      ),
    ).toBe("main");
  });
});
