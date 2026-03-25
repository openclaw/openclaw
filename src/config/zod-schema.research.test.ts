import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("research schema", () => {
  it("accepts research.enabled boolean", () => {
    const result = validateConfigObject({
      research: {
        enabled: true,
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unknown research keys", () => {
    const result = validateConfigObject({
      research: {
        enabled: true,
        extra: true,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.startsWith("research"))).toBe(true);
    }
  });

  it("accepts research.learningBridge nested keys", () => {
    const result = validateConfigObject({
      research: {
        enabled: true,
        learningBridge: {
          enabled: true,
          outputDir: "~/.openclaw/rl-feed",
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts research.learningBridge.exportScrubbedContent nested key", () => {
    const result = validateConfigObject({
      research: {
        enabled: true,
        learningBridge: {
          enabled: true,
          exportScrubbedContent: true,
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unknown learningBridge keys", () => {
    const result = validateConfigObject({
      research: {
        enabled: true,
        learningBridge: {
          enabled: true,
          mystery: true,
        },
      },
    });
    expect(result.ok).toBe(false);
  });
});
