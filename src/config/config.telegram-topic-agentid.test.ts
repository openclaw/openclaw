import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("telegram topic agentId schema", () => {
  it("accepts valid agentId in forum group topic config", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "42": {
                  agentId: "main",
                },
              },
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      console.error(res.error.format());
      return;
    }
    expect(res.data.channels?.telegram?.groups?.["-1001234567890"]?.topics?.["42"]?.agentId).toBe(
      "main",
    );
  });

  it("accepts valid agentId in DM topic config", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          direct: {
            "123456789": {
              topics: {
                "99": {
                  agentId: "support",
                  systemPrompt: "You are support",
                },
              },
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      console.error(res.error.format());
      return;
    }
    expect(res.data.channels?.telegram?.direct?.["123456789"]?.topics?.["99"]?.agentId).toBe(
      "support",
    );
  });

  it("accepts empty config without agentId (backward compatible)", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "42": {
                  systemPrompt: "Be helpful",
                },
              },
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      console.error(res.error.format());
      return;
    }
    expect(res.data.channels?.telegram?.groups?.["-1001234567890"]?.topics?.["42"]).toEqual({
      systemPrompt: "Be helpful",
    });
  });

  it("accepts multiple topics with different agentIds", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "1": { agentId: "main" },
                "3": { agentId: "zu" },
                "5": { agentId: "q" },
              },
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      console.error(res.error.format());
      return;
    }
    const topics = res.data.channels?.telegram?.groups?.["-1001234567890"]?.topics;
    expect(topics?.["1"]?.agentId).toBe("main");
    expect(topics?.["3"]?.agentId).toBe("zu");
    expect(topics?.["5"]?.agentId).toBe("q");
  });

  it("rejects unknown fields in topic config (strict schema)", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "42": {
                  agentId: "main",
                  unknownField: "should fail",
                },
              },
            },
          },
        },
      },
    });

    expect(res.success).toBe(false);
  });
});
