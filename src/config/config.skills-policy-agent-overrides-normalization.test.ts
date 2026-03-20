import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("skills.policy.agentOverrides normalization", () => {
  it("accepts agent override keys that match agents.list ids after normalization", () => {
    const result = OpenClawSchema.safeParse({
      agents: {
        list: [{ id: "Ops-Team" }],
      },
      skills: {
        policy: {
          globalEnabled: ["weather"],
          agentOverrides: {
            "ops team": {
              enabled: ["weather"],
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects unknown normalized override keys", () => {
    const result = OpenClawSchema.safeParse({
      agents: {
        list: [{ id: "ops-team" }],
      },
      skills: {
        policy: {
          globalEnabled: ["weather"],
          agentOverrides: {
            ghost: {
              enabled: ["weather"],
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(
      result.error.issues.some(
        (issue) =>
          issue.path.join(".") === "skills.policy.agentOverrides.ghost" &&
          issue.message.includes('Unknown agent id "ghost"'),
      ),
    ).toBe(true);
  });

  it("rejects duplicate override keys that normalize to the same agent id", () => {
    const result = OpenClawSchema.safeParse({
      agents: {
        list: [{ id: "ops-team" }],
      },
      skills: {
        policy: {
          globalEnabled: ["weather"],
          agentOverrides: {
            "Ops Team": {
              enabled: ["weather"],
            },
            "ops-team": {
              disabled: ["weather"],
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(
      result.error.issues.some((issue) =>
        issue.message.includes('Duplicate normalized agent override "ops-team"'),
      ),
    ).toBe(true);
  });

  it("allows test-agent override keys for test-only fixtures", () => {
    const result = OpenClawSchema.safeParse({
      agents: {
        list: [{ id: "ops-team" }],
      },
      skills: {
        policy: {
          globalEnabled: ["weather"],
          agentOverrides: {
            "test-agent_ci": {
              enabled: ["weather"],
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });
});
