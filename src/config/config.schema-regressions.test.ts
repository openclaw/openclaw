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

  it("accepts signal groups with per-group config (#18635)", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          groupPolicy: "open",
          groups: {
            "*": {
              requireMention: false,
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts signal groups with full per-group overrides", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          groupPolicy: "allowlist",
          groups: {
            "group-abc-123": {
              requireMention: true,
              enabled: true,
              allowFrom: ["+1234567890"],
              skills: ["memory"],
              systemPrompt: "You are a helpful assistant.",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects signal groups with unknown fields", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          groups: {
            "group-1": {
              unknownField: true,
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });
});
