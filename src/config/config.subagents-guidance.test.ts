import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("subagent config validation guidance", () => {
  it('suggests "allowAgents" when a per-agent subagents block uses "allow"', () => {
    const result = validateConfigObjectRaw({
      agents: {
        list: [
          {
            id: "main",
            subagents: {
              allow: ["research"],
            },
          },
        ],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "agents.list.0.subagents");
      expect(issue?.message).toContain('Use "allowAgents" here');
      expect(issue?.message).toContain("sessions_spawn");
    }
  });

  it('suggests "allowAgents" when a per-agent subagents block uses "allowlist"', () => {
    const result = validateConfigObjectRaw({
      agents: {
        list: [
          {
            id: "main",
            subagents: {
              allowlist: ["research"],
            },
          },
        ],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "agents.list.0.subagents");
      expect(issue?.message).toContain('Use "allowAgents" here');
      expect(issue?.message).toContain("sessions_spawn");
    }
  });

  it("explains that spawn permissions do not belong under agents.defaults.subagents", () => {
    const result = validateConfigObjectRaw({
      agents: {
        defaults: {
          subagents: {
            allowAgents: ["research"],
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "agents.defaults.subagents");
      expect(issue?.message).toContain(
        "agents.defaults.subagents only defines shared spawn defaults",
      );
      expect(issue?.message).toContain("agents.list[].subagents.allowAgents");
    }
  });

  it("explains that agents.defaults is not an agent entry", () => {
    const result = validateConfigObjectRaw({
      agents: {
        defaults: {
          id: "main",
          name: "Main",
          tools: {
            allow: ["web_fetch"],
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "agents.defaults");
      expect(issue?.message).toContain("shared-defaults block");
      expect(issue?.message).toContain("agents.list[]");
    }
  });
});
