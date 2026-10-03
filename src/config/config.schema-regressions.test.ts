import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

function validateAgentDefaults(defaults: Record<string, unknown>) {
  return validateConfigObject({ agents: { defaults } });
}

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
  it("rejects a string gateway.uploads.enabled value", () => {
    expect(validateConfigObject({ gateway: { uploads: { enabled: "false" } } }).ok).toBe(false);
  });

  it("rejects oversized startup context limits", () => {
    expect(
      validateAgentDefaults({ startupContext: { dailyMemoryDays: 99, maxFileBytes: 999_999 } }).ok,
    ).toBe(false);
  });

  it("rejects non-positive PDF limits", () => {
    const result = validateAgentDefaults({
      pdfModel: { primary: "openai/gpt-5.4-mini" },
      pdfMaxMb: 0,
      pdfMaxPages: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(["agents.defaults.pdfMaxMb", "agents.defaults.pdfMaxPages"]),
      );
    }
  });

  it("accepts browser.extraArgs for proxy and custom flags", () => {
    expect(
      validateConfigObject({ browser: { extraArgs: ["--proxy-server=http://127.0.0.1:7890"] } }).ok,
    ).toBe(true);
  });

  it.each([
    {
      scope: "global",
      config: { tools: { exec: { approvalRunningNoticeMs: 0 } } },
      path: "tools.exec.approvalRunningNoticeMs",
      delay: 0,
    },
    {
      scope: "per-agent",
      config: agentTools({ exec: { approvalRunningNoticeMs: 3000 } }),
      path: "agents.entries.main.tools.exec.approvalRunningNoticeMs",
      delay: 3000,
    },
  ])("preserves the $scope exec approval notice delay (#115101)", ({ config, path, delay }) => {
    const result = validateConfigObject(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toHaveProperty(path, delay);
    }
  });

  it("rejects negative exec approval notice delays", () => {
    const result = validateConfigObject({ tools: { exec: { approvalRunningNoticeMs: -1 } } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toContain(
        "tools.exec.approvalRunningNoticeMs",
      );
    }
  });

  it("accepts mixed extra memory path entries", () => {
    expect(
      validateConfigObject({
        memory: {
          search: {
            extraPaths: ["../team-notes", { path: "../shared", pattern: "runbooks/**/*.md" }],
          },
        },
        agents: { defaults: {} },
      }).ok,
    ).toBe(true);
  });

  it("rejects local memorySearch GPU policy", () => {
    expect(
      validateConfigObject({
        memory: { search: { provider: "local", local: { gpu: "cpu" } } },
        agents: { defaults: {} },
      }).ok,
    ).toBe(false);
  });

  it("accepts agents.defaults.startupContext overrides", () => {
    expect(
      validateAgentDefaults({
        startupContext: {
          enabled: true,
          applyOn: ["new"],
          dailyMemoryDays: 3,
          maxFileBytes: 8192,
          maxFileChars: 1000,
          maxTotalChars: 2500,
        },
      }).ok,
    ).toBe(true);
  });

  it("accepts defaults and per-agent contextLimits overrides", () => {
    expect(
      validateConfigObject({
        agents: {
          defaults: { contextLimits: { memoryGetMaxChars: 20_000, postCompactionMaxChars: 4_000 } },
          entries: {
            writer: {
              skillsLimits: { maxSkillsPromptChars: 30_000 },
              contextLimits: { memoryGetMaxChars: 24_000 },
            },
          },
        },
      }).ok,
    ).toBe(true);
  });

  it("accepts queue byChannel providers including Matrix (#84104)", () => {
    expect(
      validateConfigObject({
        messages: {
          queue: {
            byChannel: { googlechat: "followup", mattermost: "collect", matrix: "steer" },
          },
        },
      }).ok,
    ).toBe(true);
  });

  it("accepts string values for agent default model inputs", () => {
    expect(
      validateAgentDefaults({
        model: "anthropic/claude-opus-4-6",
        imageModel: "openai/gpt-4.1-mini",
      }).ok,
    ).toBe(true);
  });

  it("accepts pdf default model and limits", () => {
    expect(
      validateAgentDefaults({
        pdfModel: { primary: "anthropic/claude-opus-4-6", fallbacks: ["openai/gpt-5.4-mini"] },
        pdfMaxMb: 12,
        pdfMaxPages: 25,
      }).ok,
    ).toBe(true);
  });

  it("rejects bindings to a missing agent (#84692)", () => {
    const result = validateBinding("ghost", { alpha: { model: "anthropic/claude-3-5-sonnet" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.message.includes('Unknown agent id "ghost"')),
      ).toBe(true);
    }
  });

  it("rejects non-addressable agent entry keys", () => {
    expect(
      validateConfigObject({
        agents: { entries: { "Team Ops": { model: "anthropic/claude-3-5-sonnet" } } },
      }).ok,
    ).toBe(false);
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

  it("rejects thinkingLevelMap keys outside the model thinking levels", () => {
    expect(
      validateConfigObject({
        models: {
          providers: {
            "microsoft-foundry": {
              models: [
                {
                  id: "gpt-5.1-chat",
                  name: "gpt-5.1-chat",
                  thinkingLevelMap: { adaptive: "high" },
                },
              ],
            },
          },
        },
      }).ok,
    ).toBe(false);
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
