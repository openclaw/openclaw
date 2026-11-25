import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

function agentTools(tools: Record<string, unknown>) {
  return { agents: { entries: { main: { tools } } } };
}

function validateBinding(agentId: string, entries: Record<string, unknown>) {
  return validateConfigObject({
    agents: { entries },
    bindings: [
      {
        type: "route",
        agentId,
        match: { channel: "discord", peer: { kind: "direct", id: "user-1" } },
      },
    ],
  });
}

describe("config schema regressions", () => {
  it("accepts and preserves mixed extra memory path entries", () => {
    const extraPaths = [
      "../team-notes",
      { path: "../shared", pattern: "runbooks/**/*.md", evergreen: true },
    ];
    const result = validateConfigObject({
      memory: { search: { extraPaths } },
      agents: { entries: { main: {} } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.memory?.search?.extraPaths).toEqual(extraPaths);
    }
  });

  it.each([
    { pattern: "**/*.md" },
    { path: "../shared", pattern: 42 },
    { path: "../shared", evergreen: "yes" },
    { path: "../shared", name: "legacy-qmd-name" },
  ])("rejects invalid extra memory path object %j", (entry) => {
    const result = validateConfigObject({
      memory: { search: { extraPaths: [entry] } },
      agents: { entries: { main: {} } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.startsWith("memory.search.extraPaths"))).toBe(
        true,
      );
    }
  });
  it.each(["clawson", "A", "0_team-name", "a".repeat(64)])(
    "accepts repository branch prefix %j through canonical config validation",
    (repositoryBranchPrefix) => {
      const result = validateConfigObject({ repositoryBranchPrefix });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.repositoryBranchPrefix).toBe(repositoryBranchPrefix);
      }
    },
  );

  it.each([
    "",
    "../other",
    "refs/heads",
    "-option",
    "has space",
    " clawson",
    "clawson\n",
    "é",
    "a".repeat(65),
  ])("rejects unsafe repository branch prefix %j", (repositoryBranchPrefix) => {
    expect(validateConfigObject({ repositoryBranchPrefix }).ok).toBe(false);
  });

  it.each([["ops"], ["ops-*"], [], ["*"]].map((send) => ({ send })))(
    "accepts per-agent send destinations $send",
    ({ send }) => {
      const result = validateConfigObject(agentTools({ agentToAgent: { send } }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.agents?.entries?.main?.tools?.agentToAgent?.send).toEqual(send);
      }
    },
  );

  it.each(["ops", [1], { target: "ops" }].map((send) => ({ send })))(
    "rejects malformed send destinations $send",
    ({ send }) => {
      expect(validateConfigObject(agentTools({ agentToAgent: { send } })).ok).toBe(false);
    },
  );

  it("preserves the global exec approval notice delay (#115101)", () => {
    const result = validateConfigObject({ tools: { exec: { approvalRunningNoticeMs: 0 } } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.tools?.exec?.approvalRunningNoticeMs).toBe(0);
    }
  });

  it("accepts exact main bindings when the roster omits main (#89419)", () => {
    expect(validateBinding("main", { alpha: { model: "anthropic/claude-3-5-sonnet" } }).ok).toBe(
      true,
    );
  });

  it("rejects normalized main variants omitted from the roster", () => {
    const result = validateBinding("MAIN", { alpha: { model: "anthropic/claude-3-5-sonnet" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes('Unknown agent id "MAIN"'))).toBe(
        true,
      );
    }
  });

  it("accepts an explicitly configured main variant", () => {
    expect(validateBinding("MAIN", { MAIN: { model: "anthropic/claude-3-5-sonnet" } }).ok).toBe(
      true,
    );
  });

  it("accepts persisted Foundry thinkingLevelMap (#91011)", () => {
    expect(
      validateConfigObject({
        models: {
          providers: {
            "microsoft-foundry": {
              models: [
                {
                  id: "gpt-5.1-chat",
                  name: "gpt-5.1-chat",
                  api: "openai-responses",
                  reasoning: true,
                  thinkingLevelMap: {
                    off: "none",
                    minimal: null,
                    low: "low",
                    medium: "medium",
                    high: "high",
                    xhigh: null,
                    max: null,
                  },
                },
              ],
            },
          },
        },
      }).ok,
    ).toBe(true);
  });

  it.each([
    {
      scope: "global",
      path: "tools",
      config: { tools: { allow: ["group:fs"], alsoAllow: ["lobster"] } },
    },
    {
      scope: "per-agent",
      path: "agents.entries.main.tools",
      config: agentTools({ allow: ["group:fs"], alsoAllow: ["lobster"] }),
    },
  ])("rejects allow + alsoAllow in the $scope scope", ({ config, path }) => {
    const result = validateConfigObject(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toContain(path);
    }
  });

  it("allows profile + alsoAllow", () => {
    expect(validateConfigObject({ tools: { profile: "coding", alsoAllow: ["lobster"] } }).ok).toBe(
      true,
    );
  });
});
