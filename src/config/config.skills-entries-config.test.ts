import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("skills entries config schema", () => {
  it("accepts custom fields under config", () => {
    const res = OpenClawSchema.safeParse({
      skills: {
        entries: {
          "custom-skill": {
            enabled: true,
            config: {
              url: "https://example.invalid",
              token: "abc123",
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects unknown top-level fields", () => {
    const res = OpenClawSchema.safeParse({
      skills: {
        entries: {
          "custom-skill": {
            url: "https://example.invalid",
          },
        },
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }

    expect(
      res.error.issues.some(
        (issue) =>
          issue.path.join(".") === "skills.entries.custom-skill" &&
          issue.message.toLowerCase().includes("unrecognized"),
      ),
    ).toBe(true);
  });

  it("accepts skills policy global+agent override shape", () => {
    const res = OpenClawSchema.safeParse({
      agents: {
        list: [{ id: "ops" }],
      },
      skills: {
        policy: {
          globalEnabled: ["web-search", "weather"],
          agentOverrides: {
            ops: {
              enabled: ["jira"],
              disabled: ["weather"],
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects unknown fields under skills policy overrides", () => {
    const res = OpenClawSchema.safeParse({
      agents: {
        list: [{ id: "ops" }],
      },
      skills: {
        policy: {
          globalEnabled: ["web-search"],
          agentOverrides: {
            ops: {
              enabled: ["jira"],
              nope: true,
            },
          },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects unknown agent ids under skills policy overrides", () => {
    const res = OpenClawSchema.safeParse({
      agents: {
        list: [{ id: "ops" }],
      },
      skills: {
        policy: {
          agentOverrides: {
            typoedOps: {
              enabled: ["jira"],
            },
          },
        },
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }

    expect(
      res.error.issues.some(
        (issue) =>
          issue.path.join(".") === "skills.policy.agentOverrides.typoedOps" &&
          issue.message.includes("Unknown agent id"),
      ),
    ).toBe(true);
  });

  it("rejects normalized collisions under skills policy overrides", () => {
    const res = OpenClawSchema.safeParse({
      agents: {
        list: [{ id: "Ops Team" }, { id: "ops-team" }],
      },
      skills: {
        policy: {
          agentOverrides: {
            "Ops Team": {
              enabled: ["jira"],
            },
            "ops-team": {
              disabled: ["weather"],
            },
          },
        },
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }

    expect(
      res.error.issues.some(
        (issue) =>
          issue.path.join(".") === "skills.policy.agentOverrides.ops-team" &&
          issue.message.includes('Duplicate normalized agent override "ops-team"'),
      ),
    ).toBe(true);
  });

  it("accepts test-agent override keys for isolated test harnesses", () => {
    const res = OpenClawSchema.safeParse({
      skills: {
        policy: {
          agentOverrides: {
            "test-agent-smoke": {
              enabled: ["jira"],
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });
});
