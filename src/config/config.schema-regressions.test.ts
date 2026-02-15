import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("config schema regressions", () => {
  it("accepts nested telegram groupPolicy overrides", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              groupPolicy: "open",
              topics: {
                "42": {
                  groupPolicy: "disabled",
                },
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch fallback "voyage"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            fallback: "voyage",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts agent descriptions and maxChildrenPerAgent fields", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          subagents: {
            maxChildrenPerAgent: 6,
          },
        },
        list: [
          {
            id: "main",
            description: "Code reviewer",
            subagents: { maxChildrenPerAgent: 2 },
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts subagent providerLimits values", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          subagents: {
            providerLimits: {
              google: 3,
              openai: 8,
              unknown: 3,
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects invalid subagent providerLimits values", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          subagents: {
            providerLimits: {
              google: 0,
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toContain("agents.defaults.subagents.providerLimits");
    }
  });

  it("accepts subagent runTimeoutSeconds at defaults and per-agent scopes", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          subagents: {
            runTimeoutSeconds: 8,
          },
        },
        list: [
          {
            id: "main",
            subagents: {
              runTimeoutSeconds: 2,
            },
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects negative subagent runTimeoutSeconds", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          subagents: {
            runTimeoutSeconds: -1,
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toContain("agents.defaults.subagents.runTimeoutSeconds");
    }
  });

  it("rejects unknown subagent keys", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          subagents: {
            maxChildrenPerAgent: 4,
            nope: true,
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("agents.defaults.subagents");
      expect(res.issues[0]?.message).toContain("Unrecognized key");
    }
  });
});
